/**
 * Intake binding check (P4/P5; docs/15 section 15.9.1 step 9). PURE: no database, no engine, no money.
 *
 * Given the CURRENT authorization of a deal (re-derived from the stored records by authorizeLoadedDeal) and a verification result, decide whether the result was produced
 * under exactly that authorization. A V1 deal accepts only results without a binding; a V2 deal accepts only results whose binding equals the current signed state.
 * Every refusal is a closed-enum code. Nothing here reads model output text: only hashes, ids, counts and closed-enum statuses.
 */
import type { DealAuthorization } from "../domain/authorization";
import { sha256Hex } from "../domain/canonical";
import { languagePolicyHashOf, mappingHashV2 } from "../domain/terms-v2";
import { V1_VERIFIER_VERSIONS, V2_VERIFIER_VERSION, type VerificationResult } from "../verification/contracts";

export const BINDING_REFUSALS = [
  "V1_RESULT_HAS_BINDING",
  "V1_VERIFIER_VERSION_UNKNOWN",
  "V2_RESULT_WITHOUT_BINDING",
  "V2_VERIFIER_VERSION_UNKNOWN",
  "BINDING_TERMS_MISMATCH",
  "BINDING_MANDATE_MISMATCH",
  "BINDING_MAPPING_MISMATCH",
  "BINDING_POLICY_MISMATCH",
  "BINDING_ATTESTATION_MISMATCH",
  "BINDING_DELIVERY_MISMATCH",
  "BINDING_VERIFICATION_ID_MISMATCH",
  "BINDING_GROUPS_INVALID",
  "BINDING_MODEL_CALLS_INVALID",
  "BINDING_ISOLATION_MISMATCH",
  "BINDING_EVIDENCE_INVALID",
  "BINDING_UNVERIFIED_CLAIM",
] as const;
export type BindingRefusal = (typeof BINDING_REFUSALS)[number];

