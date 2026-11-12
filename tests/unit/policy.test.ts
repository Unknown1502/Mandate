import { describe, expect, it } from "vitest";
import { D } from "@/domain/money";
import { evaluatePolicy, type PolicyInput } from "@/domain/policy";
import { termsHash } from "@/domain/terms";
import type { MandateDocument } from "@/domain/mandate";
import { goodTerms } from "./helpers";

const doc: MandateDocument = {
  principalId: "p1",
  currency: "USD",
  budgetTotal: "100.00",
  perDealMax: "40.00",
  requireHumanAbove: "30.00",
  allowedTaskTypes: ["data_cleaning"],
  counterparties: ["seller-sim"],
  injectionPolicy: "HUMAN_REVIEW",
  allowPartialSettlement: false,
  allowPreDeliveryCancellation: true,
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const terms = goodTerms();

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  mandate: doc,
  mandateId: "m1",
  revokedAt: null,
  terms,
  lockedTermsHash: termsHash(terms),
  committed: new D(0),
  now: new Date("2026-11-05T00:00:00Z"),
  rounds: 2,
  maxRounds: 4,
  ...over,
});

describe("policy engine (one test per check, pass and fail)", () => {
  it("OK for a compliant deal", () => {
    expect(evaluatePolicy(base())).toEqual({ outcome: "OK", reasons: [] });
  });
  it("1 seal: invalid seal blocks", () => {
    expect(evaluatePolicy(base({ mandate: null }))).toEqual({ outcome: "BLOCKED", reasons: ["MANDATE_SEAL_INVALID"] });
  });
  it("1 expiry", () => {
    expect(evaluatePolicy(base({ now: new Date("2031-01-01T00:00:00Z") })).reasons).toContain("MANDATE_EXPIRED");
  });
  it("1 revoked", () => {
    expect(evaluatePolicy(base({ revokedAt: new Date() })).reasons).toContain("MANDATE_REVOKED");
  });
  it("2 currency", () => {
    const r = evaluatePolicy(base({ terms: { ...terms, currency: "EUR" } }));
    expect(r.outcome).toBe("BLOCKED");
  });
  it("3 price over per-deal max (boundary: equal passes, +0.01 blocks)", () => {
    const eq = goodTerms({ price: "40.00" });
    expect(evaluatePolicy(base({ terms: eq, lockedTermsHash: termsHash(eq), mandate: { ...doc, requireHumanAbove: null } })).outcome).toBe("OK");
    const over = goodTerms({ price: "40.01" });
    expect(evaluatePolicy(base({ terms: over, lockedTermsHash: termsHash(over) })).reasons).toContain("PRICE_OVER_PER_DEAL_MAX");
  });
  it("4 budget: committed + price must not exceed budget (boundary)", () => {
    expect(evaluatePolicy(base({ committed: new D("80.00") })).outcome).toBe("OK");
    expect(evaluatePolicy(base({ committed: new D("80.01") })).reasons).toContain("BUDGET_EXCEEDED");
  });
  it("5 task type and counterparty allowlists", () => {
    expect(evaluatePolicy(base({ mandate: { ...doc, allowedTaskTypes: [] } })).reasons).toContain("TASK_TYPE_NOT_ALLOWED");
    const other = goodTerms({ sellerId: "stranger" });
    expect(evaluatePolicy(base({ terms: other, lockedTermsHash: termsHash(other) })).reasons).toContain("COUNTERPARTY_NOT_ALLOWED");
  });
  it("6 criteria weights / required / duplicates", () => {
    const w = goodTerms();
    w.criteria[0]!.weight = 60;
    expect(evaluatePolicy(base({ terms: w, lockedTermsHash: termsHash(w) })).reasons).toContain("CRITERIA_WEIGHTS_NOT_100");
    const r = goodTerms();
    r.criteria.forEach((c) => (c.required = false));
    expect(evaluatePolicy(base({ terms: r, lockedTermsHash: termsHash(r) })).reasons).toContain("CRITERIA_NO_REQUIRED");
  });
  it("7 terms drift after lock is blocked (price, criteria)", () => {
    expect(evaluatePolicy(base({ terms: { ...terms, price: "21.00" } })).reasons).toContain("TERMS_DRIFT");
    const c = structuredClone(terms);
    c.criteria[2]!.text = "changed";
    expect(evaluatePolicy(base({ terms: c })).reasons).toContain("TERMS_DRIFT");
  });
  it("7b terms for a different mandate are rejected", () => {
    const t = goodTerms({ mandateId: "other" });
    expect(evaluatePolicy(base({ terms: t, lockedTermsHash: termsHash(t) })).outcome).toBe("BLOCKED");
  });
  it("8 price above human threshold -> NEEDS_HUMAN (and only that)", () => {
    const t = goodTerms({ price: "35.00" });
    expect(evaluatePolicy(base({ terms: t, lockedTermsHash: termsHash(t) }))).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["PRICE_ABOVE_HUMAN_THRESHOLD"] });
  });
  it("8b a blocking reason wins over the human threshold", () => {
    const t = goodTerms({ price: "35.00" });
    const r = evaluatePolicy(base({ terms: t, lockedTermsHash: termsHash(t), committed: new D("90.00") }));
    expect(r.outcome).toBe("BLOCKED");
  });
  it("9 negotiation rounds", () => {
    expect(evaluatePolicy(base({ rounds: 4 })).outcome).toBe("OK");
    expect(evaluatePolicy(base({ rounds: 5 })).reasons).toContain("ROUNDS_EXCEEDED");
  });
  it("deadline must be in the future and not beyond mandate expiry", () => {
    const past = goodTerms({ deadline: "2026-01-01T00:00:00.000Z" });
    expect(evaluatePolicy(base({ terms: past, lockedTermsHash: termsHash(past) })).reasons).toContain("DEADLINE_INVALID");
    const beyond = goodTerms({ deadline: "2031-01-01T00:00:00.000Z" });
    expect(evaluatePolicy(base({ terms: beyond, lockedTermsHash: termsHash(beyond) })).reasons).toContain("DEADLINE_INVALID");
  });
  it("garbage terms are blocked, never crash", () => {
    expect(evaluatePolicy(base({ terms: null })).outcome).toBe("BLOCKED");
    expect(evaluatePolicy(base({ terms: { price: 5 } })).outcome).toBe("BLOCKED");
  });
  it("reports all failing reasons, not just the first", () => {
    const r = evaluatePolicy(base({ revokedAt: new Date(), committed: new D("99.00"), rounds: 9 }));
    expect(r.reasons).toEqual(expect.arrayContaining(["MANDATE_REVOKED", "BUDGET_EXCEEDED", "ROUNDS_EXCEEDED"]));
  });
});
