/** P5: HTTP guards, secure headers and the login route's use of them. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig, { SECURITY_HEADERS } from "../../next.config";
import { createRateLimiter, readJsonBounded } from "@/lib/http-guard";

const req = (body: string | null, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "POST", body: body ?? undefined, headers });

describe("readJsonBounded", () => {
  it("reads a small JSON body", async () => expect(await readJsonBounded(req('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } }));
  it("refuses an oversized body by declared length and by streamed length, without buffering it", async () => {
    expect(await readJsonBounded(req("{}", { "content-length": "999999" }), 100)).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
    const big = JSON.stringify({ pad: "x".repeat(5_000) });
    expect(await readJsonBounded(req(big), 1_000)).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
  });
  it("refuses a malformed or missing body", async () => {
    expect(await readJsonBounded(req("{nope"))).toEqual({ ok: false, code: "BODY_INVALID" });
    expect(await readJsonBounded(new Request("http://localhost/x", { method: "GET" }))).toEqual({ ok: false, code: "BODY_INVALID" });
  });
});

describe("createRateLimiter", () => {
  it("allows `limit` requests per window, then refuses until the window slides", () => {
    let t = 0;
    const l = createRateLimiter({ limit: 3, windowMs: 1_000, now: () => t });
    expect([l.take("a"), l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, true, false]);
    expect(l.take("b")).toBe(true); // keys are independent
    expect(l.retryAfterSeconds("a")).toBe(1);
    t = 1_001;
    expect(l.take("a")).toBe(true);
  });
  it("a refused request is not counted (no self-extending lockout) and the key table is size-capped", () => {
    let t = 0;
    const l = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 3, now: () => t });
    expect(l.take("a")).toBe(true);
    for (let i = 0; i < 50; i++) expect(l.take("a")).toBe(false);
    t = 1_001;
    expect(l.take("a")).toBe(true);
    for (let i = 0; i < 100; i++) l.take(`k${i}`); // key flooding must not grow the table without bound
    expect(() => l.take("z")).not.toThrow();
  });
});

describe("secure headers and the login route", () => {
  it("next.config applies the security headers to every route and no-store to the API", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const names = all.headers.map((h) => h.key);
    for (const n of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security", "Cross-Origin-Opener-Policy"]) expect(names).toContain(n);
    const get = (k: string) => SECURITY_HEADERS.find((h) => h.key === k)!.value;
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Content-Security-Policy")).toMatch(/frame-ancestors 'none'/);
    expect(get("Content-Security-Policy")).toMatch(/object-src 'none'/);
    expect(get("Content-Security-Policy")).not.toMatch(/\*/);
    expect(rules.find((r) => r.source === "/api/:path*")!.headers).toEqual([{ key: "Cache-Control", value: "no-store" }]);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
  it("the login route checks origin, rate limit and body size before it compares any credential", () => {
    const s = readFileSync(resolve(__dirname, "../../src/app/api/auth/login/route.ts"), "utf8");
    const at = (re: RegExp) => s.search(re);
    expect(at(/verifyOrigin\(/)).toBeGreaterThan(-1);
    expect(at(/verifyOrigin\(/)).toBeLessThan(at(/globalLimiter\.take/));
    expect(at(/globalLimiter\.take/)).toBeLessThan(at(/readJsonBounded\(/));
    expect(at(/readJsonBounded\(/)).toBeLessThan(at(/safeEqual\(/));
    expect(s).not.toMatch(/req\.json\(\)/); // unbounded body reads are gone
    expect(s).toMatch(/status: 429/);
    expect(s).toMatch(/413/);
  });
});
