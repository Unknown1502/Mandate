import { z } from "zod";
import { D, proportion, type Money } from "./money";
import type { Criterion } from "./terms";

/**
 * PURE settlement decision (docs/04 §4.6). No I/O, no LLM, no clock. The only money amount it can return is
 * price * earned / 100 rounded DOWN, from pre-priced criterion weights. Nothing a verifier or skeptic says can
 * carry an amount: their outputs are only criterion statuses and flags.
 *
 * Deliberate deviations from docs/04 (stricter, never looser; recorded in docs/09):
 *  - ANY unverifiable criterion (required or optional) -> NEEDS_HUMAN, so a seller is never underpaid on a guess.
 *  - injectionPolicy=BLOCK is also NEEDS_HUMAN after authorization: a flag alone never auto-voids a valid authorization.
 *  - Partial capture additionally requires mandate.allowPartialSettlement AND Sandbox-verified partial capture.
 */
export const MIN_PARTIAL = 50;

export const criterionResultSchema = z.object({
  criterionId: z.string(),
  status: z.enum(["met", "not_met", "unverifiable"]),
  source: z.enum(["deterministic", "verifier", "human"]),
  evidence: z.string().max(2000).optional(),
});
export type CriterionResult = z.infer<typeof criterionResultSchema>;

export const flagSchema = z.object({
  code: z.string().max(64),
  severity: z.enum(["LOW", "MED", "HIGH"]),
  source: z.enum(["deterministic", "llm"]),
  /** Deterministic severe manipulation (hidden text, encoded payload, verifier-addressed text). */
  severe: z.boolean().optional(),
});
export type Flag = z.infer<typeof flagSchema>;

export const verificationSchema = z.object({
  results: z.array(criterionResultSchema).max(100),
  flags: z.array(flagSchema).max(100),
});
export type Verification = z.infer<typeof verificationSchema>;

export type SettlementOutcome = "FULL_CAPTURE" | "PARTIAL_CAPTURE" | "VOID" | "NEEDS_HUMAN";

export interface SettlementInput {
  price: Money;
  authorizedAmount: Money;
  criteria: Criterion[];
  results: CriterionResult[];
  flags: Flag[];
  injectionPolicy: "HUMAN_REVIEW" | "BLOCK";
  authorizationOk: boolean;
  partialAllowed: boolean;
}

export interface SettlementDecision {
  decision: SettlementOutcome;
  earned: number;
  amount: Money;
  reasons: string[];
}

const zero = () => new D(0);
const human = (earned: number, reasons: string[]): SettlementDecision => ({ decision: "NEEDS_HUMAN", earned, amount: zero(), reasons });

export function decideSettlement(i: SettlementInput): SettlementDecision {
  if (!i.authorizationOk) return human(0, ["AUTHORIZATION_NOT_VALID"]);
  if (i.authorizedAmount.lt(i.price)) return human(0, ["AUTHORIZED_AMOUNT_BELOW_PRICE"]);

  // Resolve each locked criterion to exactly one trusted status.
  const status = new Map<string, "met" | "not_met" | "unverifiable">();
  const srcOf = new Map<string, CriterionResult["source"]>();
  const reasons: string[] = [];
  for (const c of i.criteria) {
    const rs = i.results.filter((r) => r.criterionId === c.id);
    let s: "met" | "not_met" | "unverifiable" = "unverifiable";
    if (rs.length === 1) {
      const r = rs[0]!;
      const sourceOk = r.source === "human" || (c.type === "deterministic" ? r.source === "deterministic" : r.source === "verifier");
      if (sourceOk) {
        s = r.status;
        srcOf.set(c.id, r.source);
      }
      else reasons.push(`SOURCE_MISMATCH:${c.id}`);
    } else if (rs.length > 1) {
      reasons.push(`DUPLICATE_RESULT:${c.id}`);
    } else {
      reasons.push(`MISSING_RESULT:${c.id}`);
    }
    status.set(c.id, s);
  }
  // Results for criteria that are not in the locked terms are ignored (cannot add or alter criteria).
  const earned = i.criteria.reduce((sum, c) => (status.get(c.id) === "met" ? sum + c.weight : sum), 0);

  // 1. Contract failed on an objectively checkable required criterion -> VOID.
  const detFailed = i.criteria.filter((c) => c.type === "deterministic" && c.required && status.get(c.id) === "not_met");
  if (detFailed.length > 0) {
    return { decision: "VOID", earned, amount: zero(), reasons: detFailed.map((c) => `REQUIRED_DETERMINISTIC_FAILED:${c.id}`) };
  }
  // 1b. A required criterion a human confirmed as not met (only possible where machines could not decide) -> VOID,
  //     computed here by the engine; the human supplied a verdict, never an amount or a direct void.
  const humanFailed = i.criteria.filter((c) => c.required && status.get(c.id) === "not_met" && srcOf.get(c.id) === "human");
  if (humanFailed.length > 0) {
    return { decision: "VOID", earned, amount: zero(), reasons: humanFailed.map((c) => `REQUIRED_CRITERION_FAILED_BY_HUMAN_VERDICT:${c.id}`) };
  }
  // 2. Anything we cannot verify goes to a human.
  const unverifiable = i.criteria.filter((c) => status.get(c.id) === "unverifiable");
  if (unverifiable.length > 0) return human(earned, [...reasons, ...unverifiable.map((c) => `UNVERIFIABLE:${c.id}`)]);
  // 3. An LLM-only failure never voids.
  const llmFailed = i.criteria.filter((c) => c.type === "llm_judged" && c.required && status.get(c.id) === "not_met");
  if (llmFailed.length > 0) return human(earned, llmFailed.map((c) => `LLM_REQUIRED_NOT_MET:${c.id}`));
  // 4. Deterministic severe manipulation.
  if (i.flags.some((f) => f.source === "deterministic" && f.severe === true)) {
    return human(earned, [i.injectionPolicy === "BLOCK" ? "INJECTION_POLICY_BLOCK" : "DETERMINISTIC_MANIPULATION_FLAG"]);
  }
  // 5. Any HIGH flag escalates, never decides.
  if (i.flags.some((f) => f.severity === "HIGH")) return human(earned, ["HIGH_SEVERITY_FLAG"]);

  // 6. Amounts: only from pre-priced weights.
  if (earned === 100) return { decision: "FULL_CAPTURE", earned, amount: i.price, reasons: [] };

  if (earned >= MIN_PARTIAL) {
    if (!i.partialAllowed) return human(earned, ["PARTIAL_SETTLEMENT_NOT_AVAILABLE"]);
    const amount = proportion(i.price, earned);
    if (amount.lte(0)) return human(earned, ["PARTIAL_AMOUNT_ROUNDS_TO_ZERO"]);
    return { decision: "PARTIAL_CAPTURE", earned, amount, reasons: [`EARNED_${earned}_OF_100`] };
  }
  const allFailuresDeterministic = i.criteria.filter((c) => status.get(c.id) === "not_met").every((c) => c.type === "deterministic");
  if (allFailuresDeterministic) return { decision: "VOID", earned, amount: zero(), reasons: [`EARNED_BELOW_MINIMUM_${earned}`] };
  return human(earned, [`EARNED_BELOW_MINIMUM_UNDETERMINED_${earned}`]);
}