export function bindingRefusal(a: DealAuthorization, r: VerificationResult, deliveryId: string): BindingRefusal | null {
  if (a.terms.version === 1) {
    if (r.binding) return "V1_RESULT_HAS_BINDING";
    if (!(V1_VERIFIER_VERSIONS as readonly string[]).includes(r.verifierVersion)) return "V1_VERIFIER_VERSION_UNKNOWN";
    return null;
  }
  // ------------------------------------------------------------------ V2
  const b = r.binding;
  if (!b) return "V2_RESULT_WITHOUT_BINDING";
  if (r.verifierVersion !== V2_VERIFIER_VERSION) return "V2_VERIFIER_VERSION_UNKNOWN";
  if (a.mandate.version !== 2 || !a.attestation || !a.deal.attestation) return "BINDING_ATTESTATION_MISMATCH";
  const terms = a.terms.terms;

  if (b.termsHash !== a.terms.termsHash || r.termsHash !== a.terms.termsHash) return "BINDING_TERMS_MISMATCH";
  if (b.mandateDigest !== a.mandate.mandateDigest || b.mandateId !== a.mandate.doc.mandateId) return "BINDING_MANDATE_MISMATCH";
  if (b.mappingHash !== mappingHashV2(terms)) return "BINDING_MAPPING_MISMATCH";
  if (b.languagePolicyHash !== languagePolicyHashOf(terms)) return "BINDING_POLICY_MISMATCH";
  if (terms.languagePolicy && (b.detector?.id !== terms.languagePolicy.detector.id || b.detector.version !== terms.languagePolicy.detector.version || b.detector.vocabularyHash !== terms.languagePolicy.detector.vocabularyHash)) return "BINDING_POLICY_MISMATCH";
  if (!terms.languagePolicy && (b.detector !== null || b.effectivePolicyHash !== null)) return "BINDING_POLICY_MISMATCH";
  if (b.attestationNonce !== a.attestation.approvalNonce || b.attestationRecordSha256 !== sha256Hex(a.deal.attestation.payloadJson)) return "BINDING_ATTESTATION_MISMATCH";
  if (b.deliveryId !== deliveryId) return "BINDING_DELIVERY_MISMATCH";
  if (b.verificationId !== r.verificationId) return "BINDING_VERIFICATION_ID_MISMATCH";

  // every LLM-judged criterion is in exactly one recorded group, with exactly the approved fields; groups reference nothing else
  const llm = terms.criteria.filter((c) => c.type === "llm_judged");
  const seen = new Map<string, string>();
  for (const g of b.groups) {
    for (const cid of g.criterionIds) {
      if (seen.has(cid)) return "BINDING_GROUPS_INVALID";
      seen.set(cid, g.groupKey);
      const c = llm.find((x) => x.id === cid);
      if (!c || c.type !== "llm_judged") return "BINDING_GROUPS_INVALID";
      const approved = [...c.inputFields].sort();
      const claimed = [...g.fieldIds].sort();
      if (approved.length !== claimed.length || approved.some((f, i) => f !== claimed[i])) return "BINDING_GROUPS_INVALID";
    }
  }
  if (seen.size !== llm.length) return "BINDING_GROUPS_INVALID";

  // model calls: only for groups that were called, only roles verifier/skeptic, only the group's approved fields; counts agree with the isolation record
  const calledGroups = new Set(b.groups.filter((g) => g.outcome === "MODEL_CALLED").map((g) => g.groupKey));
  const ids = new Set<string>();
  for (const m of b.modelCalls) {
    if (ids.has(m.callId)) return "BINDING_MODEL_CALLS_INVALID";
    ids.add(m.callId);
    const g = b.groups.find((x) => x.groupKey === m.groupKey);
    if (!g || !calledGroups.has(g.groupKey) || m.criterionIds.some((c) => !g.criterionIds.includes(c)) || m.fieldIds.some((f) => !g.fieldIds.includes(f))) return "BINDING_MODEL_CALLS_INVALID";
  }
  for (const g of b.groups) if (g.outcome === "MODEL_CALLED" && !b.modelCalls.some((m) => m.groupKey === g.groupKey && m.role === "verifier")) return "BINDING_MODEL_CALLS_INVALID";
  const iso = r.provenance.isolation;
  if (!iso || iso.modelCallsMade !== b.modelCalls.length) return "BINDING_ISOLATION_MISMATCH";
  if (llm.length === 0 && (b.modelCalls.length > 0 || iso.modelCallsPermitted)) return "BINDING_ISOLATION_MISMATCH";
  if (!iso.modelCallsPermitted && b.modelCalls.length > 0) return "BINDING_ISOLATION_MISMATCH";

  // evidence: bound to a model-judged criterion and to a field/row inside that criterion's approved view
  for (const e of b.evidence) {
    const c = llm.find((x) => x.id === e.criterionId);
    if (!c || c.type !== "llm_judged") return "BINDING_EVIDENCE_INVALID";
    if (e.fieldId !== null && !c.inputFields.includes(e.fieldId)) return "BINDING_EVIDENCE_INVALID";
    if (e.row !== null && e.row > c.inputMaxRows) return "BINDING_EVIDENCE_INVALID";
    if (!e.ref.startsWith(`csv:${r.artifactSha256.slice(0, 12)}#`)) return "BINDING_EVIDENCE_INVALID";
    if (e.callIds.some((id) => !ids.has(id))) return "BINDING_EVIDENCE_INVALID";
  }
  // a model-judged PASS or FAIL must rest on a completed model call and at least one bound evidence reference
  for (const cr of r.criteriaResults) {
    if (cr.type !== "llm_judged" || cr.status === "UNVERIFIABLE") continue;
    const gk = seen.get(cr.criterionId);
    const g = b.groups.find((x) => x.groupKey === gk);
    if (!g || g.outcome !== "MODEL_CALLED") return "BINDING_UNVERIFIED_CLAIM";
    if (!b.evidence.some((e) => e.criterionId === cr.criterionId)) return "BINDING_UNVERIFIED_CLAIM";
    if (b.modelCalls.filter((m) => m.groupKey === gk && m.role === "verifier" && m.status === "OK").length < 1) return "BINDING_UNVERIFIED_CLAIM";
  }
  return null;
}
