/** Stage 5 script (the one capture): refusal paths (no request, no database access) and source guarantees. Nothing here contacts PayPal or the database. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const ID = "fake-client-id-for-the-stage-five-refusal-tests";
const SECRET = "fake-client-secret-must-never-appear";
const FP = createHash("sha256").update(ID).digest("hex").slice(0, 8);
const base = { PAYPAL_MODE: "sandbox", PAYPAL_SANDBOX_WRITES: "authorized", PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate_e2e" };
const run = (env: Record<string, string>, args: string[]) =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/paypal-e2e-stage5.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
const ok = ["--deal", "cmfakedealid0000000000001", "--expect-order-id", "4ABCDEFGHJ1234567", "--expect-authorization-id", "1ABCDEFGHJ1234567", "--stage3-evidence", "e3.json", "--stage4-evidence", "e4.json", "--expect-client-id-fingerprint", FP];

describe("scripts/paypal-e2e-stage5.ts refuses to start (exit 3, no request) unless every precondition holds", () => {
  it("nothing configured: exit 3 and a list of what is missing", () => {
    const r = run({}, ["--approve-stage5-capture"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT STARTED. No request was made/);
    expect(r.stdout).toMatch(/PAYPAL_SANDBOX_WRITES=authorized must be set/);
  }, 100_000);
  it("the write lock closed, mock mode, the wrong database, the wrong fingerprint or a production base URL: exit 3, even with the approval flag", () => {
    const { PAYPAL_SANDBOX_WRITES: _w, ...noWrites } = base;
    const a = run(noWrites, [...ok, "--approve-stage5-capture"]);
    expect(a.status).toBe(3);
    expect(a.stdout).toMatch(/write lock is not open/);
    expect(a.stdout + a.stderr).not.toContain(SECRET);
    expect(run({ ...base, PAYPAL_MODE: "mock" }, [...ok, "--approve-stage5-capture"]).status).toBe(3);
    expect(run({ ...base, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate" }, [...ok, "--approve-stage5-capture"]).status).toBe(3);
    expect(run(base, [...ok.map((x) => (x === FP ? "00000000" : x)), "--approve-stage5-capture"]).status).toBe(3);
    expect(run({ ...base, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, [...ok, "--approve-stage5-capture"]).status).toBe(3);
  }, 300_000);
  it("a missing deal, order, authorization or evidence argument is refused", () => {
    expect(run(base, ["--approve-stage5-capture"]).status).toBe(3);
    const noEvidence = run(base, ["--deal", "cmfakedealid0000000000001", "--expect-order-id", "4ABCDEFGHJ1234567", "--expect-authorization-id", "1ABCDEFGHJ1234567", "--expect-client-id-fingerprint", FP, "--approve-stage5-capture"]);
    expect(noEvidence.status).toBe(3);
    expect(noEvidence.stdout).toMatch(/--stage3-evidence and --stage4-evidence are required/);
  }, 200_000);
  it("everything correct but NOT approved: prints the six-request plan and exits 4 without sending anything or printing a credential", () => {
    const r = run(base, ok);
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/NOT APPROVED: no request was made/);
    expect(r.stdout).toMatch(/exactly SIX/);
    for (const needle of ["POST /v1/oauth2/token", "GET  /v2/payments/authorizations/1ABCDEFGHJ1234567", "POST /v2/payments/authorizations/1ABCDEFGHJ1234567/capture", "GET  /v2/payments/captures/{captureId}"]) expect(r.stdout).toContain(needle);
    expect(r.stdout).toMatch(/NO acceptance event is recorded or fabricated/);
    expect(r.stdout).toMatch(/will NOT\s+capture twice, void, refund, reauthorize or create an order/);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout).not.toMatch(/RESULT/);
  }, 100_000);
});

describe("source guarantees", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage5.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("the guard allows exactly six requests, one each, in a fixed order, installed before the only engine step", () => {
    expect([...code.matchAll(/name: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-authorization-read", "3-fresh-authorization-read", "4-capture", "5-capture-read", "6-authorization-reconcile"]);
    expect(code.match(/max: 1(?:,| \})/g)).toHaveLength(6);
    expect([...code.matchAll(/after: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-authorization-read", "3-fresh-authorization-read", "4-capture", "5-capture-read"]);
    expect(code.match(/method: "POST"/g)).toHaveLength(2); // the token request and the one capture
    expect(code.indexOf("installOutboundGuard(")).toBeLessThan(code.indexOf("orchestrator.advance("));
    expect(code.match(/orchestrator\.advance\(/g)).toHaveLength(1);
    expect(code.match(/guard\.uninstall\(\)/g)).toHaveLength(1);
  });
  it("no void, refund, reauthorize, order creation, acceptance, second engine entry point or spike reference anywhere in the script", () => {
    expect(code).not.toMatch(/openDeal|createOrder|createPayPalOrder|requestSettlement|acceptVerification|cancelAuthorization|voidPayment|reauthorizePayment|"REAUTHORIZE"|refund\(|\.spike|sweep\(/); // calls only: the notDone list legitimately names them
    expect(code).not.toMatch(/prisma\.[a-zA-Z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/); // the engine writes its own records; the script itself never does
    expect(code).not.toMatch(/process\.env\.[A-Z_]+\s*=[^=]/); // never sets the mode or the write lock itself: the operator does
  });
  it("the mode and write lock come from the operator's process environment, and the approval flag is mandatory and checked before any database read", () => {
    expect(code).toMatch(/process\.env\.PAYPAL_SANDBOX_WRITES !== "authorized"/);
    expect(code).toMatch(/process\.env\.PAYPAL_MODE !== "sandbox"/);
    expect(code).toMatch(/flag\("approve-stage5-capture"\)/);
    expect(code.indexOf('flag("approve-stage5-capture")')).toBeLessThan(code.indexOf("prisma.deal.findMany("));
    expect(code).not.toMatch(/writeFileSync\([^)]*env/i);
  });
  it("evidence is sanitized: it never reads the token, secret, approval link or request headers", () => {
    const evidenceBlock = code.slice(code.indexOf("const evidence = {"), code.indexOf("mkdirSync("));
    expect(evidenceBlock).not.toMatch(/PAYPAL_CLIENT_SECRET|access_token|approvalUrl|authorization:|Bearer/i);
  });
});
