/**
 * The PayPal Sandbox gateway built on the official Server SDK, tested with FAKE SDK controllers: request mapping, response parsing, error classification, timeouts, path and id
 * validation, secret hygiene. No network, no credentials, no PayPal. (Constructing the real SDK client is also checked to make no request.)
 */
import http from "node:http";
import https from "node:https";
import { AbortError, ApiError, ArgumentsValidationError, ResponseValidationError } from "@paypal/paypal-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { camelize, createSandboxSdkGateway, SdkPayPalGateway, type OrdersApi, type PaymentsApi, type SdkResponse } from "@/paypal/sdk-gateway";
import { captureBody, createOrderBody } from "@/paypal/payloads";

const TOKEN = "Bearer A21-SECRET-TOKEN-must-never-leak";
const ok = (status: number, body: unknown, headers: Record<string, string> = { "paypal-debug-id": "dbg-1" }): SdkResponse => ({ statusCode: status, headers, body: body === null ? "" : typeof body === "string" ? body : JSON.stringify(body) });
const apiError = (status: number, body: unknown = {}) =>
  new ApiError({ request: { method: "POST", url: "https://api-m.sandbox.paypal.com/x", headers: { authorization: TOKEN } }, response: { statusCode: status, headers: { "paypal-debug-id": "dbg-err" }, body: JSON.stringify(body) } } as never, `HTTP ${status}`);

function fakes() {
  const calls: { fn: string; args: any; opts?: any }[] = [];
  const result: { next: (() => Promise<SdkResponse>) | undefined } = { next: undefined };
  const wrap = (fn: string) => async (args: any, opts?: any) => {
    calls.push({ fn, args, opts });
    return result.next ? result.next() : ok(200, { id: "X1", status: "CREATED" });
  };
  const orders: OrdersApi = { createOrder: wrap("createOrder"), getOrder: wrap("getOrder"), authorizeOrder: wrap("authorizeOrder") };
  const payments: PaymentsApi = { getAuthorizedPayment: wrap("getAuthorizedPayment"), captureAuthorizedPayment: wrap("captureAuthorizedPayment"), voidPayment: wrap("voidPayment"), reauthorizePayment: wrap("reauthorizePayment"), getCapturedPayment: wrap("getCapturedPayment") };
  return { gw: new SdkPayPalGateway(orders, payments), calls, result };
}

