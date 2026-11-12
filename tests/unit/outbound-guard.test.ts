/** The stage guard refuses unlisted and over-count requests BEFORE they are sent. Nothing here reaches a network: the underlying functions are replaced by recorders first. */
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installOutboundGuard, type Guard } from "../../scripts/lib/outbound-guard";

const RULES = [
  { name: "oauth", method: "POST", host: "api-m.sandbox.paypal.com", path: /^\/v1\/oauth2\/token$/, max: 1 },
  { name: "create-order", method: "POST", host: "api-m.sandbox.paypal.com", path: /^\/v2\/checkout\/orders$/, max: 1 },
  { name: "read-order", method: "GET", host: "api-m.sandbox.paypal.com", path: /^\/v2\/checkout\/orders\/[A-Za-z0-9_-]+$/, max: 1 },
];
let guard: Guard | undefined;
const sent: string[] = [];
const realFns = { r: https.request, g: https.get, hr: http.request, hg: http.get, f: globalThis.fetch };
function setup() {
  sent.length = 0;
  // recorders stand in for the real network functions BEFORE the guard wraps them
  (https as any).request = (o: any) => (sent.push(`${o.method} ${o.hostname}${o.path}`), {});
  (https as any).get = (o: any) => (sent.push(`GET ${o.hostname}${o.path}`), {});
  (http as any).request = (o: any) => (sent.push(`${o.method} ${o.hostname}${o.path}`), {});
  (http as any).get = (o: any) => (sent.push(`GET ${o.hostname}${o.path}`), {});
  (globalThis as any).fetch = async (u: any) => (sent.push(`fetch ${u}`), new Response("ok"));
  guard = installOutboundGuard(RULES);
}
afterEach(() => {
  guard?.uninstall();
  guard = undefined;
  Object.assign(https, { request: realFns.r, get: realFns.g });
  Object.assign(http, { request: realFns.hr, get: realFns.hg });
  (globalThis as any).fetch = realFns.f;
  vi.restoreAllMocks();
});

describe("outbound guard", () => {
  it("allows exactly the listed requests once each, and sends nothing else", () => {
    setup();
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v1/oauth2/token", method: "POST" });
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders", method: "POST" });
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/ORDER123", method: "GET" });
    expect(sent).toEqual(["POST api-m.sandbox.paypal.com/v1/oauth2/token", "POST api-m.sandbox.paypal.com/v2/checkout/orders", "GET api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123"]);
    expect(guard!.counts()).toEqual({ oauth: 1, "create-order": 1, "read-order": 1 });
    expect(guard!.blocked()).toHaveLength(0);
  });
  it("refuses a second request of any listed kind BEFORE it is sent (no retry can leave the process)", () => {
    setup();
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders", method: "POST" });
    expect(() => https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders", method: "POST" })).toThrow(/refused by the stage guard/);
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/A1", method: "GET" });
    expect(() => https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/A1", method: "GET" })).toThrow();
    expect(sent).toHaveLength(2);
    expect(guard!.blocked()).toHaveLength(2);
  });
  it("refuses everything that is not listed: authorize, capture, void, refund, a different method, a different host, production", () => {
    setup();
    for (const [method, host, path] of [
      ["POST", "api-m.sandbox.paypal.com", "/v2/checkout/orders/A1/authorize"],
      ["POST", "api-m.sandbox.paypal.com", "/v2/payments/authorizations/X/capture"],
      ["POST", "api-m.sandbox.paypal.com", "/v2/payments/authorizations/X/void"],
      ["POST", "api-m.sandbox.paypal.com", "/v2/payments/captures/X/refund"],
      ["PATCH", "api-m.sandbox.paypal.com", "/v2/checkout/orders/A1"],
      ["GET", "api-m.sandbox.paypal.com", "/v2/payments/authorizations/X"],
      ["POST", "api-m.paypal.com", "/v1/oauth2/token"],
      ["POST", "evil.example", "/v2/checkout/orders"],
    ]) expect(() => https.request({ hostname: host, path, method }), `${method} ${host}${path}`).toThrow(/refused/);
    expect(sent).toHaveLength(0);
  });
  it("allows loopback (database proxy, seller simulator) and refuses a non-loopback fetch; query strings do not smuggle past a rule", async () => {
    setup();
    http.request({ hostname: "127.0.0.1", path: "/negotiate", method: "POST" });
    await fetch("http://127.0.0.1:4010/deliver", { method: "POST" });
    await expect(fetch("https://example.com/x")).rejects.toThrow(/refused/);
    https.request("https://api-m.sandbox.paypal.com/v2/checkout/orders?x=1", { method: "POST" } as never);
    expect(() => https.request("https://api-m.sandbox.paypal.com/v2/checkout/orders/A1/authorize?x=/v2/checkout/orders", { method: "POST" } as never)).toThrow();
    expect(sent.some((s) => s.includes("example.com"))).toBe(false);
  });
});

describe("outbound guard: ordered rules and shared paths", () => {
  const SEQ = [
    { name: "1-read", method: "GET", host: "api-m.sandbox.paypal.com", path: /^\/v2\/checkout\/orders\/[A-Z0-9]+$/, max: 1 },
    { name: "2-authorize", method: "POST", host: "api-m.sandbox.paypal.com", path: /^\/v2\/checkout\/orders\/[A-Z0-9]+\/authorize$/, max: 1, after: "1-read" },
    { name: "3-readback", method: "GET", host: "api-m.sandbox.paypal.com", path: /^\/v2\/checkout\/orders\/[A-Z0-9]+$/, max: 1, after: "2-authorize" },
  ];
  it("two rules on the same path are used in order, and a request out of order is refused before it is sent", () => {
    setup();
    guard!.uninstall();
    (https as any).request = (o: any) => (sent.push(`${o.method} ${o.hostname}${o.path}`), {});
    guard = installOutboundGuard(SEQ);
    expect(() => https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1/authorize", method: "POST" })).toThrow(/out of order/); // the authorize before the first read
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1", method: "GET" });
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1/authorize", method: "POST" });
    https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1", method: "GET" });
    expect(guard.log.filter((e) => e.allowed).map((e) => e.rule)).toEqual(["1-read", "2-authorize", "3-readback"]);
    expect(() => https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1", method: "GET" })).toThrow(); // a third read
    expect(() => https.request({ hostname: "api-m.sandbox.paypal.com", path: "/v2/checkout/orders/AB1/authorize", method: "POST" })).toThrow(); // a second authorize (no retry)
    expect(sent).toHaveLength(3);
  });
});
