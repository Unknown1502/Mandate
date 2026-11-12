/**
 * V2 negotiation, the release gate at the database boundary, the terms history and the detector-pin mirrors. Real PostgreSQL (mandate_test); the seller is the real
 * simulated-seller HTTP service (rule-based); the buyer is rule-based or a SCRIPTED model. No real LLM, no PayPal.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BuyerAgent, LlmBuyerBrain, RuleBasedBuyerBrain, type BuyerBrain } from "@/agents/buyer";
import type { NegotiateRequest } from "@/agents/contracts";
import { HttpSellerClient, type SellerClient } from "@/agents/seller-client";
import { checkPolicy, createDeal } from "@/domain/deals";
import { verifyChain } from "@/domain/ledger";
import { openMandateRow } from "@/domain/mandates";
import { V2DisabledError, approveMandateV2, previewMandateV2 } from "@/domain/mandate-v2-writer";
import { detectTermsDrift, runNegotiation, type TaskBrief } from "@/domain/negotiation";
import { createSellerServer } from "../../seller-service/server";
import { ScriptedLlm } from "../helpers/scripted";
import { testReleaseRecord } from "../helpers/v2Gate";
import { evaluateV2Gate } from "@/domain/v2-release-gate";
import { llmTermsV2, mandateDraftV2 } from "../helpers/v2Fixtures";
import type { TermsV2 } from "@/domain/terms-v2";
import { keys, makePrincipal, makeV2Mandate, prisma, registry, v2Deps, v2Gate } from "./v2Fixtures";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
async function seller() {
  const server = createSellerServer({ mode: "honest", floor: "22.00" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const client = new HttpSellerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const requests: NegotiateRequest[] = [];
  const recording: SellerClient = { negotiate: async (req) => (requests.push(req), client.negotiate(req)) };
  return { client: recording, requests };
}

/** the principal-authored V2 template: AI-judged criterion with its approved view, artifact schema and language policy */
const template = (mid: string): NonNullable<TaskBrief["v2"]> => {
  const t = llmTermsV2(mid);
  return { criteria: t.criteria, artifactSchema: t.artifactSchema, languagePolicy: t.languagePolicy };
};
const plain = (c: TermsV2["criteria"][number]) => (c.type === "deterministic" ? { id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight, validator: c.validator, params: c.params } : { id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight });
const brief = (mid: string, over: Partial<TaskBrief> = {}): TaskBrief => {
  const v2 = template(mid);
  return { description: "Clean the customer export", criteria: v2.criteria.map(plain), deadline: "2029-01-01T00:00:00.000Z", targetPrice: "20.00", v2, ...over };
};
async function setup() {
  const p = await makePrincipal();
  const m = await makeV2Mandate(p);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
  return { p, m, dealId: deal.id };
}
const run = (s: Awaited<ReturnType<typeof setup>>, brain: BuyerBrain, client: SellerClient, b: TaskBrief, policy = v2Deps) =>
  runNegotiation({ db: prisma, buyer: new BuyerAgent(brain), seller: client, policy, maxRounds: 4 }, { dealId: s.dealId, principalId: s.p.id, brief: b });
const row = (id: string) => prisma.deal.findUniqueOrThrow({ where: { id } });

