/** Stage 3 script: refusal paths (no request, no database access) and source guarantees. Nothing here contacts PayPal or the database. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const ID = "fake-client-id-for-the-stage-three-refusal-tests";
const SECRET = "fake-client-secret-must-never-appear";
const FP = createHash("sha256").update(ID).digest("hex").slice(0, 8);
const base = { PAYPAL_MODE: "sandbox", PAYPAL_SANDBOX_WRITES: "authorized", PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate_e2e" };
const run = (env: Record<string, string>, args: string[]) =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/paypal-e2e-stage3.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
const ok = ["--expect-order-id", "4ABCDEFGHJ1234567", "--stage1-evidence", "e1.json", "--stage2-evidence", "e2.json", "--expect-client-id-fingerprint", FP, "--expect-buyer-email", "b@personal.example.com", "--expect-business-email", "s@business.example.com"];

describe("scripts/paypal-e2e-stage3.ts refuses to start (exit 3, no request) unless every precondition holds", () => {
  it("nothing configured: exit 3 and a list of what is missing", () => {
    const r = run({}, ["--approve-stage3-authorize"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT STARTED. No request was made/);
    expect(r.stdout).toMatch(/PAYPAL_SANDBOX_WRITES=authorized must be set/);
  }, 100_000);
  it("the write lock not opened by the operator, mock mode, the wrong database or the wrong Client ID fingerprint: exit 3, even with the approval flag", () => {
    const { PAYPAL_SANDBOX_WRITES: _w, ...noWrites } = base;
    const a = run(noWrites, [...ok, "--approve-stage3-authorize"]);
    expect(a.status).toBe(3);
    expect(a.stdout).toMatch(/write lock is not open/);
    expect(a.stdout + a.stderr).not.toContain(SECRET);
    expect(run({ ...base, PAYPAL_MODE: "mock" }, [...ok, "--approve-stage3-authorize"]).status).toBe(3);
    expect(run({ ...base, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate" }, [...ok, "--approve-stage3-authorize"]).status).toBe(3);
    expect(run(base, [...ok.map((x) => (x === FP ? "00000000" : x)), "--approve-stage3-authorize"]).status).toBe(3);
    expect(run({ ...base, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, [...ok, "--approve-stage3-authorize"]).status).toBe(3);
  }, 300_000);
  it("a missing order id, evidence file or alias is refused", () => {
    expect(run(base, ["--approve-stage3-authorize"]).status).toBe(3);
    const noEvidence = run(base, ["--expect-order-id", "4ABCDEFGHJ1234567", "--expect-client-id-fingerprint", FP, "--expect-buyer-email", "b@x", "--expect-business-email", "s@x", "--approve-stage3-authorize"]);
    expect(noEvidence.status).toBe(3);
    expect(noEvidence.stdout).toMatch(/--stage1-evidence and --stage2-evidence are required/);
  }, 200_000);
  it("everything correct but NOT approved: prints the five-request plan and exits 4 without sending anything or printing a credential", () => {
    const r = run(base, ok);
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/NOT APPROVED: no request was made/);
    expect(r.stdout).toMatch(/exactly FIVE/);
    for (const needle of ["POST /v1/oauth2/token", "GET  /v2/checkout/orders/4ABCDEFGHJ1234567", "POST /v2/checkout/orders/4ABCDEFGHJ1234567/authorize", "GET  /v2/payments/authorizations/{authorizationId}"]) expect(r.stdout).toContain(needle);
    expect(r.stdout).toMatch(/will NOT\s+capture, void, refund, reauthorize or create an order/);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stdout).not.toMatch(/RESULT/);
  }, 100_000);
});

describe("source guarantees", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage3.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("the guard allows exactly five requests, one each, in a fixed order, installed before the only engine step", () => {
    expect([...code.matchAll(/name: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-fresh-order-read", "3-authorize", "4-readback-order", "5-read-authorization"]);
    expect(code.match(/max: 1(?:,| \})/g)).toHaveLength(5);
    expect([...code.matchAll(/after: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-fresh-order-read", "3-authorize", "4-readback-order"]);
    expect(code.indexOf("installOutboundGuard(")).toBeLessThan(code.indexOf("port.refreshApproval("));
    expect(code.match(/port\.refreshApproval\(/g)).toHaveLength(1);
  });
  it("no capture, void, refund, reauthorize, order creation, advance or spike reference anywhere in the script", () => {
    expect(code).not.toMatch(/\.advance\(|openDeal|createOrder|createPayPalOrder|settleDeal|requestSettlement|acceptVerification|cancelAuthorization|captureAuthorized|voidPayment|reauthorizePayment|"REAUTHORIZE"|refund\(|\.spike/); // case-sensitive, calls only: the printed plan and the notDone list legitimately name them
    expect(code).not.toMatch(/prisma\.[a-zA-Z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/); // the engine writes its own records; the script itself never does
  });
  it("the mode and write lock come from the operator's process environment, and the approval flag is mandatory", () => {
    expect(code).toMatch(/process\.env\.PAYPAL_SANDBOX_WRITES !== "authorized"/);
    expect(code).toMatch(/flag\("approve-stage3-authorize"\)/);
    expect(code).not.toMatch(/writeFileSync\([^)]*env/i);
  });
});

describe("--validate-offline", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage3.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("exits before any gateway, token or guard-permitted request exists, and does not require the write lock to be open", () => {
    const block = code.slice(code.indexOf("if (validateOnly) {"), code.indexOf("// ---- the real gateway"));
    expect(block).toMatch(/installOutboundGuard\(\[\]\)/);
    expect(block).toMatch(/process\.exit\(0\)/);
    expect(code.indexOf("if (validateOnly) {")).toBeLessThan(code.indexOf("createSandboxSdkGateway("));
    expect(code).toMatch(/!validateOnly && process\.env\.PAYPAL_SANDBOX_WRITES !== "authorized"/);
    expect(code).toMatch(/!validateOnly && !flag\("approve-stage3-authorize"\)/);
  });
});
