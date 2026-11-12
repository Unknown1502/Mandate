/**
 * P0 model-isolation gate (docs/15 s15.9.0; weakness W1).
 *
 * The ONE place that decides whether a verification may place artifact content in front of an AI model. It reads the criteria of the
 * parsed, hash-verified, LOCKED terms (never a request property, never configuration), and the verification pipeline obtains its
 * verifier and skeptic only through this decision.
 *
 * Stage P0: only TermsV1 exists, and a V1 deal is NEVER given AI-based verification:
 *   - no `llm_judged` criterion  -> the deal is decided by deterministic validators and the existing deterministic policy alone;
 *   - an `llm_judged` criterion  -> that criterion is UNVERIFIABLE (human review) until a newly approved V2 deal exists.
 * Anything this function cannot classify throws, and the caller fails closed.
 *
 * This module imports nothing from the agents, PayPal, settlement or database code.
 */
import type { Criterion } from "../domain/terms";

/** Reason recorded on an `llm_judged` criterion that could not be AI-verified because the terms are V1. */
export const MODEL_BLOCKED_REASON = "LEGACY_TERMS_NO_INPUT_BOUNDARY";

export type ModelPolicyReason = "NO_LLM_CRITERIA" | "LLM_CRITERIA_BLOCKED_PENDING_V2";

export interface ModelPolicy {
  /** may a verifier / skeptic model be given any artifact-derived text for this deal? (false for every deal at stage P0) */
  readonly permitted: boolean;
  readonly hasLlmCriteria: boolean;
  readonly reason: ModelPolicyReason;
}

export class UnclassifiableTermsError extends Error {
  constructor(detail: string) {
    super(`TERMS_UNCLASSIFIABLE: ${detail}`);
    this.name = "UnclassifiableTermsError";
  }
}

export function modelPolicyFor(criteria: readonly Pick<Criterion, "type">[]): ModelPolicy {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new UnclassifiableTermsError("no criteria");
  let hasLlmCriteria = false;
  for (const c of criteria) {
    const type: unknown = c?.type;
    if (type === "llm_judged") hasLlmCriteria = true;
    else if (type !== "deterministic") throw new UnclassifiableTermsError("unknown criterion type");
  }
  return { permitted: false, hasLlmCriteria, reason: hasLlmCriteria ? "LLM_CRITERIA_BLOCKED_PENDING_V2" : "NO_LLM_CRITERIA" };
}
