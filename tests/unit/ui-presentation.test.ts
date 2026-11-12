import { describe, expect, it } from "vitest";
import { actorLabel, challengeWindowView, formatInstant, formatRemaining, ledgerLine, plainState, protectionFacts, reasonText, workflowStages, type WorkflowInput } from "@/app/ui/presentation";

const status = (i: WorkflowInput) => Object.fromEntries(workflowStages(i).map((s) => [s.key, s.status]));
const OK = { sealVerified: true };

describe("ledgerLine: raw event names become plain language", () => {
  it("translates the examples named in the brief", () => {
    expect(ledgerLine("STATE_TRANSITION", { from: "AWAITING_BUYER_APPROVAL", to: "AUTHORIZED" }).title).toBe("Payment authorized");
    expect(ledgerLine("STATE_TRANSITION", { from: "SETTLING", to: "CAPTURED" }).title).toBe("Payment capture completed");
    expect(ledgerLine("STATE_TRANSITION", { from: "DELIVERED", to: "VERIFYING" }).title).toMatch(/Delivery requirements passed/);
  });

  it("never claims more than the event says: an authorization is a hold, not a capture", () => {
    const a = ledgerLine("STATE_TRANSITION", { to: "AUTHORIZED" });
    expect(a.detail).toMatch(/Nothing has been captured/);
    expect(ledgerLine("STATE_TRANSITION", { to: "ORDER_CREATED" }).detail).toMatch(/no funds are held/);
  });

  it("describes the buyer's own decisions by who made them and when", () => {
    expect(ledgerLine("HUMAN_REVIEW_DECISION", { phase: "POST_AUTH", decision: "accept" }).title).toBe("You accepted the delivery");
    expect(ledgerLine("HUMAN_REVIEW_DECISION", { phase: "PRE_AUTH", decision: "approve" }).title).toBe("You approved the price");
    expect(ledgerLine("HUMAN_REVIEW_DECISION", { phase: "PRE_AUTH", decision: "reject" }).tone).toBe("bad");
    // a decision shape we do not know is still described, not dropped
    expect(ledgerLine("HUMAN_REVIEW_DECISION", { phase: "POST_AUTH", decision: "retry" }).title).toBe("A human review decision was recorded");
  });

  it("recognises a review request carried on a state transition", () => {
    const l = ledgerLine("STATE_TRANSITION", { from: "VERIFYING", to: "SETTLEMENT_REVIEW", challenged: "dupes" });
    expect(l.title).toBe("Review requested for one criterion");
    expect(l.detail).toContain("dupes");
  });

  it("falls back to a readable name for unknown or future event types and unreadable payloads", () => {
    expect(ledgerLine("SOMETHING_NEW_HAPPENED").title).toBe("Something new happened");
    expect(ledgerLine("STATE_TRANSITION", null).title).toBe("Deal state changed");
    expect(ledgerLine("STATE_TRANSITION", { to: "NOT_A_STATE" }).title).toBe("Deal is now not a state");
    expect(ledgerLine("STATE_TRANSITION", "text").title).toBe("Deal state changed");
    expect(ledgerLine("STATE_TRANSITION", [1, 2]).title).toBe("Deal state changed");
  });

  it("marks the engine's own decision as computed by code", () => {
    expect(ledgerLine("SETTLEMENT_DECIDED", {}).detail).toMatch(/not by a model/);
  });

  it("gives every state the machine can reach a plain name", () => {
    for (const s of ["PROPOSED", "NEGOTIATING", "TERMS_LOCKED", "POLICY_CHECKED", "BLOCKED", "NEEDS_HUMAN", "ORDER_CREATED", "AWAITING_BUYER_APPROVAL", "AUTHORIZED", "AWAITING_DELIVERY", "DELIVERED", "VERIFYING", "SETTLEMENT_REVIEW", "SETTLING", "SETTLEMENT_PENDING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "EXPIRED", "FAILED"]) {
      expect(ledgerLine("STATE_TRANSITION", { to: s }).title.length).toBeGreaterThan(3);
      expect(plainState(s)).not.toContain("_");
    }
  });
});

describe("actorLabel", () => {
  it("shows the buyer's own actions as 'you' with the account, and any other actor exactly as recorded", () => {
    expect(actorLabel("human:owner@example.com")).toBe("you (owner@example.com)");
    expect(actorLabel("system")).toBe("system");
    expect(actorLabel("seller:seller-sim")).toBe("seller:seller-sim");
    expect(actorLabel("")).toBe("");
  });
});

describe("reasonText", () => {
  it("replaces a bare dash with a statement", () => {
    expect(reasonText([])).toBe("no exceptions recorded");
    expect(reasonText(undefined)).toBe("no exceptions recorded");
    expect(reasonText(null)).toBe("no exceptions recorded");
  });
  it("explains known codes and still shows unknown ones", () => {
    expect(reasonText(["WINDOW_EXPIRED"])).toMatch(/challenge window ended/);
    expect(reasonText(["SOME_NEW_CODE", "REQUIRED_FAILED"])).toBe("some new code; a required criterion failed");
  });
});

describe("workflowStages: never ahead of the recorded state", () => {
  it("no mandate: only the first stage is current", () => {
    expect(status({ mandate: null, hasDelivery: false })).toEqual({ authority: "current", negotiation: "pending", agreement: "pending", delivery: "pending", settlement: "pending" });
  });

  it("a verified mandate and no deal: authority done, negotiation waiting to start (not started)", () => {
    expect(status({ mandate: OK, hasDelivery: false })).toEqual({ authority: "done", negotiation: "current", agreement: "pending", delivery: "pending", settlement: "pending" });
  });

  it("a mandate whose seal does not verify is a failure, never shown as done", () => {
    expect(status({ mandate: { sealVerified: false }, hasDelivery: false }).authority).toBe("failed");
  });

  it("while negotiating: negotiation current, nothing after it started", () => {
    expect(status({ mandate: OK, deal: { state: "NEGOTIATING" }, hasDelivery: false })).toEqual({ authority: "done", negotiation: "current", agreement: "pending", delivery: "pending", settlement: "pending" });
  });

  it("negotiation that ended without terms is a visible failure and later stages stay pending", () => {
    const s = status({ mandate: OK, deal: { state: "BLOCKED", termsHash: null }, hasDelivery: false });
    expect(s).toEqual({ authority: "done", negotiation: "failed", agreement: "pending", delivery: "pending", settlement: "pending" });
  });

  it("terms locked but not yet policy-checked: agreement is current, not done", () => {
    expect(status({ mandate: OK, deal: { state: "TERMS_LOCKED", termsHash: "h" }, hasDelivery: false })).toMatchObject({ negotiation: "done", agreement: "current", delivery: "pending", settlement: "pending" });
  });

  it("price above the human threshold: agreement needs attention before any order exists", () => {
    expect(status({ mandate: OK, deal: { state: "NEEDS_HUMAN", termsHash: "h" }, hasDelivery: false })).toMatchObject({ negotiation: "done", agreement: "attention", delivery: "pending" });
  });

  it("blocked after terms: agreement failed, delivery and settlement untouched", () => {
    expect(status({ mandate: OK, deal: { state: "BLOCKED", termsHash: "h" }, hasDelivery: false })).toMatchObject({ negotiation: "done", agreement: "failed", delivery: "pending", settlement: "pending" });
  });

  it("authorized and waiting for delivery: delivery is current, settlement still pending", () => {
    expect(status({ mandate: OK, deal: { state: "AWAITING_DELIVERY", termsHash: "h" }, hasDelivery: false })).toEqual({ authority: "done", negotiation: "done", agreement: "done", delivery: "current", settlement: "pending" });
  });

  it("payment not yet authorized: delivery is not offered as current", () => {
    expect(status({ mandate: OK, deal: { state: "AWAITING_BUYER_APPROVAL", termsHash: "h" }, hasDelivery: false })).toMatchObject({ agreement: "done", delivery: "pending", settlement: "pending" });
  });

  it("passed verification in the challenge window: delivery done, settlement current but not done", () => {
    expect(status({ mandate: OK, deal: { state: "VERIFYING", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED" })).toEqual({ authority: "done", negotiation: "done", agreement: "done", delivery: "done", settlement: "current" });
  });

  it("failed required criterion: delivery failed, never shown as verified", () => {
    expect(status({ mandate: OK, deal: { state: "SETTLING", termsHash: "h" }, hasDelivery: true, verificationOverall: "REQUIRED_FAILED" }).delivery).toBe("failed");
  });

  it("a flagged delivery is not shown as verified even if every required criterion passed", () => {
    const s = status({ mandate: OK, deal: { state: "NEEDS_HUMAN", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED", verificationFlagged: true });
    expect(s.delivery).toBe("attention");
    expect(s.settlement).toBe("attention");
  });

  it("regression: a flagged delivery waiting for a human still shows the agreement as locked (seen on the mobile journey screenshot)", () => {
    const s = status({ mandate: OK, deal: { state: "NEEDS_HUMAN", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED", verificationFlagged: true });
    expect(s).toEqual({ authority: "done", negotiation: "done", agreement: "done", delivery: "attention", settlement: "attention" });
  });

  it("an unverifiable required criterion needs attention", () => {
    expect(status({ mandate: OK, deal: { state: "NEEDS_HUMAN", termsHash: "h" }, hasDelivery: true, verificationOverall: "REQUIRED_UNVERIFIABLE" }).delivery).toBe("attention");
  });

  it("settlement is done only when a settlement record exists", () => {
    const captured = status({ mandate: OK, deal: { state: "CAPTURED", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED", settlement: { decision: "CAPTURE_FULL" } });
    expect(captured).toEqual({ authority: "done", negotiation: "done", agreement: "done", delivery: "done", settlement: "done" });
    // terminal state but no settlement record: not claimed
    expect(status({ mandate: OK, deal: { state: "VOIDED", termsHash: "h" }, hasDelivery: false }).settlement).toBe("pending");
  });

  it("a pending capture is a recorded decision, and the note says PayPal has not confirmed", () => {
    const stages = workflowStages({ mandate: OK, deal: { state: "SETTLEMENT_PENDING", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED", settlement: { decision: "CAPTURE_FULL" } });
    expect(stages[4]!.status).toBe("done");
    expect(stages[4]!.note).toMatch(/waiting for PayPal to confirm/);
  });

  it("a review request pauses settlement and says so", () => {
    const stages = workflowStages({ mandate: OK, deal: { state: "SETTLEMENT_REVIEW", termsHash: "h" }, hasDelivery: true, verificationOverall: "ALL_REQUIRED_PASSED" });
    expect(stages[4]!).toMatchObject({ status: "current", note: "Paused for your review request" });
  });

  it("an expired authorization never claims a settlement stage", () => {
    expect(status({ mandate: OK, deal: { state: "EXPIRED", termsHash: "h" }, hasDelivery: false }).settlement).toBe("pending");
  });

  it("every stage always has a label and a note (nothing renders blank)", () => {
    for (const state of ["PROPOSED", "NEGOTIATING", "TERMS_LOCKED", "POLICY_CHECKED", "BLOCKED", "NEEDS_HUMAN", "ORDER_CREATED", "AWAITING_BUYER_APPROVAL", "AUTHORIZED", "AWAITING_DELIVERY", "DELIVERED", "VERIFYING", "SETTLEMENT_REVIEW", "SETTLING", "SETTLEMENT_PENDING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "EXPIRED", "FAILED"]) {
      for (const stage of workflowStages({ mandate: OK, deal: { state, termsHash: "h" }, hasDelivery: false })) {
        expect(stage.label.length).toBeGreaterThan(3);
        expect(stage.note.length).toBeGreaterThan(3);
      }
    }
  });
});

describe("challengeWindowView: only what the recorded timestamps support", () => {
  const start = "2026-11-11T10:00:00.000Z";
  const end = "2026-11-11T10:15:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("open: shows the time left, computed from the server's clock", () => {
    const v = challengeWindowView({ state: "VERIFYING", endsAt: end, startedAt: start, serverNowMs: at("2026-11-11T10:02:55.000Z") })!;
    expect(v.phase).toBe("open");
    expect(v.remainingMs).toBe(12 * 60_000 + 5_000);
    expect(v.headline).toContain("12m 05s");
    expect(v.startedAt).toBe(start);
    expect(v.endsAt).toBe(end);
  });

  it("does not promise action at the exact second the window ends", () => {
    const v = challengeWindowView({ state: "VERIFYING", endsAt: end, startedAt: start, serverNowMs: at(start) })!;
    expect(v.note).toMatch(/not at the exact second/);
  });

  it("expired: says the window ended and that settlement waits for the next server check", () => {
    const v = challengeWindowView({ state: "VERIFYING", endsAt: end, startedAt: start, serverNowMs: at("2026-11-11T10:15:00.000Z") })!;
    expect(v.phase).toBe("expired");
    expect(v.remainingMs).toBeNull();
    expect(v.note).toMatch(/next time the server checks/);
    expect(v.note).toMatch(/Nothing happens automatically/);
  });

  it("an expired window never shows a negative or zero countdown", () => {
    const v = challengeWindowView({ state: "VERIFYING", endsAt: end, serverNowMs: at("2027-01-01T00:00:00.000Z") })!;
    expect(v.remainingMs).toBeNull();
    expect(v.headline).not.toMatch(/left/);
    expect(formatRemaining(-5000)).toBe("0s");
  });

  it("paused for review: no countdown, mentions the 72 hour rule, never says it will capture or void", () => {
    const v = challengeWindowView({ state: "SETTLEMENT_REVIEW", endsAt: null, reviewDeadline: "2026-11-14T10:00:00.000Z", serverNowMs: at(start) })!;
    expect(v.phase).toBe("paused");
    expect(v.remainingMs).toBeNull();
    expect(v.note).toMatch(/nothing is captured or voided automatically/);
    expect(challengeWindowView({ state: "SETTLEMENT_REVIEW", endsAt: null, serverNowMs: at(start) })!.note).toMatch(/72 hours/);
  });

  it("after settlement it is shown as closed, and an early acceptance is named as such", () => {
    expect(challengeWindowView({ state: "CAPTURED", endsAt: end, startedAt: start, serverNowMs: at(end) })!.headline).toBe("Challenge window closed");
    const early = challengeWindowView({ state: "CAPTURED", endsAt: end, startedAt: start, serverNowMs: at(end), acceptedEarly: true })!;
    expect(early.headline).toMatch(/closed early because you accepted/);
  });

  it("returns nothing when there is no authoritative timestamp or no verified delivery yet", () => {
    expect(challengeWindowView({ state: "VERIFYING", endsAt: null, serverNowMs: 0 })).toBeNull();
    expect(challengeWindowView({ state: "VERIFYING", endsAt: "not a date", serverNowMs: 0 })).toBeNull();
    expect(challengeWindowView({ state: "AWAITING_DELIVERY", endsAt: end, serverNowMs: 0 })).toBeNull();
    expect(challengeWindowView({ state: "NEGOTIATING", endsAt: null, serverNowMs: 0 })).toBeNull();
  });
});

describe("formatting", () => {
  it("formatRemaining", () => {
    expect(formatRemaining(0)).toBe("0s");
    expect(formatRemaining(45_000)).toBe("45s");
    expect(formatRemaining(125_000)).toBe("2m 05s");
    expect(formatRemaining(3 * 3600_000 + 125_000)).toBe("3h 02m");
  });

  it("formatInstant shows the time zone and the exact UTC instant, and rejects garbage", () => {
    const f = formatInstant("2026-11-11T10:15:00.000Z", "en-US")!;
    expect(f.utc).toBe("2026-11-11T10:15:00.000Z");
    expect(f.local).toMatch(/2026/);
    expect(f.local).toMatch(/[A-Z]{2,5}|GMT/); // a zone name is present
    expect(formatInstant(null)).toBeNull();
    expect(formatInstant("")).toBeNull();
    expect(formatInstant("nope")).toBeNull();
  });
});

describe("protectionFacts: reasons come from the deal's own values", () => {
  const terms = { price: "20.00", criteria: [{ type: "deterministic", required: true }, { type: "deterministic", required: true }, { type: "deterministic", required: false }] };
  it("a normal deal shows four confirmed facts", () => {
    const f = protectionFacts({ mandate: { perDealMax: "60.00", sealVerified: true }, termsHash: "abc", terms });
    expect(f).toHaveLength(4);
    expect(f.every((x) => x.ok)).toBe(true);
    expect(f[0]!.text).toContain("$20.00");
    expect(f[0]!.text).toContain("$60.00");
    expect(f[3]!.text).toMatch(/3 locked criteria \(2 required\) by deterministic code/);
  });
  it("a price above the limit is shown as a problem, not hidden", () => {
    const f = protectionFacts({ mandate: { perDealMax: "15.00", sealVerified: true }, termsHash: "abc", terms });
    expect(f[0]!.ok).toBe(false);
    expect(f[0]!.text).toMatch(/ABOVE your per-deal limit/);
  });
  it("an unverified seal is shown as a problem", () => {
    const f = protectionFacts({ mandate: { perDealMax: "60.00", sealVerified: false } });
    expect(f).toEqual([{ ok: false, text: expect.stringMatching(/did NOT verify/) }]);
  });
  it("claims nothing before there is data: no mandate and no terms means no facts", () => {
    expect(protectionFacts({})).toEqual([]);
    expect(protectionFacts({ mandate: null, termsHash: null, terms: null })).toEqual([]);
  });
  it("no locked-hash line without a hash, and non-deterministic criteria are not called deterministic", () => {
    expect(protectionFacts({ mandate: { perDealMax: "60.00", sealVerified: true }, terms }).some((x) => /locked under a hash/.test(x.text))).toBe(false);
    const mixed = protectionFacts({ termsHash: "h", terms: { price: "5.00", criteria: [{ type: "deterministic", required: true }, { type: "qualitative", required: false }] } });
    expect(mixed.at(-1)).toMatchObject({ ok: false });
  });
  it("garbage price values do not produce a price line", () => {
    expect(protectionFacts({ mandate: { perDealMax: "x", sealVerified: true }, terms: { price: "20.00", criteria: [] } }).some((x) => /per-deal limit/.test(x.text))).toBe(false);
  });
});
