/**
 * Attack Lab types. The Lab runs the REAL pipeline (real PostgreSQL, real domain/orchestration/verification/engine code) against a
 * MOCK PayPal and a SCRIPTED (or absent) AI. Nothing here is evidence about real PayPal or a real LLM, and every report says so.
 */
import type { BuyerBrain } from "../src/agents/buyer";
import type { LlmProvider } from "../src/agents/llm";
import type { Criterion } from "../src/domain/terms";

export type Category =
  | "HONEST"
  | "LAZY"
  | "INJECTION"
  | "EXFIL"
  | "TERMS_DRIFT"
  | "PRESSURE"
  | "HIDDEN"
  | "STATE_REPLAY"
  | "FAKE_DELIVERY"
  | "MANDATE_TAMPER"
  | "EVIDENCE_FORGERY"
  | "AI_ONLY_SIGNAL"
  | "POLICY_BYPASS";

/** none = deterministic only; scripted = a scripted provider behaving well; scripted-obedient = a scripted provider that OBEYS the attacker. NEVER a real LLM. */
export type AiMode = "none" | "scripted" | "scripted-obedient";
export type CaseKind = "honest" | "lazy" | "attack";

export type MoneyOutcome = "NONE" | "CAPTURE_FULL" | "CAPTURE_PARTIAL" | "VOID";
export interface Expected {
  finalState: string;
  money: MoneyOutcome;
  /** captured amount for CAPTURE_* (USD, 2dp) */
  amount?: string;
}

export interface AttackCase {
  id: string;
  category: Category;
  kind: CaseKind;
  title: string;
  /** docs/05 = a case named in docs/05 §5.2; invented = added from reading our own design (docs/05 asks for 5-10) */
  source: "docs/05" | "invented";
  attackGoal: string;
  ai: AiMode;
  /** acceptable outcomes, derived from the POLICY (docs/04, docs/10-12), never from observed behaviour. First = primary. */
  expected: Expected[];
  /** skeptic codes the case hopes to see flagged. Detection is measured SEPARATELY from containment. */
  expectFlags?: string[];
  /** an honestly documented limitation that explains a missed detection expectation */
  knownGap?: string;
  /** a case that deliberately edits the ledger (so a broken chain is the attack, not a bypass) */
  tampersLedger?: boolean;
  /** settlement reason codes that MUST appear on the NEEDS_HUMAN transition (the audit trail is part of the policy-defined outcome) */
  expectReasons?: string[];
  /** scripted stand-ins, built fresh for every run. A real LLM is never used. */
  scripted?: () => { verifier?: LlmProvider; skeptic?: LlmProvider; buyer?: BuyerBrain };
  world?: {
    sellerMode?: "honest" | "adversarial" | "greedy" | "tamper";
    mandate?: Record<string, unknown>;
    criteria?: Criterion[];
    window?: number;
    partial?: boolean;
    /** deployment language policy for this world (docs/14 §14.20); default: English/French/Chinese, criterion scope */
    language?: Partial<import("../src/verification/language").LanguagePolicy>;
    /** prescan processing limits; clockStepMs makes the wall-clock deadline deterministic (every look at the clock advances it by this many ms) */
    prescanBudget?: { maxUnits?: number; deadlineMs?: number; clockStepMs?: number };
  };
  run(env: import("./harness").CaseEnv): Promise<void>;
  /** extra case-specific violations of the form "<what the attacker achieved>"; any entry means the attack SUCCEEDED */
  check?(env: import("./harness").CaseEnv, facts: Facts): Promise<string[]>;
}

export interface MoneyOp {
  type: "CAPTURE" | "VOID";
  requestId: string;
  amount?: string;
}

export interface Facts {
  dealId: string | null;
  state: string;
  capturedAmount: string | null;
  lockedPrice: string | null;
  lockedTermsHash: string | null;
  currentTermsHash: string | null;
  moneyOps: MoneyOp[];
  paypalWriteTypes: string[];
  /** violations found by the independent ledger audit */
  ledgerViolations: string[];
  /** secrets / mandate details found in anything the seller could see */
  disclosures: string[];
  flagsSeen: string[];
  humanActions: number;
  needsHumanEver: boolean;
  halted: string[];
  deliveryRefusals: string[];
  /** what the orchestrator answered to each delivery the case submitted (status:reason), e.g. DONE, REFUSED:<code>, HALTED:<reason>, IN_PROGRESS */
  deliveryOutcomes: string[];
  /** reason codes recorded on the first transition to NEEDS_HUMAN (empty if the deal never went there) */
  needsHumanReasons: string[];
  latencyMs: number | null;
  caseViolations: string[];
}

export interface Verdict {
  /** the attacker did not achieve any of the docs/05 §5.1 goals (always computed, reported for attack cases) */
  contained: boolean;
  attackViolations: string[];
  outcomeCorrect: boolean;
  matchedExpectation: number | null;
  incorrectSettlement: boolean;
  needsHuman: boolean;
  /** honest cases: captured in full with no human involvement */
  completedHonestly: boolean;
  /** honest cases: not captured in full */
  falsePositive: boolean;
  detection: "NOT_EXPECTED" | "DETECTED" | "MISSED";
}

export interface RunRecord {
  caseId: string;
  category: Category;
  kind: CaseKind;
  ai: AiMode;
  run: number;
  facts: Facts;
  verdict: Verdict;
  error?: string;
}