describe("request mapping", () => {
  it("CREATE_ORDER: the engine's REST payload becomes the SDK's camelCase model with intent AUTHORIZE, the exact amount, the deal as reference and the stable request id", async () => {
    const { gw, calls } = fakes();
    const body = createOrderBody({ referenceId: "deal-1", description: "d", amount: "22.53", returnUrl: "https://app/return", cancelUrl: "https://app/cancel" });
    await gw.write("CREATE_ORDER", { requestId: "deal-1-CREATE_ORDER-1", path: "/v2/checkout/orders", body });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.fn).toBe("createOrder");
    expect(c.args.paypalRequestId).toBe("deal-1-CREATE_ORDER-1");
    expect(c.args.prefer).toBe("return=representation");
    expect(c.args.body).toMatchObject({
      intent: "AUTHORIZE",
      purchaseUnits: [{ referenceId: "deal-1", customId: "deal-1", amount: { currencyCode: "USD", value: "22.53" } }],
      paymentSource: { paypal: { experienceContext: { returnUrl: "https://app/return", cancelUrl: "https://app/cancel", userAction: "PAY_NOW", shippingPreference: "NO_SHIPPING" } } },
    });
    expect(JSON.stringify(c.args.body)).not.toMatch(/CAPTURE/); // never an immediate-capture intent
  });
  it("AUTHORIZE, CAPTURE, VOID and REAUTHORIZE carry the id from the path, the request id, and (capture) the exact amount, final_capture and invoice id", async () => {
    const { gw, calls } = fakes();
    await gw.write("AUTHORIZE", { requestId: "d-AUTHORIZE-1", path: "/v2/checkout/orders/ORDER123/authorize" });
    await gw.write("CAPTURE", { requestId: "d-CAPTURE-1", path: "/v2/payments/authorizations/AUTH456/capture", body: captureBody({ amount: "22.53", finalCapture: true, invoiceId: "d-INV" }) });
    await gw.write("VOID", { requestId: "d-VOID-1", path: "/v2/payments/authorizations/AUTH456/void" });
    await gw.write("REAUTHORIZE", { requestId: "d-REAUTH-1", path: "/v2/payments/authorizations/AUTH456/reauthorize", body: { amount: { currency_code: "USD", value: "22.53" } } });
    expect(calls.map((c) => c.fn)).toEqual(["authorizeOrder", "captureAuthorizedPayment", "voidPayment", "reauthorizePayment"]);
    expect(calls[0]!.args).toMatchObject({ id: "ORDER123", paypalRequestId: "d-AUTHORIZE-1" });
    expect(calls[1]!.args).toMatchObject({ authorizationId: "AUTH456", paypalRequestId: "d-CAPTURE-1", body: { amount: { currencyCode: "USD", value: "22.53" }, finalCapture: true, invoiceId: "d-INV" } });
    expect(calls[2]!.args).toMatchObject({ authorizationId: "AUTH456", paypalRequestId: "d-VOID-1" });
    expect(calls[3]!.args).toMatchObject({ authorizationId: "AUTH456", body: { amount: { currencyCode: "USD", value: "22.53" } } });
  });
  it("reads use GET-style SDK calls with the id only, and an abort signal", async () => {
    const { gw, calls } = fakes();
    await gw.getOrder("ORDER123");
    await gw.getAuthorization("AUTH456");
    await gw.getCapture("CAP789");
    expect(calls.map((c) => [c.fn, c.args])).toEqual([["getOrder", { id: "ORDER123" }], ["getAuthorizedPayment", { authorizationId: "AUTH456" }], ["getCapturedPayment", { captureId: "CAP789" }]]);
    for (const c of calls) expect(c.opts.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("camelize is the inverse of the engine's key style and leaves values alone", () => {
    expect(camelize({ purchase_units: [{ reference_id: "a_b", amount: { currency_code: "USD" } }], final_capture: true })).toEqual({ purchaseUnits: [{ referenceId: "a_b", amount: { currencyCode: "USD" } }], finalCapture: true });
  });
});

describe("response parsing", () => {
  it("a 2xx answer yields the RAW JSON the engine's own schemas will validate (REST shape, not SDK-typed objects)", async () => {
    const { gw, result } = fakes();
    result.next = async () => ok(201, { id: "ORD1", status: "PAYER_ACTION_REQUIRED", purchase_units: [{ reference_id: "deal-1" }] });
    expect(await gw.write("CREATE_ORDER", { requestId: "r1", path: "/v2/checkout/orders", body: {} })).toEqual({ kind: "ok", status: 201, debugId: "dbg-1", body: { id: "ORD1", status: "PAYER_ACTION_REQUIRED", purchase_units: [{ reference_id: "deal-1" }] } });
  });
  it("a 204 void has no body; a 2xx whose body is not JSON is UNKNOWN, never success", async () => {
    const { gw, result } = fakes();
    result.next = async () => ok(204, null);
    expect(await gw.write("VOID", { requestId: "r", path: "/v2/payments/authorizations/A1/void" })).toMatchObject({ kind: "ok", status: 204, body: null });
    result.next = async () => ok(200, "<html>proxy error</html>");
    expect(await gw.getOrder("ORD1")).toMatchObject({ kind: "unknown", code: "PAYPAL_UNKNOWN" });
  });
  it("a non-2xx response returned without throwing is classified by its status", async () => {
    const { gw, result } = fakes();
    result.next = async () => ok(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
    expect(await gw.write("AUTHORIZE", { requestId: "r", path: "/v2/checkout/orders/O1/authorize" })).toMatchObject({ kind: "rejected", status: 422, code: "PAYPAL_VALIDATION" });
  });
});

describe("error classification keeps the engine's invariant: rejected ONLY when PayPal provably did not apply the write", () => {
  it.each([
    [422, "rejected", "PAYPAL_VALIDATION"],
    [400, "rejected", "PAYPAL_VALIDATION"],
    [404, "rejected", "PAYPAL_NOT_FOUND"],
    [409, "rejected", "PAYPAL_VALIDATION"],
    [401, "rejected", "PAYPAL_AUTH_FAILED"],
    [403, "rejected", "PAYPAL_AUTH_FAILED"],
    [429, "unknown", "PAYPAL_RATE_LIMITED"],
    [500, "unknown", "PAYPAL_UNAVAILABLE"],
    [503, "unknown", "PAYPAL_UNAVAILABLE"],
  ])("HTTP %i -> %s (%s)", async (status, kind, code) => {
    const { gw, result } = fakes();
    result.next = async () => { throw apiError(status as number, { name: "X" }); };
    const r = await gw.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A1/capture", body: {} });
    expect(r).toMatchObject({ kind, code });
    if (r.kind !== "ok") expect(("debugId" in r ? r.debugId : undefined)).toBe("dbg-err");
  });
  it("a declined capture is recognised", async () => {
    const { gw, result } = fakes();
    result.next = async () => { throw apiError(422, { details: [{ issue: "INSTRUMENT_DECLINED" }] }); };
    expect(await gw.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A1/capture", body: {} })).toMatchObject({ kind: "rejected", code: "PAYPAL_DECLINED_CAPTURE" });
  });
  it("timeouts, aborts, network failures and unreadable responses are UNKNOWN (reconcile), never success and never 'rejected'", async () => {
    for (const [err, code] of [[new AbortError("aborted"), "PAYPAL_TIMEOUT"], [Object.create(ResponseValidationError.prototype) as Error, "PAYPAL_UNKNOWN"], [new Error("ECONNRESET"), "PAYPAL_UNAVAILABLE"]] as const) {
      const { gw, result } = fakes();
      result.next = async () => { throw err; };
      expect(await gw.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A1/capture", body: {} })).toMatchObject({ kind: "unknown", code });
    }
  });
  it("an SDK argument-validation failure happens BEFORE anything is sent, so it is a definitive rejection", async () => {
    const { gw, result } = fakes();
    result.next = async () => { throw Object.create(ArgumentsValidationError.prototype); };
    expect(await gw.write("CREATE_ORDER", { requestId: "r", path: "/v2/checkout/orders", body: {} })).toMatchObject({ kind: "rejected", code: "PAYPAL_VALIDATION", status: 0 });
  });
  it("the bearer token carried by SDK error objects never appears in a result", async () => {
    const { gw, result } = fakes();
    result.next = async () => { throw apiError(422, { name: "X" }); };
    const r = await gw.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A1/capture", body: {} });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(r)).not.toMatch(/authorization/i);
  });
  it("an operation that hangs is aborted after its timeout and reported as UNKNOWN", async () => {
    const { gw, result } = fakes();
    result.next = undefined;
    const hang = new SdkPayPalGateway(
      { ...fakes().gw, createOrder: () => new Promise(() => undefined), getOrder: () => new Promise(() => undefined), authorizeOrder: (_a: unknown, o?: { abortSignal?: AbortSignal }) => new Promise((_res, rej) => o!.abortSignal!.addEventListener("abort", () => rej(new AbortError("aborted")))) } as never,
      {} as never,
    );
    expect(await hang.write("AUTHORIZE", { requestId: "r", path: "/v2/checkout/orders/O1/authorize", timeoutMs: 30 })).toMatchObject({ kind: "unknown", code: "PAYPAL_TIMEOUT" });
    void gw;
  });
});

describe("paths and ids are validated before anything is sent", () => {
  it.each([
    ["AUTHORIZE", "/v2/checkout/orders/../../x/authorize"],
    ["AUTHORIZE", "/v2/checkout/orders/O1/capture"],
    ["CAPTURE", "/v2/checkout/orders/O1/capture"],
    ["CAPTURE", "/v2/payments/authorizations/A 1/capture"],
    ["VOID", "/v2/payments/authorizations//void"],
    ["CREATE_ORDER", "/v2/checkout/orders?x=1"],
    ["CREATE_ORDER", "https://evil.example/v2/checkout/orders"],
    ["REAUTHORIZE", "/v2/payments/authorizations/A1/void"],
  ] as const)("%s %s is refused without calling the SDK", async (type, path) => {
    const { gw, calls } = fakes();
    expect(await gw.write(type, { requestId: "r1", path, body: {} })).toMatchObject({ kind: "rejected", status: 0, code: "PAYPAL_VALIDATION" });
    expect(calls).toHaveLength(0);
  });
  it("a request id that is not a plain token, and ids with path characters, are refused", async () => {
    const { gw, calls } = fakes();
    expect(await gw.write("AUTHORIZE", { requestId: "bad id\n", path: "/v2/checkout/orders/O1/authorize" })).toMatchObject({ kind: "rejected" });
    expect(await gw.getOrder("O1/../x")).toMatchObject({ kind: "rejected" });
    expect(await gw.getAuthorization("")).toMatchObject({ kind: "rejected" });
    expect(calls).toHaveLength(0);
  });
});

describe("construction", () => {
  it("building the real SDK gateway makes NO network request and needs both credentials", () => {
    const spies = [vi.spyOn(http, "request"), vi.spyOn(https, "request"), vi.spyOn(globalThis, "fetch")];
    const gw = createSandboxSdkGateway({ clientId: "test-client-id", clientSecret: "test-client-secret" });
    expect(gw).toBeInstanceOf(SdkPayPalGateway);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
    expect(() => createSandboxSdkGateway({ clientId: "", clientSecret: "x" })).toThrow();
    expect(() => createSandboxSdkGateway({ clientId: "x", clientSecret: "" })).toThrow();
  });
});
