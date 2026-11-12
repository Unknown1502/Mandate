/**
 * MOCKED tests: fetch is stubbed. They prove our client's guards and bookkeeping only.
 * They do NOT prove anything about real PayPal behaviour (see docs/sandbox-observations.md for that).
 */
import { describe, expect, it, vi } from "vitest";
import { PayPalClient, type CallRecord } from "@/paypal/client";
import { PayPalError, classifyHttpError, isDefinitiveRejection } from "@/paypal/errors";
import { redact } from "@/paypal/redact";
import { usd } from "@/paypal/amount";
import { captureBody } from "@/paypal/payloads";

const ENV = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "cid",
  PAYPAL_CLIENT_SECRET: "super-secret-value",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers });

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

const tokenReply = () => json(200, { access_token: "tok-123", expires_in: 3600, token_type: "Bearer" });

describe("PayPalClient guards (mocked)", () => {
  it("refuses to construct for live / non-sandbox configuration", () => {
    expect(() => new PayPalClient({ env: { ...ENV, PAYPAL_ENV: "live" } })).toThrow();
    expect(() => new PayPalClient({ env: { ...ENV, PAYPAL_BASE_URL: "https://api-m.paypal.com" } })).toThrow();
  });

  it("rejects absolute URLs and odd paths (no arbitrary hosts)", async () => {
    const f = fakeFetch(() => tokenReply());
    const c = new PayPalClient({ env: ENV, fetchImpl: f });
    await expect(c.request({ method: "GET", path: "https://evil.test/x" })).rejects.toThrow(/Disallowed/);
    await expect(c.request({ method: "GET", path: "/v2/../etc" })).rejects.toThrow(/Disallowed|PayPal/);
    expect(f.mock.calls.length).toBe(0);
  });

  it("requires a PayPal-Request-Id for POST writes", async () => {
    const c = new PayPalClient({ env: ENV, fetchImpl: fakeFetch(() => tokenReply()) });
    await expect(c.request({ method: "POST", path: "/v2/checkout/orders", body: {} })).rejects.toThrow(/Request-Id/);
  });

  it("caches the token and refreshes it only near expiry", async () => {
    let t = 0;
    const f = fakeFetch((url) => (url.endsWith("/v1/oauth2/token") ? tokenReply() : json(200, { id: "X" })));
    const c = new PayPalClient({ env: ENV, fetchImpl: f, now: () => t });
    await c.request({ method: "GET", path: "/v2/checkout/orders/A" });
    await c.request({ method: "GET", path: "/v2/checkout/orders/B" });
    const tokenCalls = () => f.mock.calls.filter(([u]) => u.endsWith("/v1/oauth2/token")).length;
    expect(tokenCalls()).toBe(1);
    t = 3600_000 - 30_000; // inside the 60s safety margin
    await c.request({ method: "GET", path: "/v2/checkout/orders/C" });
    expect(tokenCalls()).toBe(2);
  });

  it("never exposes tokens or secrets in call records", async () => {
    const records: CallRecord[] = [];
    const f = fakeFetch((url) => (url.endsWith("/v1/oauth2/token") ? tokenReply() : json(200, { id: "X" }, { "paypal-debug-id": "dbg1" })));
    const c = new PayPalClient({ env: ENV, fetchImpl: f, onCall: (r) => records.push(r) });
    await c.request({ method: "GET", path: "/v2/checkout/orders/A" });
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("tok-123");
    expect(dump).not.toContain("super-secret-value");
    expect(dump).not.toContain(Buffer.from("cid:super-secret-value").toString("base64"));
    expect(records.find((r) => r.path.includes("orders"))?.debugId).toBe("dbg1");
  });

  it("surfaces a timeout as PAYPAL_TIMEOUT (outcome unknown), not as a failure", async () => {
    const f = fakeFetch((url, init) =>
      url.endsWith("/v1/oauth2/token")
        ? tokenReply()
        : new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))),
    );
    const c = new PayPalClient({ env: ENV, fetchImpl: f });
    await expect(
      c.request({ method: "POST", path: "/v2/payments/authorizations/A/capture", body: {}, requestId: "r1", timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "PAYPAL_TIMEOUT" });
  });

  it("returns non-2xx as a response object instead of throwing", async () => {
    const f = fakeFetch((url) => (url.endsWith("/v1/oauth2/token") ? tokenReply() : json(422, { name: "UNPROCESSABLE_ENTITY" })));
    const c = new PayPalClient({ env: ENV, fetchImpl: f });
    const r = await c.request({ method: "GET", path: "/v2/checkout/orders/A" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
  });

  it("fails OAuth with a typed error and no token leakage", async () => {
    const c = new PayPalClient({ env: ENV, fetchImpl: fakeFetch(() => json(401, { error: "invalid_client" })) });
    const err = await c.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).code).toBe("PAYPAL_AUTH_FAILED");
    expect(String(err)).not.toContain("super-secret-value");
  });
});

describe("error classification and redaction", () => {
  it("maps statuses to the typed set", () => {
    expect(classifyHttpError(401, null)).toBe("PAYPAL_AUTH_FAILED");
    expect(classifyHttpError(404, null)).toBe("PAYPAL_NOT_FOUND");
    expect(classifyHttpError(429, null)).toBe("PAYPAL_RATE_LIMITED");
    expect(classifyHttpError(503, null)).toBe("PAYPAL_UNAVAILABLE");
    expect(classifyHttpError(422, { details: [{ issue: "INSTRUMENT_DECLINED" }] })).toBe("PAYPAL_DECLINED_CAPTURE");
    expect(classifyHttpError(422, { details: [{ issue: "OTHER" }] })).toBe("PAYPAL_VALIDATION");
  });

  it("treats only 4xx rejections as definitive, never 429/5xx", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isDefinitiveRejection(s)).toBe(true);
    for (const s of [429, 500, 502, 503, 504]) expect(isDefinitiveRejection(s)).toBe(false);
  });

  it("redacts tokens and payer personal data deeply, keeping error names", () => {
    const out = JSON.stringify(
      redact({
        access_token: "a",
        name: "INVALID_REQUEST",
        payer: { email_address: "b@x.com", name: { given_name: "G", surname: "S" }, payer_id: "P" },
        nested: [{ postal_code: "123" }],
      }),
    );
    expect(out).not.toMatch(/b@x\.com|"G"|"S"|"P"|123|"a"/);
    expect(out).toContain("INVALID_REQUEST");
  });
});

describe("money formatting", () => {
  it("formats exact 2-decimal USD and rejects bad values", () => {
    expect(usd("6")).toBe("6.00");
    expect(usd("0.10")).toBe("0.10");
    expect(() => usd("0")).toThrow();
    expect(() => usd("-1")).toThrow();
    expect(() => usd("1.005")).toThrow();
    expect(() => usd("abc")).toThrow();
  });

  it("builds a byte-identical capture payload for identical inputs", () => {
    const a = JSON.stringify(captureBody({ amount: "6", finalCapture: true, invoiceId: "inv" }));
    const b = JSON.stringify(captureBody({ amount: "6.00", finalCapture: true, invoiceId: "inv" }));
    expect(a).toBe(b);
  });
});
