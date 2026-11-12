import { describe, expect, it } from "vitest";
import { DEAL_STATES, IllegalTransitionError, TERMINAL_STATES, allowedFrom, assertTransition, canTransition, type DealState } from "@/domain/statemachine";

describe("deal state machine", () => {
  it("accepts every listed transition and rejects EVERY other pair", () => {
    let legal = 0;
    let illegal = 0;
    for (const from of DEAL_STATES) {
      for (const to of DEAL_STATES) {
        const listed = allowedFrom(from).includes(to);
        // NEEDS_HUMAN needs an origin; supply the one that makes the listed targets reachable
        const ctx = from === "NEEDS_HUMAN" ? { needsHumanFrom: (to === "SETTLING" ? "VERIFYING" : to === "SETTLEMENT_REVIEW" ? "SETTLEMENT_REVIEW" : "POLICY_CHECKED") as DealState } : {};
        if (listed) {
          expect(() => assertTransition(from, to, ctx), `${from}->${to}`).not.toThrow();
          legal++;
        } else {
          expect(() => assertTransition(from, to, ctx), `${from}->${to}`).toThrow(IllegalTransitionError);
          illegal++;
        }
      }
    }
    expect(legal).toBeGreaterThan(20);
    expect(illegal).toBeGreaterThan(300);
  });

  it("terminal states have no outgoing transitions (replays and revivals fail)", () => {
    for (const t of TERMINAL_STATES) {
      expect(allowedFrom(t)).toEqual([]);
      for (const to of DEAL_STATES) expect(canTransition(t, to)).toBe(false);
    }
  });

  it("settlement cannot be reached from AUTHORIZED / DELIVERED directly (verification cannot be skipped)", () => {
    expect(canTransition("AUTHORIZED", "SETTLING")).toBe(false);
    expect(canTransition("AWAITING_DELIVERY", "SETTLING")).toBe(false);
    expect(canTransition("DELIVERED", "SETTLING")).toBe(false);
    expect(canTransition("VERIFYING", "SETTLING")).toBe(true);
  });

  it("nothing reaches AUTHORIZED except via buyer approval", () => {
    const into = DEAL_STATES.filter((s) => allowedFrom(s).includes("AUTHORIZED"));
    expect(into).toEqual(["AWAITING_BUYER_APPROVAL"]);
  });

  it("a PayPal order cannot be created without passing policy", () => {
    const into = DEAL_STATES.filter((s) => allowedFrom(s).includes("ORDER_CREATED"));
    expect(into.sort()).toEqual(["NEEDS_HUMAN", "POLICY_CHECKED"]);
  });

  describe("NEEDS_HUMAN resolution depends on where the review was raised", () => {
    it("pre-authorization review: only ORDER_CREATED or BLOCKED", () => {
      const ctx = { needsHumanFrom: "POLICY_CHECKED" as const };
      expect(canTransition("NEEDS_HUMAN", "ORDER_CREATED", ctx)).toBe(true);
      expect(canTransition("NEEDS_HUMAN", "BLOCKED", ctx)).toBe(true);
      expect(canTransition("NEEDS_HUMAN", "SETTLING", ctx)).toBe(false);
    });
    it("post-authorization review: only SETTLING (amount is recomputed, never supplied)", () => {
      for (const origin of ["VERIFYING", "SETTLING", "SETTLEMENT_PENDING"] as const) {
        const ctx = { needsHumanFrom: origin };
        expect(canTransition("NEEDS_HUMAN", "SETTLING", ctx)).toBe(true);
        expect(canTransition("NEEDS_HUMAN", "ORDER_CREATED", ctx)).toBe(false);
        expect(canTransition("NEEDS_HUMAN", "BLOCKED", ctx)).toBe(false);
      }
    });
    it("a review with no recorded origin cannot be resolved", () => {
      expect(canTransition("NEEDS_HUMAN", "SETTLING")).toBe(false);
      expect(canTransition("NEEDS_HUMAN", "BLOCKED", { needsHumanFrom: null })).toBe(false);
    });
  });

  it("void and expiry paths exist before delivery, not after settlement", () => {
    expect(canTransition("AUTHORIZED", "VOIDED")).toBe(true);
    expect(canTransition("AWAITING_DELIVERY", "VOIDED")).toBe(true);
    expect(canTransition("AWAITING_BUYER_APPROVAL", "EXPIRED")).toBe(true);
    expect(canTransition("CAPTURED", "VOIDED")).toBe(false);
  });

  it("a pending capture can only resolve to captured or human review, never silently fail", () => {
    expect(allowedFrom("SETTLEMENT_PENDING").slice().sort()).toEqual(["CAPTURED", "NEEDS_HUMAN", "PARTIALLY_CAPTURED"]);
  });
});
