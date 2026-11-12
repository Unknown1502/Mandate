import { assertUsd, parseMoney, type Money } from "./money";
import type { MandateDocument } from "./mandate";
import type { MandateDocumentV2 } from "./mandate-v2";
import { strictnessFailures, type LanguagePolicy } from "./language-policy";
import { criteriaIssues } from "./terms";
import { hashAny, hasLlmCriteria, readAnyTerms } from "./terms-v2";

export type PolicyReason =
  | "MANDATE_SEAL_INVALID"
  | "MANDATE_EXPIRED"
  | "MANDATE_REVOKED"
  | "TERMS_INVALID"
  | "TERMS_VERSION_UNSUPPORTED"
  | "CURRENCY_MISMATCH"
  | "PRICE_OVER_PER_DEAL_MAX"
  | "BUDGET_EXCEEDED"
  | "TASK_TYPE_NOT_ALLOWED"
  | "COUNTERPARTY_NOT_ALLOWED"
  | "CRITERIA_WEIGHTS_NOT_100"
  | "CRITERIA_NO_REQUIRED"
  | "CRITERIA_DUPLICATE_ID"
  | "TERMS_DRIFT"
  | "DEADLINE_INVALID"
  | "ROUNDS_EXCEEDED"
  | "PRICE_ABOVE_HUMAN_THRESHOLD"
  // ---- V2 (P3). Blocking unless stated.
  | "MANDATE_V2_REQUIRED" /* V2 terms under a V1 mandate: a V1 mandate cannot authorise V2 terms */
  | "TERMS_V2_REQUIRED" /* V1 terms under a V2 mandate: no downgrade around the signed language policy */
  | "MANDATE_IDENTITY_MISMATCH"
  | "CLASSIFICATION_INVALID"
  | "MODEL_GROUP_CAP_EXCEEDED"
  | "LANGUAGE_POLICY_WEAKER_THAN_MANDATE"
  | "LLM_CRITERIA_NOT_ENABLED" /* deployment switch (docs/15 Q3 unresolved): off by default */
  | "DETECTOR_NOT_PERMITTED" /* P7 */
  | "LLM_MAPPING_APPROVAL_REQUIRED" /* NEEDS_HUMAN: V2 terms with LLM criteria need a human attestation regardless of amount */
  | "V2_TERMS_APPROVAL_REQUIRED"; /* NEEDS_HUMAN: every V2 deal needs a human attestation */

export interface PolicyInput {
  /** Document from openMandateRow(); null means the seal did not verify. A V2 document (schemaVersion 2) is evaluated under the V2 rules. */
  mandate: MandateDocument | MandateDocumentV2 | null;
  mandateId: string;
  revokedAt: Date | null;
  terms: unknown;
  lockedTermsHash: string;
  /** captured + ACTIVE/CONVERTED reservations for this mandate, EXCLUDING this deal. */
  committed: Money;
  now: Date;
  rounds: number;
  maxRounds: number;
  /** V2 only. Cap on distinct model groups (docs/15 Q5 unresolved): defaults to 1. */
  modelGroupCap?: number;
  /** V2 only. Deployment switch for LLM-judged criteria (docs/15 Q3 unresolved): defaults to OFF. */
  llmCriteriaEnabled?: boolean;
  /** V2 only (P7). When supplied, a pinned detector must satisfy it. When absent, no V2 LLM deal is permitted a detector (fail closed). */
  detectorPermitted?: (d: LanguagePolicy["detector"], supported?: readonly string[]) => boolean;
}

export interface PolicyResult {
  outcome: "OK" | "NEEDS_HUMAN" | "BLOCKED";
  reasons: PolicyReason[];
}

/** reasons that route to a human rather than block */
const HUMAN_ROUTED = new Set<PolicyReason>(["PRICE_ABOVE_HUMAN_THRESHOLD", "LLM_MAPPING_APPROVAL_REQUIRED", "V2_TERMS_APPROVAL_REQUIRED"]);
const BLOCKING = (r: PolicyReason) => !HUMAN_ROUTED.has(r);

