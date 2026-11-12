/**
 * P1 forward-compatibility guards, end to end on real PostgreSQL (mandate_test). PayPal is a MOCK, models are SCRIPTED probes, no real LLM, no PayPal call.
 * The gate is NOT mocked in this file: the real P0 rule (V1 never reaches a model) is asserted again after the P1 changes.
 *
 *   1. the three historical mandate shapes run a full deal, unchanged, with zero model calls;
 *   2. a validly signed mandate that is a future version / has an unknown field / has duplicate keys / is ambiguous cannot authorize ANYTHING on any read path;
 *   3. locked terms that are a future version / carry an unknown field cannot authorize anything even when the stored hash was recomputed to match;
 *   4. the orchestrator halts on such documents, and keeps halting under replay and on a restarted instance.
 * "Signed" here means signed with the test application key: the attacker model is a party who can write the database and obtain a seal (the strongest case for a reader).
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuyerAgent, RuleBasedBuyerBrain } from "@/agents/buyer";
import { HttpSellerClient } from "@/agents/seller-client";
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import { beginNegotiation, checkPolicy, createDeal, lockTerms, reserveForDeal } from "@/domain/deals";
import { sealMandate, type MandateDocument } from "@/domain/mandate";
import { signMessage } from "@/domain/signing";
import type { TaskBrief } from "@/domain/negotiation";
import { checkIntegrity } from "@/orchestration/integrity";
import { Orchestrator } from "@/orchestration/service";
import { cancelAuthorization, createPayPalOrder, refreshBuyerApproval, settleDeal } from "@/settlement/engine";
import { createSettlementPort } from "@/settlement/port";
import { submitVerificationToSettlement } from "@/settlement/verification-intake";
import { LlmAiVerifier, LlmSkepticAgent } from "@/verification/ai";
import { verifyDelivery } from "@/verification/pipeline";
import { createSellerServer } from "../../seller-service/server";
import { MANDATE_FIXTURES } from "../helpers/legacyFixtures";
import { ScriptedLlm } from "../helpers/scripted";
import { MockPayPal, awaitingDelivery, csvBytes, deliver, manifestFor, prisma, sha256, DET, MIXED, HEADERS, GOOD_ROWS } from "./deliveryFixtures";
import { deps as policyDeps, makeCtx } from "./engineFixtures";
import { keys, makeMandate, makePrincipal, termsFor } from "./fixtures";

const MIN = 60_000;
const j = (v: unknown) => JSON.stringify(v);
const money = (mock: MockPayPal) => mock.writes.filter((x) => x.type === "CAPTURE" || x.type === "VOID");

/** scripted verifier + skeptic that WOULD answer "met" if called; spies and provider counters prove they are not */
function probe(art: Buffer) {
  const sha12 = sha256(art).slice(0, 12);
  const verifierLlm = new ScriptedLlm([j({ assessments: [{ criterionId: "quality", verdict: "met", rationale: "ok", evidenceRefs: [`csv:${sha12}#row:1`] }], observations: [], summary: "s" })]);
  const skepticLlm = new ScriptedLlm([j({ flags: [] })]);
  const ai = new LlmAiVerifier(verifierLlm, "scripted");
  const skeptic = new LlmSkepticAgent(skepticLlm, "scripted");
  const aiSpy = vi.spyOn(ai, "assess");
  const skepticSpy = vi.spyOn(skeptic, "assess");
  const calls = () => aiSpy.mock.calls.length + skepticSpy.mock.calls.length + verifierLlm.requests.length + skepticLlm.requests.length;
  return { ai, skeptic, calls };
}

/** a signed text the way the application would produce it: V1 seal rules, any text. (Written out here so a change to the V1 payload breaks this test.) */
async function forgeMandateRow(mandateId: string, text: string) {
  const row = await prisma.mandate.findUniqueOrThrow({ where: { id: mandateId } });
  const digest = sha256Hex(text);
  const payload = canonicalJson({ approvalMethod: row.approvalMethod, approvedAt: row.approvedAt.toISOString(), approvedBy: row.approvedBy, digest, keyVersion: row.keyVersion });
  await prisma.mandate.update({ where: { id: mandateId }, data: { canonicalJson: text, mandateDigest: digest, signature: signMessage(payload, keys.privateKeyB64) } });
}
const storedMandateText = async (id: string) => (await prisma.mandate.findUniqueOrThrow({ where: { id } })).canonicalJson;
const edit = (text: string, f: (o: Record<string, unknown>) => void) => {
  const o = JSON.parse(text) as Record<string, unknown>;
  f(o);
  return JSON.stringify(o);
};

