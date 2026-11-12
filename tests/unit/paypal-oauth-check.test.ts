/**
 * The OAuth-only connectivity check, tested WITHOUT any request to PayPal: the token exchange is a fake, the script is run only down its no-request exits, and the source is
 * checked for the approval gate. Nothing here can obtain a token.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApiError } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { checkSandboxOAuth, type TokenRequest } from "@/paypal/sdk-gateway";

const ROOT = resolve(__dirname, "..", "..");
const ID = "fake-client-id-AAAA";
const SECRET = "fake-client-secret-must-never-appear";
const TOKEN = "A21AA-fake-access-token-must-never-appear";
const issued = JSON.stringify({ scope: "https://uri.paypal.com/services/payments/payment/authcapture openid", access_token: TOKEN, token_type: "Bearer", app_id: "APP-FAKE123", expires_in: 32400, nonce: "n-fake" });

function fake(handler: (auth: string) => Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }>) {
  const seen: string[] = [];
  const send: TokenRequest = async (auth) => (seen.push(auth), handler(auth));
  return { send, seen };
}

describe("checkSandboxOAuth", () => {
  it("makes exactly one exchange, sends HTTP Basic credentials to it, and returns a summary that cannot contain the token or the secret", async () => {
    const f = fake(async () => ({ statusCode: 200, headers: { "paypal-debug-id": "dbg-ok" }, body: issued }));
    const r = await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, f.send);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toBe(`Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
    expect(r).toEqual({ ok: true, httpStatus: 200, debugId: "dbg-ok", tokenType: "Bearer", expiresInSeconds: 32400, appId: "APP-FAKE123", scopes: ["https://uri.paypal.com/services/payments/payment/authcapture", "openid"] });
    const text = JSON.stringify(r);
    for (const secret of [TOKEN, SECRET, ID, "n-fake", Buffer.from(`${ID}:${SECRET}`).toString("base64")]) expect(text).not.toContain(secret);
    expect(Object.keys(r)).not.toContain("accessToken");
  });
  it("rejected credentials (HTTP 401 invalid_client) are reported with a fixed reason and PayPal's plain error code only", async () => {
    const f = fake(async () => ({ statusCode: 401, headers: { "paypal-debug-id": "dbg-401" }, body: JSON.stringify({ error: "invalid_client", error_description: "Client Authentication failed" }) }));
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, f.send)).toEqual({ ok: false, httpStatus: 401, debugId: "dbg-401", failure: "CREDENTIALS_REJECTED", oauthError: "invalid_client" });
  });
  it("an SDK ApiError is summarised from its RESPONSE only; the request it carries (with the Basic credentials) never leaks", async () => {
    const basic = `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`;
    const f = fake(async () => {
      throw new ApiError({ request: { method: "POST", url: "https://api-m.sandbox.paypal.com/v1/oauth2/token", headers: { authorization: basic } }, response: { statusCode: 401, headers: { "paypal-debug-id": "dbg-sdk" }, body: JSON.stringify({ error: "invalid_client" }) } } as never, "401");
    });
    const r = await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, f.send);
    expect(r).toMatchObject({ ok: false, httpStatus: 401, failure: "CREDENTIALS_REJECTED", oauthError: "invalid_client", debugId: "dbg-sdk" });
    expect(JSON.stringify(r)).not.toContain(Buffer.from(`${ID}:${SECRET}`).toString("base64"));
  });
  it("unexpected statuses, unreadable bodies, odd error strings and network failures all map to the fixed vocabulary", async () => {
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, fake(async () => ({ statusCode: 503, headers: {}, body: "" })).send)).toMatchObject({ ok: false, failure: "UNEXPECTED_STATUS", httpStatus: 503 });
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, fake(async () => ({ statusCode: 200, headers: {}, body: "<html>proxy</html>" })).send)).toMatchObject({ ok: false, failure: "UNREADABLE_RESPONSE" });
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, fake(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ token_type: "Bearer" }) })).send)).toMatchObject({ ok: false, failure: "UNREADABLE_RESPONSE" });
    const weird = await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, fake(async () => ({ statusCode: 400, headers: {}, body: JSON.stringify({ error: `bad value ${SECRET}` }) })).send);
    expect(weird.oauthError).toBeUndefined(); // an error string that is not a short plain token is dropped
    expect(JSON.stringify(weird)).not.toContain(SECRET);
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET }, fake(async () => { throw new Error(`ECONNRESET ${SECRET}`); }).send)).toEqual({ ok: false, failure: "NETWORK_OR_TIMEOUT" });
  });
  it("a hung exchange is aborted after the timeout and reported as NETWORK_OR_TIMEOUT", async () => {
    const send: TokenRequest = (_a, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    expect(await checkSandboxOAuth({ clientId: ID, clientSecret: SECRET, timeoutMs: 25 }, send)).toEqual({ ok: false, failure: "NETWORK_OR_TIMEOUT" });
  });
  it("both credentials are required", async () => {
    await expect(checkSandboxOAuth({ clientId: "", clientSecret: SECRET }, fake(async () => ({ statusCode: 200, headers: {}, body: issued })).send)).rejects.toThrow();
    await expect(checkSandboxOAuth({ clientId: ID, clientSecret: "" }, fake(async () => ({ statusCode: 200, headers: {}, body: issued })).send)).rejects.toThrow();
  });
});

describe("scripts/paypal-oauth-check.ts: the approval gate", () => {
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/paypal-oauth-check.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
  const sandbox = { PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET };

  it("without credentials: NOT CONFIGURED, exit 3, no request, no value printed", () => {
    const r = run({});
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT CONFIGURED/);
  }, 100_000);
  it("with a non-Sandbox environment or the production host: NOT CONFIGURED, exit 3", () => {
    for (const over of [{ PAYPAL_ENV: "live" }, { PAYPAL_BASE_URL: "https://api-m.paypal.com" }]) {
      const r = run({ ...sandbox, ...over });
      expect(r.status).toBe(3);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    }
  }, 100_000);
  it("configured but NOT approved: prints the plan, exit 4, sends nothing, never prints a credential", () => {
    const r = run(sandbox);
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/NOT APPROVED: no request was made/);
    expect(r.stdout).toMatch(/exactly ONE/);
    expect(r.stdout).toMatch(/will NOT\s+create an order, authorize, capture, void or refund/);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout + r.stderr).not.toContain(ID);
    expect(r.stdout).not.toMatch(/REAL PayPal requests made/);
  }, 100_000);

  it("source guarantees: the request happens only after the approval flag, once, and the script imports no payment engine or database", () => {
    const s = readFileSync(join(ROOT, "scripts", "paypal-oauth-check.ts"), "utf8");
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.indexOf('flag("approve-oauth-request")')).toBeGreaterThan(-1);
    expect(code.indexOf('flag("approve-oauth-request")')).toBeLessThan(code.indexOf("await checkSandboxOAuth("));
    expect(code.match(/checkSandboxOAuth\(/g)).toHaveLength(1);
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["../src/lib/env", "../src/paypal/sdk-gateway", "node:fs", "node:path"]);
    // calls and reads only (the printed plan legitimately names what the script will NOT do)
    expect(code).not.toMatch(/process\.env\.PAYPAL_SANDBOX_WRITES|env\[["']PAYPAL_SANDBOX_WRITES|PrismaClient|createOrder\(|authorizeOrder\(|captureAuthorizedPayment\(|voidPayment\(|\.write\(|new SdkPayPalGateway|createSandboxSdkGateway|\.spike/i);
  });
});
