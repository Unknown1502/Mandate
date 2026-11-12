/**
 * Architecture guard for the HTTP surface (demo approval boundary). Every API route must be on the explicit public allow-list or must derive its principal from the
 * session through @/lib/principal: a mutating handler uses requirePrincipalMutation (origin + session + CSRF), a reader uses requirePrincipalRead. A new route that does
 * neither fails this test, so a payment-adjacent endpoint cannot be added without the guard by accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src", "app", "api");
/** routes that have their own, reviewed guard (login issues the session; the others use the session guards in @/lib/auth) */
const OWN_GUARD = new Set(["auth/login/route.ts", "auth/logout/route.ts", "auth/session/route.ts", "health/route.ts"]);

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const routes = walk(ROOT).filter((f) => /route\.ts$/.test(f)).map((f) => ({ rel: relative(ROOT, f).replace(/\\/g, "/"), src: readFileSync(f, "utf8") }));
const handlers = (src: string) => [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);

describe("API route inventory", () => {
  it("finds the routes (the scan is not vacuous)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.some((r) => r.rel === "deals/[id]/advance/route.ts")).toBe(true);
  });

  it("every route outside the reviewed allow-list authenticates through @/lib/principal", () => {
    for (const r of routes) {
      if (OWN_GUARD.has(r.rel)) continue;
      expect(r.src, r.rel).toMatch(/from "@\/lib\/principal"/);
      const hs = handlers(r.src);
      expect(hs.length, r.rel).toBeGreaterThan(0);
      for (const h of hs) {
        const body = r.src.slice(r.src.indexOf(`function ${h}`));
        const firstAwait = h === "GET" ? /requirePrincipalRead\(/ : /requirePrincipalMutation\(/;
        expect(body, `${r.rel} ${h}`).toMatch(firstAwait);
        // the guard must run before the runtime (database, orchestrator, PayPal) is constructed
        const guardAt = body.search(firstAwait);
        const runtimeAt = body.search(/getRuntime\(/);
        if (runtimeAt >= 0) expect(guardAt, `${r.rel} ${h} guard before runtime`).toBeLessThan(runtimeAt);
      }
    }
  });

  it("no route reads a principal, owner or actor from the request", () => {
    for (const r of routes) {
      if (OWN_GUARD.has(r.rel)) continue;
      expect(r.src, r.rel).not.toMatch(/searchParams\.get\(["'](principal|owner|actor|user)/i);
      expect(r.src, r.rel).not.toMatch(/\b(body|data|raw|json|parsed)\.(principalId|ownerId|actorId|principalEmail)\b/); // identity is only ever taken from the guard result
    }
  });

  it("the allow-listed routes are exactly the four that existed before the boundary", () => {
    const existing = routes.map((r) => r.rel).filter((r) => OWN_GUARD.has(r)).sort();
    expect(existing).toEqual([...OWN_GUARD].sort());
  });
});