/** Every check from docs/04 §4.3, deterministic, returning ALL failing reason codes. */
export function evaluatePolicy(i: PolicyInput): PolicyResult {
  const reasons: PolicyReason[] = [];
  const m = i.mandate;
  if (!m) return { outcome: "BLOCKED", reasons: ["MANDATE_SEAL_INVALID"] };
  const v2Mandate = m.schemaVersion === 2;

  if (new Date(m.expiresAt) <= i.now) reasons.push("MANDATE_EXPIRED");
  if (i.revokedAt) reasons.push("MANDATE_REVOKED");
  if (i.rounds > i.maxRounds) reasons.push("ROUNDS_EXCEEDED");
  if (v2Mandate && m.mandateId !== i.mandateId) reasons.push("MANDATE_IDENTITY_MISMATCH");

  const parsed = readAnyTerms(i.terms, { modelGroupCap: i.modelGroupCap });
  if (!parsed.ok) return { outcome: "BLOCKED", reasons: [...reasons, parsed.code === "TERMS_VERSION_UNSUPPORTED" || parsed.code === "CRITERION_VERSION_UNSUPPORTED" ? "TERMS_VERSION_UNSUPPORTED" : "TERMS_INVALID"] };
  const t = parsed.terms;

  if (parsed.version === 1 && v2Mandate) reasons.push("TERMS_V2_REQUIRED");
  if (parsed.version === 2 && !v2Mandate) reasons.push("MANDATE_V2_REQUIRED");

  if (hashAny(parsed) !== i.lockedTermsHash) reasons.push("TERMS_DRIFT");
  if (t.mandateId !== i.mandateId) reasons.push("TERMS_INVALID");

  let llm = false;
  if (parsed.version === 2) {
    llm = hasLlmCriteria(parsed.terms);
    for (const issue of parsed.issues) reasons.push(issue === "MODEL_GROUP_CAP_EXCEEDED" ? "MODEL_GROUP_CAP_EXCEEDED" : "CLASSIFICATION_INVALID");
    if (llm) {
      if (!i.llmCriteriaEnabled) reasons.push("LLM_CRITERIA_NOT_ENABLED");
      const tp = parsed.terms.languagePolicy;
      if (tp) {
        if (m.schemaVersion === 2 && strictnessFailures(tp, m.languagePolicy).length > 0) reasons.push("LANGUAGE_POLICY_WEAKER_THAN_MANDATE");
        if (!i.detectorPermitted || !i.detectorPermitted(tp.detector, tp.supportedLanguages)) reasons.push("DETECTOR_NOT_PERMITTED");
      }
    }
  }

  try {
    assertUsd(t.currency);
    assertUsd(m.currency);
  } catch {
    reasons.push("CURRENCY_MISMATCH");
  }

  const price = parseMoney(t.price);
  if (price.gt(parseMoney(m.perDealMax))) reasons.push("PRICE_OVER_PER_DEAL_MAX");
  if (i.committed.add(price).gt(parseMoney(m.budgetTotal))) reasons.push("BUDGET_EXCEEDED");
  if (!(m.allowedTaskTypes as readonly string[]).includes(t.taskType)) reasons.push("TASK_TYPE_NOT_ALLOWED");
  if (!m.counterparties.includes(t.sellerId)) reasons.push("COUNTERPARTY_NOT_ALLOWED");

  for (const issue of criteriaIssues(t.criteria)) {
    reasons.push(
      issue === "WEIGHTS_NOT_100" ? "CRITERIA_WEIGHTS_NOT_100" : issue === "NO_REQUIRED_CRITERION" ? "CRITERIA_NO_REQUIRED" : "CRITERIA_DUPLICATE_ID",
    );
  }

  const deadline = new Date(t.deadline);
  if (deadline <= i.now || deadline > new Date(m.expiresAt)) reasons.push("DEADLINE_INVALID");

  if (reasons.some(BLOCKING)) return { outcome: "BLOCKED", reasons };

  const human: PolicyReason[] = [];
  // every V2 deal needs a real human approval attestation (deterministic-only included); LLM-criteria deals say so explicitly
  if (parsed.version === 2) human.push(llm ? "LLM_MAPPING_APPROVAL_REQUIRED" : "V2_TERMS_APPROVAL_REQUIRED");
  if (m.requireHumanAbove && price.gt(parseMoney(m.requireHumanAbove))) human.push("PRICE_ABOVE_HUMAN_THRESHOLD");
  if (human.length > 0) return { outcome: "NEEDS_HUMAN", reasons: human };
  return { outcome: "OK", reasons: [] };
}