describe("V2 negotiation: the agents negotiate the PRICE only", () => {
  it("honest negotiation locks V2 terms (hash, version, policy hash, history row) and the deal then needs the human attestation", async () => {
    const s = await setup();
    const { client } = await seller();
    const r = await run(s, new RuleBasedBuyerBrain(), client, brief(s.m.id));
    expect(r).toMatchObject({ outcome: "LOCKED", price: "22.80" });
    const d = await row(s.dealId);
    expect(d).toMatchObject({ state: "TERMS_LOCKED", termsSchemaVersion: 2 });
    expect(d.languagePolicyHash).toMatch(/^[0-9a-f]{64}$/);
    const t = d.termsJson as { schemaVersion: number; criteria: { id: string; inputFields?: string[] }[]; artifactSchema: { fields: unknown[] } };
    expect(t.schemaVersion).toBe(2);
    expect(t.criteria.find((c) => c.id === "coherent")!.inputFields).toEqual(["col:delivery_notes", "col:description"]); // the principal's mapping, untouched
    const hist = await prisma.termsVersion.findMany({ where: { dealId: s.dealId } });
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ version: 1, termsSchemaVersion: 2, termsHash: d.termsHash, lockedBy: "orchestrator" });
    expect(await checkPolicy(prisma, { dealId: s.dealId, deps: v2Deps })).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["LLM_MAPPING_APPROVAL_REQUIRED"] });
    expect(await prisma.payPalOperation.count({ where: { dealId: s.dealId } })).toBe(0);
    expect((await verifyChain(prisma, s.dealId)).ok).toBe(true);
  });
  it("the seller never receives the field mapping, classification, artifact schema or language policy (docs/15 Q7 option A)", async () => {
    const s = await setup();
    const { client, requests } = await seller();
    await run(s, new RuleBasedBuyerBrain(), client, brief(s.m.id));
    const wire = JSON.stringify(requests);
    expect(requests.length).toBeGreaterThan(0);
    for (const needle of ["inputFields", "inputMaxRows", "col:", "OPAQUE", "CRITERION_INPUT", "artifactSchema", "languagePolicy", "supportedLanguages", "vocabularyHash", "csv:header", "schemaVersion"]) expect(wire, needle).not.toContain(needle);
    expect(wire).toContain("Descriptions are coherent with the delivery notes"); // criteria TEXT is the task description the seller needs
  });
  it("the buyer's model prompt contains criteria text but no mapping, classification, policy, budget or mandate data", async () => {
    const s = await setup();
    const { client } = await seller();
    const llm = new ScriptedLlm(['{"kind":"propose","price":"20.00","message":"offer"}', '{"kind":"counter","price":"22.80"}']);
    await run(s, new LlmBuyerBrain(llm, "scripted"), client, brief(s.m.id));
    const prompts = llm.requests.map((q) => `${q.system}\n${q.user}`).join("\n");
    expect(llm.requests.length).toBeGreaterThan(0);
    for (const needle of ["inputFields", "col:", "OPAQUE", "artifactSchema", "languagePolicy", "vocabularyHash", "100.00", "60.00", "perDealMax", "budgetTotal", s.m.id]) expect(prompts, needle).not.toContain(needle);
  });
  it("the brief version must match the mandate version, in both directions", async () => {
    const s = await setup();
    const { client } = await seller();
    const v1Brief: TaskBrief = { description: "d", criteria: [{ id: "schema", text: "Columns match", type: "deterministic", required: true, weight: 100, validator: "csv_schema_matches", params: { columns: ["id"] } }], deadline: "2029-01-01T00:00:00.000Z", targetPrice: "20.00" };
    expect(await run(s, new RuleBasedBuyerBrain(), client, v1Brief)).toMatchObject({ outcome: "BLOCKED", reason: "BRIEF_VERSION_MISMATCH" });
  });
  it("invalid V2 briefs are refused before any message is exchanged (classification damage, group cap)", async () => {
    const s = await setup();
    const { client, requests } = await seller();
    const b = brief(s.m.id);
    (b.v2!.criteria[1] as { inputFields: string[] }).inputFields = ["col:email"]; // an OPAQUE field
    expect(await run(s, new RuleBasedBuyerBrain(), client, b)).toMatchObject({ outcome: "BLOCKED" });
    expect(requests).toHaveLength(0);
    const t = await row(s.dealId);
    expect(t.state).toBe("BLOCKED");
  });
  it("with the release gate closed, a V2 mandate cannot be negotiated at all (fail closed)", async () => {
    const s = await setup();
    const { client, requests } = await seller();
    expect(await run(s, new RuleBasedBuyerBrain(), client, brief(s.m.id), { ...v2Deps, v2Gate: undefined })).toMatchObject({ outcome: "BLOCKED", reason: "MANDATE_SEAL_INVALID" });
    expect(requests).toHaveLength(0);
  });
  it("after the lock, a seller restatement that changes the price or the criteria is drift (V2 terms are read by the same drift detector)", async () => {
    const s = await setup();
    const { client } = await seller();
    await run(s, new RuleBasedBuyerBrain(), client, brief(s.m.id));
    const drift = await detectTermsDrift(prisma, { dealId: s.dealId, restatement: { price: "1.00" } });
    expect(drift).toMatchObject({ drift: true, fields: ["price"] });
    expect(await detectTermsDrift(prisma, { dealId: (await setup()).dealId, restatement: { price: "1.00" } })).toMatchObject({ drift: false });
  });
});

