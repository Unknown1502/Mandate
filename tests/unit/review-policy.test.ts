/** Unit-tested: SETTLEMENT_REVIEW transitions and the human-verdict rule of the pure decision. */
import { describe, expect, it } from "vitest";
import { DEAL_STATES, allowedFrom, canTransition, type DealState } from "@/domain/statemachine";
import { D } from "@/domain/money";
import { decideSettlement, type CriterionResult, type SettlementInput } from "@/domain/settlement";
import type { Criterion } from "@/domain/terms";

describe("SETTLEMENT_REVIEW state", () => {
  it("is entered only from VERIFYING (a challenge) or from NEEDS_HUMAN with a review origin", () => {
    const into = DEAL_STATES.filter((s) => allowedFrom(s).includes("SETTLEMENT_REVIEW")).sort();
    expect(into).toEqual(["NEEDS_HUMAN", "VERIFYING"]);
    for (const origin of ["POLICY_CHECKED", "VERIFYING", "SETTLING", "SETTLEMENT_PENDING"] as DealState[]) {
      expect(canTransition("NEEDS_HUMAN", "SETTLEMENT_REVIEW", { needsHumanFrom: origin })).toBe(false);
    }
    expect(canTransition("NEEDS_HUMAN", "SETTLEMENT_REVIEW", { needsHumanFrom: "SETTLEMENT_REVIEW" })).toBe(true);
  });
  it("can only go back to VERIFYING (re-verification) or to NEEDS_HUMAN (timeout): never to capture, void or settling", () => {
    expect(allowedFrom("SETTLEMENT_REVIEW").slice().sort()).toEqual(["NEEDS_HUMAN", "VERIFYING"]);
    for (const to of ["SETTLING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "SETTLEMENT_PENDING", "FAILED", "BLOCKED", "EXPIRED"] as DealState[]) {
      expect(canTransition("SETTLEMENT_REVIEW", to)).toBe(false);
    }
  });
  it("a review that timed out resolves only back into the review, never into settlement or a pre-auth path", () => {
    const ctx = { needsHumanFrom: "SETTLEMENT_REVIEW" as DealState };
    expect(canTransition("NEEDS_HUMAN", "SETTLING", ctx)).toBe(false);
    expect(canTransition("NEEDS_HUMAN", "ORDER_CREATED", ctx)).toBe(false);
    expect(canTransition("NEEDS_HUMAN", "BLOCKED", ctx)).toBe(false);
  });
  it("no state outside VERIFYING can enter SETTLING from a review", () => {
    expect(DEAL_STATES.filter((s) => allowedFrom(s).includes("SETTLING")).sort()).toEqual(["NEEDS_HUMAN", "VERIFYING"]);
  });
});

const det = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "deterministic", validator: "no_duplicate_rows", params: {}, required, weight });
const llm = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "llm_judged", required, weight });
const r = (criterionId: string, status: CriterionResult["status"], source: CriterionResult["source"]): CriterionResult => ({ criterionId, status, source });
const base = (over: Partial<SettlementInput>): SettlementInput => ({
  price: new D("20.00"),
  authorizedAmount: new D("20.00"),
  criteria: [det("a", 50, true), llm("q", 50, true)],
  results: [],
  flags: [],
  injectionPolicy: "HUMAN_REVIEW",
  authorizationOk: true,
  partialAllowed: false,
  ...over,
});

describe("human verdicts in the pure decision", () => {
  it("a HUMAN verdict of not_met on a required criterion -> the engine computes VOID", () => {
    const d = decideSettlement(base({ results: [r("a", "met", "deterministic"), r("q", "not_met", "human")] }));
    expect(d).toMatchObject({ decision: "VOID", reasons: ["REQUIRED_CRITERION_FAILED_BY_HUMAN_VERDICT:q"] });
    expect(d.amount.isZero()).toBe(true);
  });
  it("the SAME failure asserted only by a verifier (AI) never voids: NEEDS_HUMAN", () => {
    expect(decideSettlement(base({ results: [r("a", "met", "deterministic"), r("q", "not_met", "verifier")] })).decision).toBe("NEEDS_HUMAN");
  });
  it("a human 'met' verdict completes the criteria and pays by weights, not by anything the human typed", () => {
    const d = decideSettlement(base({ results: [r("a", "met", "deterministic"), r("q", "met", "human")] }));
    expect(d).toMatchObject({ decision: "FULL_CAPTURE", earned: 100 });
    expect(d.amount.toFixed(2)).toBe("20.00");
  });
  it("AI-only HIGH flags never void, even combined with a verifier failure", () => {
    const d = decideSettlement(base({ results: [r("a", "met", "deterministic"), r("q", "not_met", "verifier")], flags: [{ code: "X", severity: "HIGH", source: "llm" }] }));
    expect(d.decision).toBe("NEEDS_HUMAN");
  });
});
