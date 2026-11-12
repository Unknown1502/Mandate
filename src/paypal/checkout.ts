/**
 * Browser-checkout contract (no PayPal SDK import: constants and a pure decision only, safe for the browser bundle and for the server route).
 *
 * Browser SDK: PayPal JavaScript SDK v6 (https://www.sandbox.paypal.com/web-sdk/v6/core), chosen because the order is created ON OUR SERVER with intent AUTHORIZE (createOrderBody) and
 * the v6 session only receives that order id ({ orderId }); PayPal's v6 reference states onApprove is where the merchant server "captures or authorizes" the payment. The browser
 * therefore cannot choose the intent, the amount or the order. After approval our server authorizes (never captures) and re-reads the order from PayPal.
 */
import type { DealState } from "../domain/statemachine";

/** the only script origin the dashboard may load for checkout; the server hands this exact string to the browser and the browser refuses any other */
export const PAYPAL_JS_SDK_V6_SANDBOX_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

export type CheckoutView =
  | { mode: "mock"; eligible: false; reason: "MOCK_MODE_USES_SIMULATED_CHECKOUT" }
  | { mode: "sandbox"; eligible: false; reason: string }
  | { mode: "sandbox"; eligible: true; clientId: string; sdkUrl: string; orderId: string; amount: string; currency: "USD" };

/**
 * Decide whether the buyer's real PayPal Sandbox checkout button may be shown for a deal. Pure. Every input is a SERVER-side value (the deal row and the runtime): the browser
 * supplies nothing. Eligible only when: Sandbox mode, a configured client id, the operator has unlocked Sandbox writes (otherwise our authorize step would be refused after the
 * buyer approved), the deal is awaiting buyer approval, and the deal holds an order id and a locked price. Ownership is checked by the route before this is called.
 */
export function checkoutView(a: {
  mode: "mock" | "sandbox";
  checkout?: { clientId: string; sdkUrl: string };
  sandboxWritesAuthorized: boolean;
  deal: { state: DealState | string; paypalOrderId: string | null; price: { toString(): string } | null };
}): CheckoutView {
  if (a.mode === "mock") return { mode: "mock", eligible: false, reason: "MOCK_MODE_USES_SIMULATED_CHECKOUT" };
  if (!a.checkout?.clientId) return { mode: "sandbox", eligible: false, reason: "SANDBOX_NOT_CONFIGURED" };
  if (!a.sandboxWritesAuthorized) return { mode: "sandbox", eligible: false, reason: "SANDBOX_WRITES_LOCKED" };
  if (a.deal.state !== "AWAITING_BUYER_APPROVAL") return { mode: "sandbox", eligible: false, reason: `DEAL_NOT_AWAITING_APPROVAL:${a.deal.state}` };
  if (!a.deal.paypalOrderId || a.deal.price === null) return { mode: "sandbox", eligible: false, reason: "NO_ORDER_FOR_DEAL" };
  return { mode: "sandbox", eligible: true, clientId: a.checkout.clientId, sdkUrl: a.checkout.sdkUrl, orderId: a.deal.paypalOrderId, amount: a.deal.price.toString(), currency: "USD" };
}
