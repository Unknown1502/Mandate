/** Pure wording for the PayPal side of a deal (shared by the dashboard and its tests). No imports: safe for the browser bundle. */

/**
 * WHY a settled deal was paid, derived only from what the audit ledger recorded. An explicit acceptance is claimed only when an acceptance event exists; a deal that settled
 * because the challenge window ended unused says so and says no acceptance was recorded. Used for captured deals only (a void is explained by its own settlement reasons).
 */
export function settlementBasis(state: string, events: { type: string; payload?: unknown }[]): { kind: "ACCEPTED" | "AFTER_REVIEW_REQUEST" | "AFTER_HUMAN_REVIEW" | "WINDOW_EXPIRED"; text: string } | null {
  if (state !== "CAPTURED" && state !== "PARTIALLY_CAPTURED") return null;
  const obj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" ? (p as Record<string, unknown>) : {});
  const accepted = events.some((e) => e.type === "HUMAN_REVIEW_DECISION" && obj(e.payload).decision === "accept" && obj(e.payload).phase === "POST_AUTH");
  const challenged = events.some((e) => typeof obj(e.payload).challenged === "string");
  const reviewed = events.some((e) => e.type === "HUMAN_REVIEW_DECISION" && obj(e.payload).decision !== "accept" && obj(e.payload).phase === "POST_AUTH");
  const noAccept = " No explicit acceptance was recorded for this deal.";
  if (challenged) return { kind: "AFTER_REVIEW_REQUEST", text: `Paid after you requested review of a criterion: the same delivery was re-verified against the original locked terms and the deterministic result decided the payment.${accepted ? "" : noAccept}` };
  if (accepted) return { kind: "ACCEPTED", text: "Paid after you accepted the delivery. Accepting only ended your own waiting period early; the amount came from the locked criteria, not from the acceptance." };
  if (reviewed) return { kind: "AFTER_HUMAN_REVIEW", text: `Paid after a human review decision on criteria the machines could not resolve; the amount still came from the locked criteria.${noAccept}` };
  return { kind: "WINDOW_EXPIRED", text: `Paid under the expired-window rule: verification passed and the challenge window ended with no review request.${noAccept}` };
}

/**
 * What the PayPal side of this deal truly is, in words that never overstate it: an order is not an authorization, an authorization is a hold (not escrow, not a payment),
 * and only a recorded capture is a payment. In mock mode every line says so. A provider operation still in doubt is called what it is.
 */
export function paypalLifecycle(state: string, mock: boolean, ops: { status: string }[]): { label: string; tone: "slate" | "amber" | "green" | "red" | "blue" } {
  const tag = mock ? " (MOCK, simulated)" : "";
  if (ops.some((o) => ["UNKNOWN", "SENT", "PLANNED"].includes(o.status) && state !== "CAPTURED") || state === "SETTLEMENT_PENDING") return { label: "Provider outcome not confirmed: reconciliation required. Nothing is assumed to have succeeded.", tone: "red" };
  switch (state) {
    case "POLICY_CHECKED":
    case "TERMS_LOCKED":
    case "PROPOSED":
    case "NEGOTIATING":
      return { label: mock ? "Mock payment: no order created yet" : "Sandbox checkout pending: no PayPal order yet", tone: "slate" };
    case "ORDER_CREATED":
    case "AWAITING_BUYER_APPROVAL":
      return { label: `Buyer approval required: the order exists but is NOT authorized and no funds are held${tag}`, tone: "amber" };
    case "AUTHORIZED":
    case "AWAITING_DELIVERY":
      return { label: `Authorized: a hold on the buyer's funds at PayPal, not captured and not escrow. Awaiting delivery${tag}`, tone: "blue" };
    case "DELIVERED":
    case "VERIFYING":
    case "SETTLEMENT_REVIEW":
    case "NEEDS_HUMAN":
      return { label: `Authorized; delivery is being verified. Capture is not permitted yet${tag}`, tone: "blue" };
    case "SETTLING":
      return { label: `Capture permitted by the settlement decision; capture in progress${tag}`, tone: "amber" };
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      return { label: mock ? "Captured (MOCK: no real money moved)" : "Captured (PayPal Sandbox)", tone: "green" };
    case "VOIDED":
      return { label: `Voided: the authorization was released and nothing was captured${tag}`, tone: "slate" };
    case "EXPIRED":
    case "FAILED":
    case "BLOCKED":
      return { label: "Ended without a payment", tone: "red" };
    default:
      return { label: state, tone: "slate" };
  }
}
