/**
 * P3 on real PostgreSQL (mandate_test): V2 mandates, V2 terms, the two-step human approval and the TermsAttestation. MOCK PayPal. No model.
 */
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { approveDealWithAttestation, ApprovalError, previewDealApproval } from "@/domain/deal-approval";
import { authorizeDeal } from "@/domain/authorization";
import { beginNegotiation, checkPolicy, createDeal, lockTerms, reserveForDeal, resolvePreAuthReview } from "@/domain/deals";
import { appendEvent, verifyChain } from "@/domain/ledger";
import { openMandateRow } from "@/domain/mandates";
import { ConfirmationMismatchV2Error, DuplicateMandateError, approveMandateV2, previewMandateV2 } from "@/domain/mandate-v2-writer";
import { approveMandate, previewMandate } from "@/domain/mandates";
import { createPayPalOrder } from "@/settlement/engine";
import { MockPayPal } from "../helpers/mockPayPal";
import { deepClone, floorPolicy, mandateDraftV2, llmTermsV2, detTermsV2 } from "../helpers/v2Fixtures";
import { detTerms, keys, llmTerms, makePrincipal, makeV2Ctx, makeV2Mandate, prisma, registry, v2Gate, v2Approved, v2Authorized, v2Deps, v2PendingApproval } from "./v2Fixtures";

const principalOf = async () => makePrincipal();

