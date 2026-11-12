/**
 * Static guarantees about the PayPal SDK integration (source text only, no network): who may import the SDKs, that Production cannot be selected, that the secret stays on the
 * server, that the browser SDK is the exact Sandbox v6 URL, and that the four historical spike orders and the write lock are untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const SRC = walk(join(ROOT, "src")).map(rel);
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const withText = (re: RegExp) => SRC.filter((f) => re.test(code(read(f)))).sort();

describe("PayPal SDK boundaries", () => {
  it("only src/paypal/sdk-gateway.ts imports the PayPal server SDK; nothing in src imports a PayPal browser package", () => {
    expect(withText(/@paypal\/paypal-server-sdk/)).toEqual(["src/paypal/sdk-gateway.ts"]);
    expect(withText(/from\s+["']@paypal\/(?!paypal-server-sdk)/)).toEqual([]);
  });
  it("only the composition root builds the SDK gateway", () => {
    expect(withText(/createSandboxSdkGateway\s*\(/)).toEqual(["src/lib/runtime.ts", "src/paypal/sdk-gateway.ts"]);
    expect(withText(/new\s+SdkPayPalGateway\s*\(/)).toEqual(["src/paypal/sdk-gateway.ts"]);
  });
  it("Production cannot be selected: the SDK environment is the literal Sandbox, and no production PayPal host exists in source", () => {
    const g = code(read("src/paypal/sdk-gateway.ts"));
    expect(g).toMatch(/environment:\s*Environment\.Sandbox/);
    expect(g).not.toMatch(/Environment\.Production|Environment\[/);
    expect(withText(/api-m\.paypal\.com|(?<!sandbox\.)www\.paypal\.com\/(?:web-sdk|sdk)|paypal\.com\/v1\/oauth2/)).toEqual([]);
    expect(withText(/PAYPAL_ENV\s*(?:===?|!==?)\s*["'](?!sandbox)/)).toEqual([]);
  });
  it("the client secret is read only by the environment parser, the composition root and the legacy REST client, never by a route or the browser", () => {
    expect(withText(/PAYPAL_CLIENT_SECRET/)).toEqual(["src/lib/env.ts", "src/lib/runtime.ts", "src/paypal/client.ts"]);
    expect(withText(/NEXT_PUBLIC_[A-Z_]*PAYPAL/)).toEqual([]);
    for (const f of SRC.filter((x) => x.startsWith("src/app/"))) expect(code(read(f)), f).not.toMatch(/clientSecret|CLIENT_SECRET|oAuthClientSecret/);
  });
  it("the browser SDK is loaded only from the exact Sandbox v6 URL, defined in one place", () => {
    expect(withText(/web-sdk\/v6\/core/)).toEqual(["src/paypal/checkout.ts"]);
    expect(read("src/paypal/checkout.ts")).toContain('"https://www.sandbox.paypal.com/web-sdk/v6/core"');
    expect(read("src/app/ui/paypal-checkout.tsx")).toMatch(/src !== PAYPAL_JS_SDK_V6_SANDBOX_URL/);
  });
  it("no business logic imports the PayPal gateway implementations except the composition root and the settlement port wiring", () => {
    expect(withText(/from\s+["'](?:@\/paypal\/sdk-gateway|\.\.?\/sdk-gateway|\.\.\/paypal\/sdk-gateway)["']/)).toEqual(["src/lib/runtime.ts"]);
    expect(withText(/from\s+["'](?:@\/paypal\/client|\.\/client|\.\.\/paypal\/client)["']/)).toEqual(["src/paypal/gateway.ts"]);
  });
  it("the webhook route does not exist (no unsigned webhook can pretend to confirm a payment)", () => {
    expect(SRC.filter((f) => /webhook/i.test(f))).toEqual([]);
  });
});

describe("existing safeguards are untouched", () => {
  it("the Sandbox write lock is still wired around the real gateway and still requires PAYPAL_SANDBOX_WRITES=authorized", () => {
    const r = code(read("src/lib/runtime.ts"));
    expect(r).toMatch(/new SandboxWriteLock\(createSandboxSdkGateway\(/);
    expect(r).toMatch(/env\.PAYPAL_SANDBOX_WRITES === "authorized"/);
    expect(r).toMatch(/if \(!this\.authorized\) return \{ kind: "rejected"/);
  });
  it("the four historical spike orders' state file is byte-for-byte unchanged", () => {
    // pinned at the start of milestone 5; no source file or test writes to .spike
    // the state file is the owner's private, git-ignored record: it exists only in the original working folder, so a public checkout checks the source-text rule below only
    const state = join(ROOT, ".spike", "state.json");
    if (existsSync(state)) expect(createHash("sha256").update(readFileSync(state)).digest("hex")).toBe("a47b3ae205b9399ace7e72139b907cae2f9d762cf6b8d09822460c645037113d");
    expect(withText(/\.spike/)).toEqual([]);
  });
});
