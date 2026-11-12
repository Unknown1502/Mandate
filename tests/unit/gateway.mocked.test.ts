/** MOCK-tested: fetch is stubbed. Proves request shapes and outcome classification only; says nothing about real PayPal. */
import { describe, expect, it, vi } from "vitest";
import { PayPalClient } from "@/paypal/client";
import { RestPayPalGateway } from "@/paypal/gateway";

const ENV = { PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "sec" };
const json = (status: number, body: unknown, h: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: h });

function gw(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 3600 });
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { gateway: new RestPayPalGateway(new PayPalClient({ env: ENV, fetchImpl: f })), calls };
}

describe("RestPayPalGateway request shapes (mocked)", () => {
  it("capture: POST to the authorization capture path with the caller's PayPal-Request-Id and body", async () => {
    const { gateway, calls } = gw(() => json(201, { id: "CAP1", status: "COMPLETED" }));
    const body = { amount: { currency_code: "USD", value: "14.00" }, final_capture: true, invoice_id: "inv" };
    const r = await gateway.write("CAPTURE", { requestId: "deal-CAPTURE-1", path: "/v2/payments/authorizations/AUTH1/capture", body });
    expect(r.kind).toBe("ok");
    const c = calls[0]!;
    expect(c.url).toBe("https://api-m.sandbox.paypal.com/v2/payments/authorizations/AUTH1/capture");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("deal-CAPTURE-1");
    expect(JSON.parse(c.init.body as string)).toEqual(body);
  });
  it("void: POST, no body, request id present", async () => {
    const { gateway, calls } = gw(() => json(204, null));
    const r = await gateway.write("VOID", { requestId: "deal-VOID-1", path: "/v2/payments/authorizations/AUTH1/void" });
    expect(r).toMatchObject({ kind: "ok", status: 204 });
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("deal-VOID-1");
  });
  it("reads are GETs without a request id", async () => {
    const { gateway, calls } = gw(() => json(200, { id: "X", status: "CREATED" }));
    await gateway.getAuthorization("AUTH1");
    await gateway.getOrder("ORD1");
    await gateway.getCapture("CAP1");
    expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://api-m.sandbox.paypal.com", "")}`)).toEqual([
      "GET /v2/payments/authorizations/AUTH1",
      "GET /v2/checkout/orders/ORD1",
      "GET /v2/payments/captures/CAP1",
    ]);
    expect((calls[0]!.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBeUndefined();
  });
  it("classifies 4xx as REJECTED (nothing happened) but 429/5xx/timeout as UNKNOWN (must reconcile)", async () => {
    for (const [status, kind] of [[400, "rejected"], [404, "rejected"], [422, "rejected"], [429, "unknown"], [500, "unknown"], [503, "unknown"]] as const) {
      const { gateway } = gw(() => json(status, { name: "X" }, { "paypal-debug-id": "dbg" }));
      const r = await gateway.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A/capture", body: {} });
      expect(r.kind, String(status)).toBe(kind);
    }
    const { gateway } = gw((_, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))));
    const r = await gateway.write("CAPTURE", { requestId: "r", path: "/v2/payments/authorizations/A/capture", body: {}, timeoutMs: 10 });
    expect(r).toMatchObject({ kind: "unknown", code: "PAYPAL_TIMEOUT" });
  });
  it("refuses paths outside the PayPal REST namespace", async () => {
    const { gateway } = gw(() => json(200, {}));
    await expect(gateway.write("CAPTURE", { requestId: "r", path: "https://evil.test/v2/x", body: {} })).resolves.toMatchObject({ kind: "rejected", status: 0, code: "PAYPAL_VALIDATION" });
  });
});