describe("V2 mandate persistence", () => {
  it("a V2 mandate is stored with its signed identity, verifies through the registry, and mirrors the signed values in query columns", async () => {
    const p = await principalOf();
    const m = await makeV2Mandate(p);
    expect(m).toMatchObject({ sealVersion: 2, schemaVersion: 2 });
    expect(m.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(m.mandateNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(m.languagePolicyHash).toMatch(/^[0-9a-f]{64}$/);
    const opened = openMandateRow(m, { publicKeyB64: keys.publicKeyB64, registry, v2Gate });
    expect(opened).toMatchObject({ version: 2 });
    if (opened?.version === 2) expect(opened.doc).toMatchObject({ mandateId: m.id, nonce: m.mandateNonce, principalId: p.id, carryOver: null });
  });
  it("without a registry no V2 mandate verifies (fail closed)", async () => {
    const m = await makeV2Mandate(await principalOf());
    expect(openMandateRow(m, { publicKeyB64: keys.publicKeyB64 })).toBeNull();
  });
  it("the same previewed draft cannot be approved twice (identity and nonce are unique)", async () => {
    const p = await principalOf();
    const pv = previewMandateV2(p.id, mandateDraftV2());
    const args = { principalId: p.id, principalEmail: p.email, draft: pv.draft, confirmDigest: pv.digest, keys, registry, v2Gate };
    await approveMandateV2(prisma, args);
    await expect(approveMandateV2(prisma, args)).rejects.toBeInstanceOf(DuplicateMandateError);
  });
  it("a wrong confirmation digest stores nothing", async () => {
    const p = await principalOf();
    const pv = previewMandateV2(p.id, mandateDraftV2());
    await expect(approveMandateV2(prisma, { principalId: p.id, principalEmail: p.email, draft: pv.draft, confirmDigest: "0".repeat(64), keys, registry, v2Gate })).rejects.toBeInstanceOf(ConfirmationMismatchV2Error);
    expect(await prisma.mandate.count({ where: { id: pv.document.mandateId } })).toBe(0);
  });
  it("tampering with the stored bytes, the digest, the signature, the nonce column or the version hint fails closed", async () => {
    const m = await makeV2Mandate(await principalOf());
    const ctx = { publicKeyB64: keys.publicKeyB64, registry, v2Gate };
    const doc = JSON.parse(m.canonicalJson) as Record<string, unknown>;
    const variants: Array<Partial<typeof m>> = [
      { canonicalJson: JSON.stringify({ ...doc, budgetTotal: "999.00" }) },
      { canonicalJson: m.canonicalJson.replace("100.00", "100.01") },
      { mandateDigest: "0".repeat(64) },
      { signature: m.signature.slice(0, 10) + (m.signature[10] === "A" ? "B" : "A") + m.signature.slice(11) },
      { mandateNonce: "f".repeat(32) },
      { sealVersion: 1 },
      { approvedBy: "evil@example.test" },
      { keyVersion: "other" },
    ];
    for (const v of variants) expect(openMandateRow({ ...m, ...v }, ctx), JSON.stringify(Object.keys(v))).toBeNull();
    expect(openMandateRow({ ...m, principalId: "someone-else" }, ctx)).toBeNull();
    expect(openMandateRow({ ...m, id: "c" + "a".repeat(24) }, ctx)).toBeNull();
  });
  it("database CHECK: a V2 row with a malformed nonce or a non-V2 id cannot be inserted; a V1 row cannot carry a nonce", async () => {
    const p = await principalOf();
    const m = await makeV2Mandate(p);
    const base = { principalId: p.id, currency: "USD", budgetTotal: "1.00", perDealMax: "1.00", allowedTaskTypes: ["data_cleaning"], counterparties: ["s"], expiresAt: new Date("2030-01-01"), canonicalJson: m.canonicalJson, mandateDigest: m.mandateDigest, approvedBy: "x", approvedAt: new Date(), approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION", keyVersion: keys.keyVersion, signature: m.signature };
    await expect(prisma.mandate.create({ data: { ...base, id: "c" + "b".repeat(24), sealVersion: 2, schemaVersion: 2, mandateNonce: "xyz" } })).rejects.toThrow();
    await expect(prisma.mandate.create({ data: { ...base, id: "not-a-v2-id", sealVersion: 2, schemaVersion: 2, mandateNonce: "e".repeat(32) } })).rejects.toThrow();
    await expect(prisma.mandate.create({ data: { ...base, sealVersion: 1, mandateNonce: "e".repeat(32) } })).rejects.toThrow();
    await expect(prisma.mandate.create({ data: { ...base, id: "c" + "c".repeat(24), sealVersion: 2, schemaVersion: 2, mandateNonce: m.mandateNonce! } })).rejects.toThrow(); // nonce unique
  });
  it("V1 compatibility: a V1 mandate still seals and opens, keeps sealVersion 1 and no nonce, and identical V1 drafts remain storable (no new uniqueness on V1)", async () => {
    const p = await principalOf();
    const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
    const { digest } = previewMandate(p.id, draft);
    const a = await approveMandate(prisma, { principalId: p.id, principalEmail: p.email, draft, confirmDigest: digest, keys });
    const b = await approveMandate(prisma, { principalId: p.id, principalEmail: p.email, draft, confirmDigest: digest, keys });
    expect([a.sealVersion, a.schemaVersion, a.mandateNonce, a.languagePolicyHash]).toEqual([1, 1, null, null]);
    expect(a.mandateDigest).toBe(b.mandateDigest);
    expect(openMandateRow(a, { publicKeyB64: keys.publicKeyB64 })).toMatchObject({ version: 1 });
    // a V1 row never opens under the V2 verifier, and a V2 row never opens under the V1 opener
    expect(openMandateRow({ ...a, sealVersion: 2, mandateNonce: "a".repeat(32) }, { publicKeyB64: keys.publicKeyB64, registry, v2Gate })).toBeNull();
  });
});

describe("locking V2 terms", () => {
  const fresh = async (s: { mandateOver?: Record<string, unknown> } = {}) => {
    const p = await principalOf();
    const m = await makeV2Mandate(p, s.mandateOver);
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
    await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
    return { p, m, dealId: deal.id };
  };
  const lock = (f: { p: { id: string }; dealId: string }, terms: unknown, deps = v2Deps) => lockTerms(prisma, { dealId: f.dealId, terms, actor: "principal", principalId: f.p.id, deps });

  it("valid LLM and deterministic-only V2 terms lock, record the schema version and language-policy hash, and put both in the ledger", async () => {
    const f = await fresh();
    const hash = await lock(f, llmTerms(f.m.id));
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: f.dealId } });
    expect(deal).toMatchObject({ state: "TERMS_LOCKED", termsHash: hash, termsSchemaVersion: 2 });
    expect(deal.languagePolicyHash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await prisma.dealEvent.findFirst({ where: { dealId: f.dealId, type: "STATE_TRANSITION", payload: { path: ["to"], equals: "TERMS_LOCKED" } } });
    expect(ev?.payload).toMatchObject({ termsHash: hash, termsSchemaVersion: 2, languagePolicyHash: deal.languagePolicyHash });
    const g = await fresh();
    await lock(g, detTerms(g.m.id));
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: g.dealId } })).languagePolicyHash).toBeNull();
  });
  it("V2 terms need the verification context, a V2 mandate, a valid classification, a policy at least as strict as the mandate's, the deployment switch and a permitted detector", async () => {
    const f = await fresh();
    const t = llmTerms(f.m.id);
    await expect(lockTerms(prisma, { dealId: f.dealId, terms: t, actor: "principal", principalId: f.p.id })).rejects.toThrow(/verification context/);
    const broken = deepClone(t);
    (broken.criteria[1] as { inputFields: string[] }).inputFields.push("col:email");
    await expect(lock(f, broken)).rejects.toThrow(/CLASSIFICATION_CONFLICT/);
    const wide = llmTermsV2(f.m.id, { languagePolicy: floorPolicy({ supportedLanguages: ["en", "fr", "zh"], criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }) });
    await expect(lock(f, wide)).rejects.toThrow(/LANGUAGE_POLICY_WEAKER_THAN_MANDATE/);
    await expect(lock(f, t, { ...v2Deps, llmCriteriaEnabled: false })).rejects.toThrow(/LLM_CRITERIA_NOT_ENABLED/);
    await expect(lock(f, t, { ...v2Deps, detectorPermitted: () => false })).rejects.toThrow(/DETECTOR_NOT_PERMITTED/);
    await expect(lock(f, t, { ...v2Deps, registry: undefined })).rejects.toThrow(/Mandate seal does not verify/);
    await expect(lock(f, { ...t, mandateId: "c" + "z".repeat(24) })).rejects.toThrow(/do not match/);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: f.dealId } })).state).toBe("NEGOTIATING"); // nothing was locked
  });
  it("V2 terms under a V1 mandate, and V1 terms under a V2 mandate, cannot be locked", async () => {
    const p = await principalOf();
    const v1Draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
    const v1 = await approveMandate(prisma, { principalId: p.id, principalEmail: p.email, draft: v1Draft, confirmDigest: previewMandate(p.id, v1Draft).digest, keys });
    const d1 = await createDeal(prisma, { principalId: p.id, mandateId: v1.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
    await beginNegotiation(prisma, d1.id, "buyer-agent", p.id);
    // V1 mandate ids are cuids, which have the V2 id shape; the version pairing is what refuses
    await expect(lockTerms(prisma, { dealId: d1.id, terms: detTermsV2(v1.id), actor: "principal", principalId: p.id, deps: v2Deps })).rejects.toThrow(/V2 terms require a V2 mandate/);
    const f = await fresh();
    const v1Terms = { taskType: "data_cleaning", description: "d", criteria: [{ id: "schema", text: "t", type: "deterministic", validator: "csv_schema_matches", params: {}, required: true, weight: 100 }], price: "10.00", currency: "USD", deadline: "2029-01-01T00:00:00.000Z", sellerId: "seller-sim", mandateId: f.m.id };
    await expect(lock(f, v1Terms)).rejects.toThrow(/V2 mandate requires V2 terms/);
  });
});

