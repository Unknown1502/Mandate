/**
 * P3: V2 mandate writer (pure parts) and the V2 policy rules.
 */
import { describe, expect, it } from "vitest";
import { D } from "@/domain/money";
import { verifyV2MandateSeal } from "@/domain/mandate-v2";
import {
  buildMandateDocumentV2,
  mandateDigestV2,
  mandateDraftV2Schema,
  newMandateId,
  newMandateNonce,
  previewMandateV2,
  renderMandatePreview,
  sealMandateV2,
} from "@/domain/mandate-v2-writer";
import { buildMandateDocument } from "@/domain/mandate";
import { evaluatePolicy, type PolicyInput } from "@/domain/policy";
import { hashAny, readAnyTerms, termsHashV2, type TermsV2 } from "@/domain/terms-v2";
import { termsHash } from "@/domain/terms";
import { DETECTOR, deepClone, detTermsV2, floorPolicy, llmTermsV2, mandateDraftV2, v2Keys, v2Registry } from "../helpers/v2Fixtures";

const PRINCIPAL = "user-1";
function v2Doc(over: Record<string, unknown> = {}) {
  const pv = previewMandateV2(PRINCIPAL, mandateDraftV2(over));
  return pv.document;
}
const permitted = (d: { id: string; version: string; vocabularyHash: string }) => d.id === DETECTOR.id && d.version === DETECTOR.version && d.vocabularyHash === DETECTOR.vocabularyHash;
const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("V2 mandate writer", () => {
  it("preview issues a well-formed id and nonce, and the same draft + issued identity previews to the identical digest", () => {
    const a = previewMandateV2(PRINCIPAL, mandateDraftV2());
    expect(a.document.mandateId).toMatch(/^c[a-z0-9]{24}$/);
    expect(a.document.nonce).toMatch(/^[0-9a-f]{32}$/);
    const b = previewMandateV2(PRINCIPAL, a.draft);
    expect(b.digest).toBe(a.digest);
    expect(previewMandateV2(PRINCIPAL, mandateDraftV2()).digest).not.toBe(a.digest); // fresh identity => fresh digest
    expect(newMandateId()).not.toBe(newMandateId());
    expect(newMandateNonce()).not.toBe(newMandateNonce());
  });
  it("the document is canonical (sorted, de-duplicated, two-decimal money) and carries the language policy and a null carry-over", () => {
    const d = v2Doc({ counterparties: ["z-seller", "a-seller", "a-seller"], budgetTotal: "100", perDealMax: "60.5" });
    expect(d.counterparties).toEqual(["a-seller", "z-seller"]);
    expect(d.budgetTotal).toBe("100.00");
    expect(d.perDealMax).toBe("60.50");
    expect(d.carryOver).toBeNull();
    expect(d.languagePolicy).toEqual(floorPolicy());
    expect(d.schemaVersion).toBe(2);
  });
  it("the draft is strict: unknown keys, missing booleans (no defaults), a missing or malformed language policy and carry-over are refused", () => {
    const ok = mandateDraftV2();
    expect(mandateDraftV2Schema.safeParse(ok).success).toBe(true);
    expect(mandateDraftV2Schema.safeParse({ ...ok, carryOver: null }).success).toBe(false);
    expect(mandateDraftV2Schema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    for (const k of ["allowPartialSettlement", "allowPreDeliveryCancellation", "languagePolicy", "injectionPolicy"]) {
      const d = { ...ok } as Record<string, unknown>;
      delete d[k];
      expect(mandateDraftV2Schema.safeParse(d).success, k).toBe(false);
    }
    expect(mandateDraftV2Schema.safeParse({ ...ok, languagePolicy: { ...floorPolicy(), unsupportedBehavior: "ALLOW" } }).success).toBe(false);
    expect(mandateDraftV2Schema.safeParse({ ...ok, languagePolicy: { ...floorPolicy(), nameLikeBehavior: "ALLOW_COUNTED" } }).success).toBe(false);
    expect(mandateDraftV2Schema.safeParse({ ...ok, languagePolicy: { ...floorPolicy(), shortText: "EXEMPT" } }).success).toBe(false);
    expect(mandateDraftV2Schema.safeParse({ ...ok, mandateId: "mine" }).success).toBe(false);
    expect(() => previewMandateV2(PRINCIPAL, { ...ok, perDealMax: "500" })).toThrow();
  });
  it("a sealed V2 mandate is accepted by the independent P2 verifier (writer and verifier agree)", () => {
    const pv = previewMandateV2(PRINCIPAL, mandateDraftV2());
    const sealed = sealMandateV2(pv.document, { approvedBy: "p@example.test", approvedAt: NOW.toISOString() }, v2Keys);
    const r = verifyV2MandateSeal(sealed, { registry: v2Registry, expected: { mandateId: pv.document.mandateId, nonce: pv.document.nonce } });
    expect(r).toMatchObject({ ok: true, mandateDigest: pv.digest });
    expect(sealed.mandateDigest).toBe(mandateDigestV2(pv.document));
  });
  it("the preview shows every authorization-relevant value in plain language, including the language policy and 'not a user-held key'", () => {
    const text = renderMandatePreview(v2Doc({ counterparties: ["seller-sim", "seller-two"] })).join("\n");
    for (const needle of ["Budget total 100.00", "per-deal maximum 60.00", "seller-sim, seller-two", "data_cleaning", "Expires 2030-01-01T00:00:00.000Z", "supported languages en, fr", DETECTOR.vocabularyHash, "UNVERIFIABLE_HUMAN_REVIEW", "carry-over: none", "not a signature made with a key you hold", "short text is never exempt"]) expect(text).toContain(needle);
  });
  it("a signed value cannot be changed without changing the digest the human confirms", () => {
    const pv = previewMandateV2(PRINCIPAL, mandateDraftV2());
    for (const patch of [{ budgetTotal: "101" }, { counterparties: ["seller-sim", "evil"] }, { languagePolicy: floorPolicy({ supportedLanguages: ["en", "fr", "zh"] }) }, { expiresAt: "2031-01-01T00:00:00.000Z" }, { injectionPolicy: "BLOCK" }, { allowPartialSettlement: true }]) {
      const d = buildMandateDocumentV2(PRINCIPAL, { ...pv.draft, ...patch } as never);
      expect(mandateDigestV2(d)).not.toBe(pv.digest);
    }
  });
});

// -------------------------------------------------------------------------------------------------------------------------- policy
function input(mandate: PolicyInput["mandate"], terms: unknown, lockedHash: string, over: Partial<PolicyInput> = {}): PolicyInput {
  return { mandate, mandateId: (mandate as { mandateId?: string } | null)?.mandateId ?? "x", revokedAt: null, terms, lockedTermsHash: lockedHash, committed: new D(0), now: NOW, rounds: 0, maxRounds: 4, ...over };
}
const llmOn = { llmCriteriaEnabled: true, detectorPermitted: permitted };

describe("evaluatePolicy: V2", () => {
  it("every V2 deal needs a human approval attestation, even a deterministic-only deal far below the threshold", () => {
    const doc = v2Doc();
    const t = detTermsV2(doc.mandateId);
    expect(evaluatePolicy(input(doc, t, termsHashV2(t)))).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["V2_TERMS_APPROVAL_REQUIRED"] });
  });
  it("LLM-criteria terms need a human approval of the mapping regardless of amount, and add the price reason when above the threshold", () => {
    const doc = v2Doc();
    const t = llmTermsV2(doc.mandateId);
    expect(evaluatePolicy(input(doc, t, termsHashV2(t), llmOn))).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["LLM_MAPPING_APPROVAL_REQUIRED"] });
    const dear = llmTermsV2(doc.mandateId, { price: "55.00" });
    expect(evaluatePolicy(input(doc, dear, termsHashV2(dear), llmOn))).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["LLM_MAPPING_APPROVAL_REQUIRED", "PRICE_ABOVE_HUMAN_THRESHOLD"] });
  });
  it("LLM criteria are BLOCKED unless the deployment switch is on (docs/15 Q3 unresolved: strictest default)", () => {
    const doc = v2Doc();
    const t = llmTermsV2(doc.mandateId);
    expect(evaluatePolicy(input(doc, t, termsHashV2(t), { detectorPermitted: permitted }))).toEqual({ outcome: "BLOCKED", reasons: ["LLM_CRITERIA_NOT_ENABLED"] });
  });
  it("a detector that is not permitted (or no permission function at all) blocks; so does a weaker terms policy", () => {
    const doc = v2Doc();
    const t = llmTermsV2(doc.mandateId);
    expect(evaluatePolicy(input(doc, t, termsHashV2(t), { llmCriteriaEnabled: true })).reasons).toContain("DETECTOR_NOT_PERMITTED");
    expect(evaluatePolicy(input(doc, t, termsHashV2(t), { llmCriteriaEnabled: true, detectorPermitted: () => false })).reasons).toContain("DETECTOR_NOT_PERMITTED");
    const wide = llmTermsV2(doc.mandateId, { languagePolicy: floorPolicy({ supportedLanguages: ["en", "fr", "zh"], criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }) });
    expect(evaluatePolicy(input(doc, wide, termsHashV2(wide), llmOn))).toEqual({ outcome: "BLOCKED", reasons: ["LANGUAGE_POLICY_WEAKER_THAN_MANDATE"] });
    const lax = llmTermsV2(doc.mandateId, { languagePolicy: floorPolicy({ unsupportedBehavior: "UNVERIFIABLE_HUMAN_REVIEW", humanReview: { required: false }, criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }) });
    const strictMandate = v2Doc({ languagePolicy: floorPolicy({ humanReview: { required: true } }) });
    const lax2 = { ...lax, mandateId: strictMandate.mandateId };
    expect(evaluatePolicy(input(strictMandate, lax2, termsHashV2(lax2), llmOn)).reasons).toContain("LANGUAGE_POLICY_WEAKER_THAN_MANDATE");
  });
  it("the version pairing is strict: V2 terms under a V1 mandate and V1 terms under a V2 mandate are both blocked", () => {
    const v1 = buildMandateDocument(PRINCIPAL, { currency: "USD", budgetTotal: "100", perDealMax: "60", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", allowPartialSettlement: false, allowPreDeliveryCancellation: true, expiresAt: "2030-01-01T00:00:00.000Z" } as never);
    const t2 = detTermsV2("c" + "q".repeat(24));
    expect(evaluatePolicy(input(v1, t2, termsHashV2(t2), { mandateId: t2.mandateId })).reasons).toContain("MANDATE_V2_REQUIRED");
    const doc = v2Doc();
    const t1 = { taskType: "data_cleaning", description: "d", criteria: [{ id: "schema", text: "t", type: "deterministic", validator: "csv_schema_matches", params: {}, required: true, weight: 100 }], price: "10.00", currency: "USD", deadline: "2029-01-01T00:00:00.000Z", sellerId: "seller-sim", mandateId: doc.mandateId };
    const r = readAnyTerms(t1);
    expect(r.ok && hashAny(r)).toBeTruthy();
    expect(evaluatePolicy(input(doc, t1, termsHash(t1 as never))).reasons).toContain("TERMS_V2_REQUIRED");
  });
  it("an identity mismatch, drift, classification damage and a group above the cap are each BLOCKED with their own reason", () => {
    const doc = v2Doc();
    const t = llmTermsV2(doc.mandateId);
    const h = termsHashV2(t);
    expect(evaluatePolicy(input(doc, t, h, { ...llmOn, mandateId: "c" + "z".repeat(24) })).reasons).toContain("MANDATE_IDENTITY_MISMATCH");
    expect(evaluatePolicy(input(doc, t, "0".repeat(64), llmOn)).reasons).toContain("TERMS_DRIFT");
    const broken = deepClone(t);
    (broken.criteria[1] as { inputFields: string[] }).inputFields.push("col:email");
    expect(evaluatePolicy(input(doc, broken, termsHashV2(broken), llmOn)).reasons).toContain("CLASSIFICATION_INVALID");
    const two = deepClone(t);
    two.criteria.push({ id: "extra", text: "x", type: "llm_judged", inputFields: ["col:delivery_notes"], inputMaxRows: 5, required: false, weight: 1 } as never);
    (two.criteria[0] as { weight: number }).weight = 69;
    (two.artifactSchema!.fields.find((f) => f.id === "col:delivery_notes") as { criteria: string[] }).criteria = ["coherent", "extra"];
    two.languagePolicy = floorPolicy({ criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }, { criterionId: "extra", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] });
    expect(evaluatePolicy(input(doc, two, termsHashV2(two), llmOn)).reasons).toEqual(["MODEL_GROUP_CAP_EXCEEDED"]);
    expect(evaluatePolicy(input(doc, two, termsHashV2(two), { ...llmOn, modelGroupCap: 2 })).outcome).toBe("NEEDS_HUMAN");
  });
  it("ordinary mandate limits still bind V2 deals (price, budget, counterparty, task type, deadline, expiry, revocation)", () => {
    const doc = v2Doc();
    const mk = (over: Partial<TermsV2>) => {
      const t = detTermsV2(doc.mandateId, over);
      return input(doc, t, termsHashV2(t));
    };
    expect(evaluatePolicy(mk({ price: "61.00" })).reasons).toContain("PRICE_OVER_PER_DEAL_MAX");
    expect(evaluatePolicy({ ...mk({ price: "20.00" }), committed: new D("90") }).reasons).toContain("BUDGET_EXCEEDED");
    expect(evaluatePolicy(mk({ sellerId: "stranger" })).reasons).toContain("COUNTERPARTY_NOT_ALLOWED");
    expect(evaluatePolicy(mk({ deadline: "2031-01-01T00:00:00.000Z" })).reasons).toContain("DEADLINE_INVALID");
    expect(evaluatePolicy({ ...mk({}), now: new Date("2031-01-01T00:00:00.000Z") }).reasons).toContain("MANDATE_EXPIRED");
    expect(evaluatePolicy({ ...mk({}), revokedAt: NOW }).reasons).toContain("MANDATE_REVOKED");
  });
});
