/** Payment-adjacent wording: the UI may claim an explicit acceptance only when the ledger recorded one, and must explain the challenge path and the expired-window rule. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { settlementBasis } from "../../src/paypal/lifecycle";

const accept = { type: "HUMAN_REVIEW_DECISION", payload: { phase: "POST_AUTH", decision: "accept", windowWas: "2026-11-09T22:09:56.185Z" } };
const challenge = { type: "STATE_TRANSITION", payload: { challenged: "c1", reason: "the second row looks wrong", evidenceRefs: ["delivery:d1"] } };
const humanReview = { type: "HUMAN_REVIEW_DECISION", payload: { phase: "POST_AUTH", decision: "approve" } };
const noise = [{ type: "PAYPAL_WRITE", payload: { type: "AUTHORIZE" } }, { type: "STATE_TRANSITION", payload: { to: "VERIFYING" } }];

describe("settlementBasis: never claims an acceptance the ledger does not hold", () => {
  it("a deal that settled because the window ended unused is described as the expired-window rule, with no acceptance", () => {
    const b = settlementBasis("CAPTURED", noise)!;
    expect(b.kind).toBe("WINDOW_EXPIRED");
    expect(b.text).toMatch(/expired-window rule/);
    expect(b.text).toMatch(/No explicit acceptance was recorded/);
    expect(b.text).not.toMatch(/you accepted/i);
  });
  it("an acceptance event is the only thing that produces the 'you accepted' wording, and it says acceptance did not set the amount", () => {
    const b = settlementBasis("CAPTURED", [...noise, accept])!;
    expect(b.kind).toBe("ACCEPTED");
    expect(b.text).toMatch(/after you accepted/);
    expect(b.text).toMatch(/not from the acceptance/);
    expect(b.text).not.toMatch(/No explicit acceptance/);
  });
  it("a review request is described as re-verification against the original terms, and still claims no acceptance unless one exists", () => {
    const b = settlementBasis("CAPTURED", [...noise, challenge])!;
    expect(b.kind).toBe("AFTER_REVIEW_REQUEST");
    expect(b.text).toMatch(/re-verified against the original locked terms/);
    expect(b.text).toMatch(/No explicit acceptance was recorded/);
    expect(settlementBasis("PARTIALLY_CAPTURED", [challenge, accept])!.text).not.toMatch(/No explicit acceptance/);
  });
  it("a human review decision is not presented as an acceptance", () => {
    const b = settlementBasis("CAPTURED", [humanReview])!;
    expect(b.kind).toBe("AFTER_HUMAN_REVIEW");
    expect(b.text).toMatch(/No explicit acceptance was recorded/);
  });
  it("only captured states get a basis; a pre-authorization decision or garbage payloads never produce an acceptance claim", () => {
    for (const s of ["VOIDED", "VERIFYING", "NEEDS_HUMAN", "SETTLEMENT_REVIEW", "AWAITING_DELIVERY", "FAILED"]) expect(settlementBasis(s, [accept])).toBeNull();
    expect(settlementBasis("CAPTURED", [{ type: "HUMAN_REVIEW_DECISION", payload: { phase: "PRE_AUTH", decision: "accept" } }])!.kind).toBe("WINDOW_EXPIRED");
    expect(settlementBasis("CAPTURED", [{ type: "X", payload: null }, { type: "HUMAN_REVIEW_DECISION" }, { type: "STATE_TRANSITION", payload: "str" }])!.kind).toBe("WINDOW_EXPIRED");
  });
});

describe("dashboard wording (source pins)", () => {
  const src = readFileSync(join(resolve(__dirname, "..", ".."), "src", "app", "ui", "dashboard.tsx"), "utf8");
  it("keeps the sentences the browser journeys key on and adds the three outcomes of the open window", () => {
    expect(src).toContain("You can accept now, or wait for the challenge window to end");
    expect(src).toMatch(/Accept now<\/b> only ends your own waiting period early/);
    expect(src).toMatch(/expired-window rule<\/b>\. That is not recorded as an acceptance/);
  });
  it("explains what a review request does afterwards: same delivery, original terms, no new amount, no restart, limits, and the timeout that never auto-pays or auto-voids", () => {
    for (const needle of ["re-verifies the same delivery against the original locked terms", "cannot change the terms or the amount", "the window is not restarted", "Up to 2 requests per deal, one per criterion", "within 72 hours", "nothing is captured or voided automatically"]) expect(src, needle).toContain(needle);
    expect(src).toContain('data-testid="review-in-progress"');
    expect(src).toContain('data-testid="settlement-basis"');
  });
  it("the PayPal card shows each operation's PayPal id, and the Buyer Agent chip is labelled as the setting for new deals (not a claim about an existing deal)", () => {
    const root = resolve(__dirname, "..", "..");
    expect(src).toContain("<th>PayPal id</th>");
    expect(src).toContain("Buyer Agent for new deals");
    expect(readFileSync(join(root, "src", "app", "api", "deals", "[id]", "route.ts"), "utf8")).toContain("resourceId: o.paypalResourceId");
    // PayPal's authorize response names the ORDER as its resource, so the stored operation id of an AUTHORIZE is the order id: the UI must show the deal's authorization id there instead
    expect(src).toContain('o.type === "AUTHORIZE" ? d.paypalAuthId : o.resourceId');
    expect(readFileSync(join(root, "src", "lib", "views.ts"), "utf8")).toContain("paypalAuthId: d.paypalAuthId");
  });
  it("the engine constants quoted in the wording are the real ones", () => {
    const engine = readFileSync(join(resolve(__dirname, "..", ".."), "src", "settlement", "engine.ts"), "utf8");
    expect(engine).toMatch(/MAX_CHALLENGES = 2;/);
    expect(engine).toMatch(/reviewTimeoutMs: 72 \* 60 \* 60_000/);
  });
});