describe("policy for V2 deals", () => {
  it("every V2 deal needs a human attestation: LLM_MAPPING_APPROVAL_REQUIRED, or V2_TERMS_APPROVAL_REQUIRED for deterministic-only terms (even far below the price threshold)", async () => {
    const a = await v2PendingApproval({ terms: llmTerms });
    expect(a.policy).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["LLM_MAPPING_APPROVAL_REQUIRED"] });
    const b = await v2PendingApproval({ terms: detTerms });
    expect(b.policy).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["V2_TERMS_APPROVAL_REQUIRED"] });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: b.dealId } })).state).toBe("NEEDS_HUMAN");
  });
  it("the legacy approval path cannot approve a V2 deal, and a bare reserveForDeal(humanApproved) without an attestation refuses", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    const legacy = await resolvePreAuthReview(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, decision: "approve", deps: x.deps });
    expect(legacy).toEqual({ ok: false, reasons: ["ATTESTATION_FLOW_REQUIRED"] });
    const bare = await reserveForDeal(prisma, { dealId: x.dealId, deps: x.deps, humanApproved: true, principalId: x.p.id });
    expect(bare).toMatchObject({ ok: false });
    expect(await prisma.budgetReservation.count({ where: { dealId: x.dealId } })).toBe(0);
    expect(await prisma.termsAttestation.count({ where: { dealId: x.dealId } })).toBe(0);
    expect(await prisma.dealEvent.count({ where: { dealId: x.dealId, type: "HUMAN_REVIEW_DECISION" } })).toBe(0);
  });
  it("a V2 deal can still be REJECTED by the principal through the legacy path (rejecting is always safe)", async () => {
    const x = await v2PendingApproval({ terms: detTerms });
    const r = await resolvePreAuthReview(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, decision: "reject", deps: x.deps });
    expect(r).toEqual({ ok: true, blocked: true });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: x.dealId } })).state).toBe("BLOCKED");
  });
});