/** unsupported / ambiguous variants of a stored mandate document, each of which a signed copy must NOT turn into authority */
const MANDATE_ATTACKS: [string, (t: string) => string][] = [
  ["future schemaVersion 2", (t) => edit(t, (o) => ((o.schemaVersion = 2), (o.languagePolicy = { supportedLanguages: ["en"] })))],
  ["explicit schemaVersion 1", (t) => edit(t, (o) => (o.schemaVersion = 1))],
  ["unknown authorization field without any version", (t) => edit(t, (o) => (o.carryOver = { amount: "999.00" }))],
  ["ambiguous shape (cancellation flag without the partial flag)", (t) => edit(t, (o) => delete o.allowPartialSettlement)],
  ["missing authorization field", (t) => edit(t, (o) => delete o.perDealMax)],
  ["invalid nested value", (t) => edit(t, (o) => (o.counterparties = [{ id: "seller-sim" }]))],
  ["duplicate key raising the budget", (t) => t.replace(/"budgetTotal":"[^"]+"/, (m) => `${m},"budgetTotal":"999999.00"`)],
  ["malformed JSON", (t) => t.slice(0, -1)],
];

// ------------------------------------------------------------------------------------------------------------------------------------ 1. legacy shapes
async function legacyMandate(principal: { id: string; email: string }, shape: (typeof MANDATE_FIXTURES)[number]["shape"]) {
  const doc: Record<string, unknown> = {
    principalId: principal.id, currency: "USD", budgetTotal: "100.00", perDealMax: "60.00", requireHumanAbove: "50.00", allowedTaskTypes: ["data_cleaning"],
    counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z",
  };
  if (shape !== "V1_BASE") doc.allowPartialSettlement = false;
  if (shape === "V1_FULL") doc.allowPreDeliveryCancellation = true;
  const sealed = sealMandate(doc as unknown as MandateDocument, { approvedBy: principal.email, approvedAt: new Date().toISOString(), approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" }, keys);
  return prisma.mandate.create({
    data: {
      principalId: principal.id, currency: "USD", budgetTotal: "100.00", perDealMax: "60.00", requireHumanAbove: "50.00", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"), canonicalJson: sealed.canonicalJson, mandateDigest: sealed.mandateDigest, approvedBy: sealed.approvedBy, approvedAt: new Date(sealed.approvedAt),
      approvalMethod: sealed.approvalMethod, keyVersion: sealed.keyVersion, signature: sealed.signature,
    },
  });
}

async function authorizedOn(mandateId: string, principalId: string, mock: MockPayPal, criteria = termsFor(mandateId).criteria) {
  const ctx = makeCtx(mock);
  const deal = await createDeal(prisma, { principalId, mandateId, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  await beginNegotiation(prisma, deal.id, "buyer-agent", principalId);
  await lockTerms(prisma, { dealId: deal.id, terms: termsFor(mandateId, { criteria }), actor: "buyer-agent", principalId });
  expect((await checkPolicy(prisma, { dealId: deal.id, deps: policyDeps })).outcome).toBe("OK");
  expect(await reserveForDeal(prisma, { dealId: deal.id, deps: policyDeps })).toMatchObject({ ok: true });
  expect(await createPayPalOrder(ctx, deal.id)).toMatchObject({ status: "DONE" });
  mock.buyerApprove((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).paypalOrderId!);
  expect(await refreshBuyerApproval(ctx, deal.id)).toMatchObject({ status: "DONE" });
  return { ctx, dealId: deal.id };
}
const idOnlyCsv = () => csvBytes(["id"], [["1"], ["2"], ["3"]]);

describe("1. the three historical V1 mandate shapes run complete deals, unchanged, with zero model calls (P0 preserved after P1)", () => {
  for (const f of MANDATE_FIXTURES) {
    it(`${f.shape}: negotiation-locked deal -> delivery -> verification -> capture of the locked price; the stored mandate row is not touched`, async () => {
      const principal = await makePrincipal();
      const m = await legacyMandate(principal, f.shape);
      const before = await prisma.mandate.findUniqueOrThrow({ where: { id: m.id } });
      const mock = new MockPayPal();
      const { ctx, dealId } = await authorizedOn(m.id, principal.id, mock);
      expect(await checkIntegrity(prisma, dealId, keys.publicKeyB64)).toEqual({ ok: true });
      const art = idOnlyCsv();
      const p = probe(art);
      expect(await deliver(dealId, art, { manifest: { metadata: { note: `CANARY-${randomUUID()}` } } })).toMatchObject({ ok: true });
      const v = await verifyDelivery({ db: prisma, ai: p.ai, skeptic: p.skeptic }, { dealId });
      expect(v.result.overall).toBe("ALL_REQUIRED_PASSED");
      expect(v.result.provenance.isolation).toMatchObject({ modelCallsPermitted: false, reason: "NO_LLM_CRITERIA", modelCallsMade: 0 });
      expect(await submitVerificationToSettlement(ctx, { dealId, verificationId: v.result.verificationId })).toMatchObject({ status: "DONE" });
      expect(await settleDeal(ctx, dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
      expect(money(mock)).toHaveLength(1);
      expect(money(mock)[0]).toMatchObject({ type: "CAPTURE", body: { amount: { value: "20.00" } } });
      expect(p.calls()).toBe(0);
      const after = await prisma.mandate.findUniqueOrThrow({ where: { id: m.id } });
      expect(after).toEqual(before); // not rewritten, not re-signed
    });

    it(`${f.shape}: pre-delivery cancellation follows the SIGNED flag - an absent flag is "not granted"`, async () => {
      const principal = await makePrincipal();
      const m = await legacyMandate(principal, f.shape);
      const mock = new MockPayPal();
      const { ctx, dealId } = await authorizedOn(m.id, principal.id, mock);
      const r = await cancelAuthorization(ctx, { dealId, reason: "HUMAN_CANCEL", actor: "human", principalId: principal.id });
      if (f.shape === "V1_FULL") expect(r).toMatchObject({ state: "VOIDED" });
      else expect(r).toMatchObject({ status: "REFUSED", reason: "CANCELLATION_NOT_PERMITTED_BY_MANDATE" });
    });

    it(`${f.shape}: an LLM-judged criterion stays blocked from AI verification (zero model calls, UNVERIFIABLE, human review)`, async () => {
      const principal = await makePrincipal();
      const m = await legacyMandate(principal, f.shape);
      const mock = new MockPayPal();
      const llm = [...termsFor(m.id).criteria.map((c) => ({ ...c, weight: 50 })).slice(0, 1), { id: "quality", text: "plausible", type: "llm_judged" as const, required: true, weight: 50 }];
      const { ctx, dealId } = await authorizedOn(m.id, principal.id, mock, llm);
      const art = idOnlyCsv();
      const p = probe(art);
      await deliver(dealId, art);
      const v = await verifyDelivery({ db: prisma, ai: p.ai, skeptic: p.skeptic }, { dealId });
      expect(v.result.criteriaResults.find((c) => c.criterionId === "quality")).toMatchObject({ status: "UNVERIFIABLE", reason: "LEGACY_TERMS_NO_INPUT_BOUNDARY" });
      await submitVerificationToSettlement(ctx, { dealId, verificationId: v.result.verificationId });
      expect(await settleDeal(ctx, dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
      expect(money(mock)).toHaveLength(0);
      expect(p.calls()).toBe(0);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------------ 2. swapped mandate
describe("2. a validly signed but unsupported / ambiguous mandate cannot authorize anything on any read path", () => {
  for (const [name, attack] of MANDATE_ATTACKS) {
    it(`${name}`, async () => {
      // a deal that is fully verified and waiting to settle, then the mandate row is replaced by the (validly signed) attack document
      const w = await awaitingDelivery({ criteria: DET });
      const art = csvBytes(HEADERS, GOOD_ROWS);
      await deliver(w.base.dealId, art);
      const v = await verifyDelivery({ db: prisma }, { dealId: w.base.dealId });
      expect(await submitVerificationToSettlement(w.ctx, { dealId: w.base.dealId, verificationId: v.result.verificationId })).toMatchObject({ status: "DONE" });
      const original = await storedMandateText(w.base.m.id);
      await forgeMandateRow(w.base.m.id, attack(original));
      const writesBefore = w.mock.writes.length;

      expect(await checkIntegrity(prisma, w.base.dealId, keys.publicKeyB64)).toEqual({ ok: false, reason: "MANDATE_SEAL_INVALID" });
      expect(await settleDeal(w.ctx, w.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: expect.stringContaining("MANDATE_SEAL_INVALID") });
      expect(await cancelAuthorization(w.ctx, { dealId: w.base.dealId, reason: "HUMAN_CANCEL", actor: "human", principalId: w.base.p.id })).toMatchObject({ status: "REFUSED", reason: "CANCELLATION_NOT_PERMITTED_BY_MANDATE" });
      expect(w.mock.writes.length).toBe(writesBefore); // no capture, no void, nothing sent to PayPal
      expect((await prisma.deal.findUniqueOrThrow({ where: { id: w.base.dealId } })).state).not.toBe("CAPTURED");
      // a new deal cannot even be created under it
      await expect(createDeal(prisma, { principalId: w.base.p.id, mandateId: w.base.m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 })).rejects.toThrow(/seal does not verify/);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------------ 3. swapped terms
type Terms = Record<string, unknown>;
const TERMS_ATTACKS: [string, (t: Terms) => Terms, string[]][] = [
  ["future schemaVersion 3 on the terms", (t) => ({ ...t, schemaVersion: 3 }), ["TERMS_VERSION_UNSUPPORTED"]],
  ["schemaVersion on a criterion", (t) => ({ ...t, criteria: (t.criteria as Terms[]).map((c, i) => (i === 0 ? { ...c, schemaVersion: 2 } : c)) }), ["TERMS_VERSION_UNSUPPORTED"]],
  ["unknown top-level authorization field (languagePolicy)", (t) => ({ ...t, languagePolicy: { supportedLanguages: ["en"] } }), ["TERMS_INVALID"]],
  ["unknown criterion field (inputFields)", (t) => ({ ...t, criteria: (t.criteria as Terms[]).map((c, i) => (i === 0 ? { ...c, inputFields: ["col:a"] } : c)) }), ["TERMS_INVALID"]],
  ["unknown criterion type", (t) => ({ ...t, criteria: (t.criteria as Terms[]).map((c, i) => (i === 0 ? { ...c, type: "oracle" } : c)) }), ["TERMS_INVALID"]],
  ["a required field removed", (t) => ({ ...t, sellerId: undefined }), ["TERMS_INVALID"]],
];
/** the attacker keeps the two columns consistent: new termsJson AND a termsHash recomputed over it (what a database writer would do) */
async function swapTerms(dealId: string, f: (t: Terms) => Terms) {
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  const next = JSON.parse(JSON.stringify(f(deal.termsJson as Terms))) as Terms;
  await prisma.deal.update({ where: { id: dealId }, data: { termsJson: next as never, termsHash: sha256Hex(canonicalJson(next)) } });
}

describe("3. unsupported / unknown-field terms cannot authorize anything, even with a column-consistent recomputed hash", () => {
  for (const [name, attack, reasons] of TERMS_ATTACKS) {
    it(`${name}: delivery intake, verification, intake, settlement, integrity and re-verification all refuse`, async () => {
      const w = await awaitingDelivery({ criteria: DET });
      const id = w.base.dealId;
      const art = csvBytes(HEADERS, GOOD_ROWS);
      await deliver(id, art);
      const v = await verifyDelivery({ db: prisma }, { dealId: id }); // a genuine, earlier verification
      expect(await submitVerificationToSettlement(w.ctx, { dealId: id, verificationId: v.result.verificationId })).toMatchObject({ status: "DONE" });
      await swapTerms(id, attack);
      const writesBefore = w.mock.writes.length;

      expect(await checkIntegrity(prisma, id, keys.publicKeyB64)).toEqual({ ok: false, reason: "TERMS_CHANGED_AFTER_LOCK" });
      expect(await settleDeal(w.ctx, id)).toMatchObject({ status: "NEEDS_HUMAN", reason: expect.stringContaining("TERMS_DRIFT") });
      await expect(verifyDelivery({ db: prisma }, { dealId: id, sequence: 2, inputEvidenceRefs: ["ledger:1"] })).rejects.toMatchObject({ code: "TERMS_DRIFT" });
      expect(w.mock.writes.length).toBe(writesBefore);
      expect((await prisma.deal.findUniqueOrThrow({ where: { id } })).state).not.toBe("CAPTURED");
      void reasons;
    });

    it(`${name}: a new delivery is refused (TERMS_NOT_LOCKED)`, async () => {
      const w = await awaitingDelivery({ criteria: DET });
      const id = w.base.dealId;
      await swapTerms(id, attack);
      const art = csvBytes(HEADERS, GOOD_ROWS);
      expect(await deliver(id, art)).toMatchObject({ ok: false, code: "TERMS_NOT_LOCKED" });
    });

    it(`${name}: policy evaluation refuses before a budget reservation is made`, async () => {
      const principal = await makePrincipal();
      const m = await makeMandate(principal);
      const deal = await createDeal(prisma, { principalId: principal.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
      await beginNegotiation(prisma, deal.id, "buyer-agent", principal.id);
      await lockTerms(prisma, { dealId: deal.id, terms: termsFor(m.id), actor: "buyer-agent", principalId: principal.id });
      expect((await checkPolicy(prisma, { dealId: deal.id, deps: policyDeps })).outcome).toBe("OK");
      await swapTerms(deal.id, attack);
      const r = await reserveForDeal(prisma, { dealId: deal.id, deps: policyDeps });
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.reasons.some((x) => x === "TERMS_VERSION_UNSUPPORTED" || x === "TERMS_INVALID")).toBe(true);
      expect(await prisma.budgetReservation.count({ where: { dealId: deal.id } })).toBe(0);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------------ 4. orchestration
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
async function sellerClient() {
  const server = createSellerServer({ mode: "honest", floor: "22.00" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return new HttpSellerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
async function orchWorld(p: ReturnType<typeof probe>) {
  const mock = new MockPayPal();
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const ctx = makeCtx(mock, { now, config: { challengeWindowMs: 0, reviewTimeoutMs: 72 * 60 * MIN } });
  const port = createSettlementPort(ctx);
  const seller = await sellerClient();
  const mk = () => new Orchestrator({ db: prisma, port, policy: policyDeps, now, leaseMs: 60_000, verify: { ai: p.ai, skeptic: p.skeptic, passes: 2, claimWaitMs: 300 }, negotiation: { buyer: new BuyerAgent(new RuleBasedBuyerBrain()), seller, maxRounds: 4 } });
  return { mock, clock, orch: mk(), restarted: mk };
}
async function orchJourney(w: Awaited<ReturnType<typeof orchWorld>>) {
  const pr = await makePrincipal();
  const m = await makeMandate(pr);
  const brief: TaskBrief = { description: "Clean the customer CSV", criteria: DET as never, deadline: new Date(w.clock.t + 24 * 700 * 3600_000).toISOString(), targetPrice: "20.00" };
  const opened = await w.orch.openDeal({ principalId: pr.id, mandateId: m.id, sellerId: "seller-sim", brief });
  expect(opened.negotiation).toMatchObject({ outcome: "LOCKED" });
  w.mock.buyerApprove((await prisma.deal.findUniqueOrThrow({ where: { id: opened.dealId } })).paypalOrderId!);
  expect(await w.orch.advance(opened.dealId)).toMatchObject({ state: "AWAITING_DELIVERY" });
  return { dealId: opened.dealId, mandateId: m.id };
}
const receive = async (w: Awaited<ReturnType<typeof orchWorld>>, dealId: string, art: Buffer) => {
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  return w.orch.receiveDelivery({ dealId, authenticatedSellerId: "seller-sim", manifest: manifestFor(deal, art), artifact: art });
};

describe("4. orchestration: unsupported authorization documents HALT the deal; replay and a restarted instance keep it halted; no model is ever called", () => {
  it("a validly signed future-version mandate: advance, delivery, replays and a restarted orchestrator all halt with no money and no model call", async () => {
    const art = csvBytes(HEADERS, GOOD_ROWS);
    const p = probe(art);
    const w = await orchWorld(p);
    const t = await orchJourney(w);
    await forgeMandateRow(t.mandateId, edit(await storedMandateText(t.mandateId), (o) => ((o.schemaVersion = 2), (o.languagePolicy = {}))));
    const writes = w.mock.writes.length;
    expect(await w.orch.advance(t.dealId)).toMatchObject({ status: "HALTED", reason: "MANDATE_SEAL_INVALID" });
    expect((await receive(w, t.dealId, art)).delivery).toMatchObject({ status: "HALTED", reason: "MANDATE_SEAL_INVALID" });
    for (let i = 0; i < 3; i++) expect(await w.orch.advance(t.dealId)).toMatchObject({ status: "HALTED", reason: "MANDATE_SEAL_INVALID" });
    expect(await w.restarted().advance(t.dealId)).toMatchObject({ status: "HALTED", reason: "MANDATE_SEAL_INVALID" });
    expect(await w.restarted().sweep(10, [t.dealId])).toBeDefined();
    expect(w.mock.writes.length).toBe(writes);
    expect(await prisma.verificationRun.count({ where: { dealId: t.dealId } })).toBe(0);
    expect(p.calls()).toBe(0);
    expect(await prisma.dealEvent.count({ where: { dealId: t.dealId, type: "ORCHESTRATION_HALTED" } })).toBeLessThanOrEqual(1);
  });

  it("future-version terms with a recomputed hash: the deal halts (ledger lock mismatch), replay and restart stay halted, nothing is verified or paid", async () => {
    const art = csvBytes(HEADERS, GOOD_ROWS);
    const p = probe(art);
    const w = await orchWorld(p);
    const t = await orchJourney(w);
    await swapTerms(t.dealId, (x) => ({ ...x, schemaVersion: 3 }));
    const writes = w.mock.writes.length;
    expect(await w.orch.advance(t.dealId)).toMatchObject({ status: "HALTED", reason: "TERMS_CHANGED_AFTER_LOCK" });
    expect((await receive(w, t.dealId, art)).delivery).toMatchObject({ status: "HALTED", reason: "TERMS_CHANGED_AFTER_LOCK" });
    for (let i = 0; i < 2; i++) expect(await w.restarted().advance(t.dealId)).toMatchObject({ status: "HALTED", reason: "TERMS_CHANGED_AFTER_LOCK" });
    expect(w.mock.writes.length).toBe(writes);
    expect(await prisma.verificationRun.count({ where: { dealId: t.dealId } })).toBe(0);
    expect(p.calls()).toBe(0);
  });

  it("legacy-shaped mandate (no flags) through the orchestrator: completes, one capture, zero model calls, replay adds nothing", async () => {
    const art = csvBytes(HEADERS, GOOD_ROWS);
    const p = probe(art);
    const w = await orchWorld(p);
    const principal = await makePrincipal();
    const m = await legacyMandate(principal, "V1_BASE");
    const brief: TaskBrief = { description: "Clean the customer CSV", criteria: DET as never, deadline: new Date(w.clock.t + 24 * 700 * 3600_000).toISOString(), targetPrice: "20.00" };
    const opened = await w.orch.openDeal({ principalId: principal.id, mandateId: m.id, sellerId: "seller-sim", brief });
    expect(opened.negotiation).toMatchObject({ outcome: "LOCKED" });
    w.mock.buyerApprove((await prisma.deal.findUniqueOrThrow({ where: { id: opened.dealId } })).paypalOrderId!);
    await w.orch.advance(opened.dealId);
    expect((await receive(w, opened.dealId, art)).advance).toMatchObject({ state: "CAPTURED", status: "DONE" });
    for (let i = 0; i < 2; i++) {
      await receive(w, opened.dealId, art);
      await w.restarted().advance(opened.dealId);
    }
    expect(money(w.mock)).toHaveLength(1);
    expect(p.calls()).toBe(0);
  });
});

describe("5. P0 after P1: V1 LLM-judged terms under a supported mandate are still blocked and never reach a model", () => {
  it("MIXED criteria on a fresh deal: UNVERIFIABLE, NEEDS_HUMAN, zero model calls", async () => {
    const w = await awaitingDelivery({ criteria: MIXED });
    const art = csvBytes(HEADERS, GOOD_ROWS);
    const p = probe(art);
    await deliver(w.base.dealId, art);
    const v = await verifyDelivery({ db: prisma, ai: p.ai, skeptic: p.skeptic }, { dealId: w.base.dealId });
    expect(v.result.overall).toBe("REQUIRED_UNVERIFIABLE");
    await submitVerificationToSettlement(w.ctx, { dealId: w.base.dealId, verificationId: v.result.verificationId });
    expect(await settleDeal(w.ctx, w.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(p.calls()).toBe(0);
  });
});