describe("the V2 release gate at the database boundary", () => {
  it("without an open gate a V2 mandate neither opens nor can be written; an expired gate is no gate", async () => {
    const p = await makePrincipal();
    const m = await makeV2Mandate(p);
    expect(openMandateRow(m, { publicKeyB64: keys.publicKeyB64, registry, v2Gate })).toMatchObject({ version: 2 });
    expect(openMandateRow(m, { publicKeyB64: keys.publicKeyB64, registry })).toBeNull();
    const pv = previewMandateV2(p.id, mandateDraftV2());
    await expect(approveMandateV2(prisma, { principalId: p.id, principalEmail: p.email, draft: pv.draft, confirmDigest: pv.digest, keys, registry })).rejects.toBeInstanceOf(V2DisabledError);
    expect(await prisma.mandate.count({ where: { id: pv.document.mandateId } })).toBe(0);
    const future = new Date(Date.now() + 40 * 86_400_000);
    await expect(approveMandateV2(prisma, { principalId: p.id, principalEmail: p.email, draft: { ...pv.draft, expiresAt: "2035-01-01T00:00:00.000Z" }, confirmDigest: previewMandateV2(p.id, { ...pv.draft, expiresAt: "2035-01-01T00:00:00.000Z" }).digest, keys, registry, v2Gate, now: future })).rejects.toBeInstanceOf(V2DisabledError);
  });
  it("a gate decision built for another registry or another source tree never reaches the database layer", () => {
    const rec = testReleaseRecord(keys);
    const d = evaluateV2Gate({ optedIn: true, record: rec, registry, now: new Date(), runtimeSourceDigest: "9".repeat(64) });
    expect(d.open).toBe(false);
  });
  it("V1 mandates and deals are unaffected by the gate (no gate needed)", async () => {
    const { makeMandate } = await import("./fixtures");
    const p = await makePrincipal();
    const m = await makeMandate(p, {});
    expect(openMandateRow(m, { publicKeyB64: keys.publicKeyB64 })).toMatchObject({ version: 1 });
  });
});

describe("detector-pin mirrors and the terms history", () => {
  it("the mirrored detector columns equal the signed pin; any difference makes the mandate unreadable", async () => {
    const p = await makePrincipal();
    const m = await makeV2Mandate(p);
    expect(m).toMatchObject({ detectorId: expect.any(String), detectorVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), detectorVocabularyHash: expect.stringMatching(/^sha256:/) });
    const ctx = { publicKeyB64: keys.publicKeyB64, registry, v2Gate };
    expect(openMandateRow({ ...m, detectorVersion: "9.9.9" }, ctx)).toBeNull();
    expect(openMandateRow({ ...m, detectorId: "other" }, ctx)).toBeNull();
    expect(openMandateRow({ ...m, detectorVocabularyHash: `sha256:${"0".repeat(64)}` }, ctx)).toBeNull();
    expect(openMandateRow({ ...m, detectorId: null }, ctx)).toBeNull();
  });
  it("a terms history row is immutable, keyed (deal, version) and checked", async () => {
    const s = await setup();
    const { client } = await seller();
    await run(s, new RuleBasedBuyerBrain(), client, brief(s.m.id));
    await expect(prisma.$executeRaw`UPDATE "TermsVersion" SET "termsHash" = ${"0".repeat(64)} WHERE "dealId" = ${s.dealId}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`DELETE FROM "TermsVersion" WHERE "dealId" = ${s.dealId}`).rejects.toThrow(/immutable/);
    const one = await prisma.termsVersion.findFirstOrThrow({ where: { dealId: s.dealId } });
    await expect(prisma.termsVersion.create({ data: { dealId: s.dealId, version: 1, termsSchemaVersion: 2, termsHash: one.termsHash, termsJson: {}, lockedBy: "x" } })).rejects.toThrow();
    await expect(prisma.termsVersion.create({ data: { dealId: s.dealId, version: 0, termsSchemaVersion: 2, termsHash: one.termsHash, termsJson: {}, lockedBy: "x" } })).rejects.toThrow();
    await expect(prisma.termsVersion.create({ data: { dealId: s.dealId, version: 2, termsSchemaVersion: 3, termsHash: one.termsHash, termsJson: {}, lockedBy: "x" } })).rejects.toThrow();
  });
});
