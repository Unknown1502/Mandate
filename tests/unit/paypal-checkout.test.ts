/** Eligibility of the buyer's real Sandbox checkout button, and the wording of the PayPal side of a deal. Pure: no database, no network, no PayPal. */
import { describe, expect, it } from "vitest";
import { checkoutView, PAYPAL_JS_SDK_V6_SANDBOX_URL } from "@/paypal/checkout";
import { paypalLifecycle } from "@/paypal/lifecycle";

const CHECKOUT = { clientId: "public-client-id", sdkUrl: PAYPAL_JS_SDK_V6_SANDBOX_URL };
const deal = { state: "AWAITING_BUYER_APPROVAL", paypalOrderId: "ORDER1", price: { toString: () => "22.53" } };
const base = { mode: "sandbox" as const, checkout: CHECKOUT, sandboxWritesAuthorized: true, deal };

describe("checkoutView: when the real PayPal button may be shown", () => {
  it("eligible only in Sandbox mode, configured, writes unlocked, awaiting approval, with an order and a locked price; every value comes from the server's deal", () => {
    expect(checkoutView(base)).toEqual({ mode: "sandbox", eligible: true, clientId: "public-client-id", sdkUrl: PAYPAL_JS_SDK_V6_SANDBOX_URL, orderId: "ORDER1", amount: "22.53", currency: "USD" });
  });
  it("mock mode never shows the real button", () => {
    expect(checkoutView({ ...base, mode: "mock" })).toEqual({ mode: "mock", eligible: false, reason: "MOCK_MODE_USES_SIMULATED_CHECKOUT" });
  });
  it("incomplete configuration, locked writes, wrong state and missing order/price are all NOT eligible, each with its own reason", () => {
    expect(checkoutView({ ...base, checkout: undefined })).toMatchObject({ eligible: false, reason: "SANDBOX_NOT_CONFIGURED" });
    expect(checkoutView({ ...base, sandboxWritesAuthorized: false })).toMatchObject({ eligible: false, reason: "SANDBOX_WRITES_LOCKED" });
    for (const state of ["PROPOSED", "TERMS_LOCKED", "POLICY_CHECKED", "ORDER_CREATED", "AUTHORIZED", "AWAITING_DELIVERY", "VERIFYING", "SETTLING", "CAPTURED", "VOIDED", "BLOCKED"]) {
      expect(checkoutView({ ...base, deal: { ...deal, state } }), state).toMatchObject({ eligible: false });
    }
    expect(checkoutView({ ...base, deal: { ...deal, paypalOrderId: null } })).toMatchObject({ eligible: false, reason: "NO_ORDER_FOR_DEAL" });
    expect(checkoutView({ ...base, deal: { ...deal, price: null } })).toMatchObject({ eligible: false, reason: "NO_ORDER_FOR_DEAL" });
  });
  it("the answer can never carry a secret: only the public client id, the fixed Sandbox script URL, the order id, the amount and the currency", () => {
    const v = checkoutView(base);
    expect(Object.keys(v).sort()).toEqual(["amount", "clientId", "currency", "eligible", "mode", "orderId", "sdkUrl"]);
    expect(PAYPAL_JS_SDK_V6_SANDBOX_URL).toBe("https://www.sandbox.paypal.com/web-sdk/v6/core");
  });
});

describe("paypalLifecycle: wording that never overstates", () => {
  const states = ["PROPOSED", "NEGOTIATING", "TERMS_LOCKED", "POLICY_CHECKED", "ORDER_CREATED", "AWAITING_BUYER_APPROVAL", "AUTHORIZED", "AWAITING_DELIVERY", "DELIVERED", "VERIFYING", "SETTLEMENT_REVIEW", "NEEDS_HUMAN", "SETTLING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "EXPIRED", "FAILED", "BLOCKED"];
  it("an order is never described as an authorization, and no state before capture says paid or escrow", () => {
    for (const state of ["ORDER_CREATED", "AWAITING_BUYER_APPROVAL"]) {
      const l = paypalLifecycle(state, false, []);
      expect(l.label).toMatch(/NOT authorized/);
      expect(l.label).toMatch(/no funds are held/);
    }
    for (const state of states.filter((s) => !["CAPTURED", "PARTIALLY_CAPTURED"].includes(s))) {
      for (const mock of [true, false]) expect(paypalLifecycle(state, mock, []).label, `${state} ${mock}`).not.toMatch(/\bpaid\b|payment (made|complete)|escrow(?!\.)/i);
    }
  });
  it("an authorization is called a hold, 'not captured and not escrow'", () => {
    expect(paypalLifecycle("AWAITING_DELIVERY", false, []).label).toMatch(/hold.*not captured and not escrow/i);
    expect(paypalLifecycle("VERIFYING", false, []).label).toMatch(/Capture is not permitted yet/);
  });
  it("capture is described as permitted only in SETTLING, and as captured only after a capture (Sandbox vs MOCK distinguished)", () => {
    expect(paypalLifecycle("SETTLING", false, []).label).toMatch(/Capture permitted/);
    expect(paypalLifecycle("CAPTURED", false, []).label).toBe("Captured (PayPal Sandbox)");
    expect(paypalLifecycle("CAPTURED", true, []).label).toMatch(/MOCK/);
    expect(paypalLifecycle("VOIDED", false, []).label).toMatch(/nothing was captured/);
  });
  it("mock states say so; an operation in doubt or a pending provider outcome is shown as reconciliation required, never as success", () => {
    for (const state of ["ORDER_CREATED", "AUTHORIZED", "VERIFYING", "SETTLING"]) expect(paypalLifecycle(state, true, []).label, state).toMatch(/MOCK|Mock/);
    expect(paypalLifecycle("SETTLING", false, [{ status: "UNKNOWN" }])).toMatchObject({ tone: "red" });
    expect(paypalLifecycle("SETTLING", false, [{ status: "UNKNOWN" }]).label).toMatch(/reconciliation required/);
    expect(paypalLifecycle("SETTLEMENT_PENDING", false, []).label).toMatch(/reconciliation required/);
    expect(paypalLifecycle("AWAITING_DELIVERY", false, [{ status: "CONFIRMED" }]).label).toMatch(/Authorized/);
  });
});