describe("two-step human approval and the TermsAttestation", () => {
  it("the preview shows criteria, field mapping, the opaque list, the language policy, budget, counterparties, expiry, task restrictions and acceptance criteria", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    const pv = await previewDealApproval(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, deps: x.deps, keys });
    const text = pv.rendering.join("\n");
    expect(pv).toMatchObject({ modelCallsPermitted: true, modelGroups: 1, sellerId: "seller-sim", price: "20.00", currency: "USD", counterparties: ["seller-sim"], allowedTaskTypes: ["data_cleaning"], mandateExpiresAt: "2030-01-01T00:00:00.000Z" });
    expect(pv.budget).toEqual({ budgetTotal: "100.00", perDealMax: "60.00", committedByOthers: "0.00", remainingBefore: "100.00", thisDeal: "20.00", remainingAfter: "80.00" });
    expect(pv.opaqueFields).toEqual(expect.arrayContaining(["csv:header", "manifest:metadata", "manifest:artifactReference", "manifest:mediaType", "col:customer_id", "col:email"]));
    expect(pv.mapping.criteria.find((c) => c.id === "coherent")).toEqual({ id: "coherent", inputFields: ["col:delivery_notes", "col:description"], inputMaxRows: 15 });
    expect(pv.acceptanceCriteria.map((c) => c.id)).toEqual(["coherent", "schema"]);
    for (const needle of ["coherent", "col:description", "col:delivery_notes", "Fields never sent to any AI model", "col:email", "csv:header", "UNVERIFIABLE", "human review", "supported languages en, fr", pv.attestationDigest, pv.termsHash, "not a signature made with a key you hold", "seller-sim", "2030-01-01"]) expect(text, needle).toContain(needle);
    expect(pv.approvalNonce).toMatch(/^[0-9a-f]{32}$/);
  });
  it("a deterministic-only preview says no AI model will read the artifact", async () => {
    const x = await v2PendingApproval({ terms: detTerms });
    const pv = await previewDealApproval(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, deps: x.deps, keys });
    expect(pv).toMatchObject({ modelCallsPermitted: false, modelGroups: 0, languagePolicy: null, languagePolicyHash: null });
    expect(pv.rendering.join("\n")).toContain("no AI model will read the delivered artifact");
  });
  it("approval writes a verifying attestation, an extended HUMAN_REVIEW_DECISION event and the reservation, atomically", async () => {
    const x = await v2Approved({ terms: llmTerms });
    const att = await prisma.termsAttestation.findUniqueOrThrow({ where: { dealId: x.dealId } });
    expect(att).toMatchObject({ approvalKind: "HUMAN_PREAUTH", actorKind: "human", actorId: x.p.id, termsSchemaVersion: 2, approvalNonce: x.preview.approvalNonce, mappingHash: x.preview.mappingHash, termsHash: x.preview.termsHash, languagePolicyHash: x.preview.languagePolicyHash });
    const ev = await prisma.dealEvent.findFirst({ where: { dealId: x.dealId, type: "HUMAN_REVIEW_DECISION" } });
    expect(ev?.actor).toBe(`human:${x.p.email}`);
    expect(ev?.payload).toMatchObject({ phase: "PRE_AUTH", decision: "approve", termsHash: x.preview.termsHash, attestationId: att.id, approvalNonce: x.preview.approvalNonce });
    expect(await prisma.budgetReservation.findFirst({ where: { dealId: x.dealId } })).toMatchObject({ status: "ACTIVE" });
    const a = await authorizeDeal(prisma, x.dealId, { ...x.deps }, { checkExpiry: true, requireActiveReservation: true });
    expect(a).toMatchObject({ ok: true });
    expect((await verifyChain(prisma, x.dealId)).ok).toBe(true);
  });
  it("a wrong digest, an unknown nonce, a foreign nonce, an expired nonce and a reused nonce change nothing", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    const pv = await previewDealApproval(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, deps: x.deps, keys });
    const go = (over: Record<string, unknown>) => approveDealWithAttestation(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, confirmDigest: pv.attestationDigest, approvalNonce: pv.approvalNonce, deps: x.deps, keys, ...over });
    await expect(go({ confirmDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await expect(go({ approvalNonce: "a".repeat(32) })).rejects.toMatchObject({ code: "NONCE_UNKNOWN" });
    await expect(go({ approvalNonce: "not-hex" })).rejects.toMatchObject({ code: "NONCE_UNKNOWN" });
    await expect(go({ now: new Date(Date.now() + 16 * 60_000) })).rejects.toMatchObject({ code: "NONCE_EXPIRED" });
    // a nonce issued for ANOTHER deal is unknown here, even with that deal's valid digest
    const y = await v2PendingApproval({ terms: llmTerms });
    const pvY = await previewDealApproval(prisma, { dealId: y.dealId, principalId: y.p.id, principalEmail: y.p.email, deps: y.deps, keys });
    await expect(go({ approvalNonce: pvY.approvalNonce, confirmDigest: pvY.attestationDigest })).rejects.toMatchObject({ code: "NONCE_UNKNOWN" });
    expect(await prisma.termsAttestation.count({ where: { dealId: x.dealId } })).toBe(0);
    expect(await prisma.budgetReservation.count({ where: { dealId: x.dealId } })).toBe(0);
    expect(await prisma.dealEvent.count({ where: { dealId: x.dealId, type: "HUMAN_REVIEW_DECISION" } })).toBe(0);
    await go({}); // the correct echo still works afterwards
    await expect(go({})).rejects.toMatchObject({ code: "ALREADY_APPROVED" });
  });
  it("only the mandate's principal can preview or approve (impersonation by another principal is NotFound; the attestation actor is the principal)", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    const other = await principalOf();
    await expect(previewDealApproval(prisma, { dealId: x.dealId, principalId: other.id, principalEmail: other.email, deps: x.deps, keys })).rejects.toThrow(/not found/i);
    const pv = await previewDealApproval(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, deps: x.deps, keys });
    await expect(approveDealWithAttestation(prisma, { dealId: x.dealId, principalId: other.id, principalEmail: other.email, confirmDigest: pv.attestationDigest, approvalNonce: pv.approvalNonce, deps: x.deps, keys })).rejects.toThrow(/not found/i);
    expect(await prisma.termsAttestation.count({ where: { dealId: x.dealId } })).toBe(0);
  });
  it("concurrent approvals of one deal: exactly one attestation and one reservation; the other attempt is refused", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    const pvs = await Promise.all([1, 2, 3].map(() => previewDealApproval(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, deps: x.deps, keys })));
    const results = await Promise.allSettled(pvs.map((pv) => approveDealWithAttestation(prisma, { dealId: x.dealId, principalId: x.p.id, principalEmail: x.p.email, confirmDigest: pv.attestationDigest, approvalNonce: pv.approvalNonce, deps: x.deps, keys })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ApprovalError);
    expect(await prisma.termsAttestation.count({ where: { dealId: x.dealId } })).toBe(1);
    expect(await prisma.budgetReservation.count({ where: { dealId: x.dealId } })).toBe(1);
    expect(await prisma.dealEvent.count({ where: { dealId: x.dealId, type: "HUMAN_REVIEW_DECISION" } })).toBe(1);
  });
  it("two deals cannot jointly overspend the mandate: the second approval is refused and leaves no attestation", async () => {
    const p = await principalOf();
    const m = await makeV2Mandate(p, { budgetTotal: "100", perDealMax: "60", requireHumanAbove: "60" });
    const mk = async (price: string) => {
      const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
      await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
      await lockTerms(prisma, { dealId: deal.id, terms: detTermsV2(m.id, { price }), actor: "principal", principalId: p.id, deps: v2Deps });
      await checkPolicy(prisma, { dealId: deal.id, deps: v2Deps });
      return deal.id;
    };
    const [a, b] = [await mk("55.00"), await mk("55.00")];
    const approve = async (dealId: string) => {
      const pv = await previewDealApproval(prisma, { dealId, principalId: p.id, principalEmail: p.email, deps: v2Deps, keys });
      return approveDealWithAttestation(prisma, { dealId, principalId: p.id, principalEmail: p.email, confirmDigest: pv.attestationDigest, approvalNonce: pv.approvalNonce, deps: v2Deps, keys });
    };
    const settled = await Promise.allSettled([approve(a), approve(b)]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reservations = await prisma.budgetReservation.findMany({ where: { mandateId: m.id } });
    expect(reservations).toHaveLength(1);
    const loser = reservations[0]!.dealId === a ? b : a;
    expect(await prisma.termsAttestation.count({ where: { dealId: loser } })).toBe(0);
  });
  it("revocation, terms drift and a tampered attestation each stop the approval or the order (the whole authorization is re-derived)", async () => {
    // revoked mandate between preview and approve
    const r = await v2PendingApproval({ terms: llmTerms });
    const pvR = await previewDealApproval(prisma, { dealId: r.dealId, principalId: r.p.id, principalEmail: r.p.email, deps: r.deps, keys });
    await prisma.mandate.update({ where: { id: r.m.id }, data: { revokedAt: new Date() } });
    await expect(approveDealWithAttestation(prisma, { dealId: r.dealId, principalId: r.p.id, principalEmail: r.p.email, confirmDigest: pvR.attestationDigest, approvalNonce: pvR.approvalNonce, deps: r.deps, keys })).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
    // terms drift after lock
    const d = await v2PendingApproval({ terms: llmTerms });
    await prisma.$executeRaw`UPDATE "Deal" SET "termsJson" = jsonb_set("termsJson", '{price}', '"1.00"') WHERE id = ${d.dealId}`;
    await expect(previewDealApproval(prisma, { dealId: d.dealId, principalId: d.p.id, principalEmail: d.p.email, deps: d.deps, keys })).rejects.toMatchObject({ code: "AUTHORIZATION_INVALID" });
  });
  it("the attestation is immutable in the database; a tampered copy (trigger bypassed) is refused by authorization and by the settlement engine", async () => {
    const x = await v2Approved({ terms: llmTerms });
    await expect(prisma.$executeRaw`UPDATE "TermsAttestation" SET "termsHash" = ${"0".repeat(64)} WHERE "dealId" = ${x.dealId}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`DELETE FROM "TermsAttestation" WHERE "dealId" = ${x.dealId}`).rejects.toThrow(/immutable/);
    // an attacker with direct database access disables the trigger and edits the signed payload: the signature no longer matches
    await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" DISABLE TRIGGER "TermsAttestation_immutable"`);
    try {
      const att = await prisma.termsAttestation.findUniqueOrThrow({ where: { dealId: x.dealId } });
      await prisma.$executeRaw`UPDATE "TermsAttestation" SET "payloadJson" = ${att.payloadJson.replace(x.preview.termsHash, "1".repeat(64))} WHERE "dealId" = ${x.dealId}`;
      const a = await authorizeDeal(prisma, x.dealId, x.deps, {});
      expect(a).toMatchObject({ ok: false, reason: "ATTESTATION_INVALID" });
      const mock = new MockPayPal();
      expect(await createPayPalOrder(makeV2Ctx(mock), x.dealId)).toMatchObject({ status: "REFUSED", reason: "ATTESTATION_INVALID" });
      expect(mock.writes).toHaveLength(0);
      await prisma.$executeRaw`UPDATE "TermsAttestation" SET "payloadJson" = ${att.payloadJson}, "actorId" = 'someone-else' WHERE "dealId" = ${x.dealId}`;
      expect(await authorizeDeal(prisma, x.dealId, x.deps, {})).toMatchObject({ ok: false, reason: "ATTESTATION_INVALID" }); // column differs from the signed payload
      await prisma.$executeRaw`UPDATE "TermsAttestation" SET "actorId" = ${att.actorId} WHERE "dealId" = ${x.dealId}`;
      expect(await authorizeDeal(prisma, x.dealId, x.deps, {})).toMatchObject({ ok: true });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" ENABLE TRIGGER "TermsAttestation_immutable"`);
    }
  });
  it("the settlement engine will not create a PayPal order for a V2 deal without a verifying attestation, even if the ledger and reservation look right", async () => {
    const x = await v2PendingApproval({ terms: llmTerms });
    // forge everything EXCEPT the attestation: a human-approval ledger event and an ACTIVE reservation
    await prisma.$transaction(async (tx) => {
      await appendEvent(tx, x.dealId, "HUMAN_REVIEW_DECISION", `human:${x.p.email}`, { phase: "PRE_AUTH", decision: "approve" });
      await tx.budgetReservation.create({ data: { mandateId: x.m.id, dealId: x.dealId, amount: "20.00", status: "ACTIVE" } });
    });
    const mock = new MockPayPal();
    expect(await createPayPalOrder(makeV2Ctx(mock), x.dealId)).toMatchObject({ status: "REFUSED", reason: "ATTESTATION_MISSING" });
    expect(mock.writes).toHaveLength(0);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: x.dealId } })).state).toBe("NEEDS_HUMAN");
  });
  it("end to end on the MOCK: approved V2 deal -> order -> authorized, with the attestation re-verified at order creation", async () => {
    const mock = new MockPayPal();
    const ctx = makeV2Ctx(mock);
    const x = await v2Authorized(mock, ctx, { terms: llmTerms });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: x.dealId } })).state).toBe("AWAITING_DELIVERY");
    expect(mock.writes.map((w) => w.type)).toContain("CREATE_ORDER");
  });
  it("an engine without the registry cannot verify a V2 deal at all (fail closed)", async () => {
    const x = await v2Approved({ terms: detTerms });
    const mock = new MockPayPal();
    expect(await createPayPalOrder(makeV2Ctx(mock, { deps: { registry: undefined } }), x.dealId)).toMatchObject({ status: "REFUSED", reason: "MANDATE_SEAL_INVALID" });
    expect(mock.writes).toHaveLength(0);
  });
});

void Prisma;
