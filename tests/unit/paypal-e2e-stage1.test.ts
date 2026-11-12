/** Stage 1 script: every refusal path, tested WITHOUT any PayPal request (each exits before the guard, the database or the SDK is used), plus source guarantees. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const ID = "fake-client-id-for-the-stage-one-refusal-tests";
const SECRET = "fake-client-secret-must-never-appear";
const FP = createHash("sha256").update(ID).digest("hex").slice(0, 8);
const good = { PAYPAL_MODE: "sandbox", PAYPAL_SANDBOX_WRITES: "authorized", PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate_e2e" };
const run = (env: Record<string, string>, args: string[]) =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/paypal-e2e-stage1.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
const ok = ["--expect-client-id-fingerprint", FP, "--expect-business-email", "sb-test@business.example.com"];
const text = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("scripts/paypal-e2e-stage1.ts refuses to start (exit 3, no request) unless every precondition holds", () => {
  it("nothing configured: exit 3 and a list of what is missing", () => {
    const r = run({}, ["--approve-stage1-three-requests"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT STARTED. No request was made/);
    expect(r.stdout).toMatch(/PAYPAL_MODE must be set to sandbox/);
    expect(r.stdout).toMatch(/PAYPAL_SANDBOX_WRITES=authorized must be set/);
  }, 100_000);
  it("the write lock not opened by the operator: exit 3, even with the approval flag", () => {
    const { PAYPAL_SANDBOX_WRITES: _w, ...noWrites } = good;
    const r = run(noWrites, [...ok, "--approve-stage1-three-requests"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/write lock is not open/);
    expect(text(r)).not.toContain(SECRET);
  }, 100_000);
  it("mock mode, a wrong database, a wrong Client ID fingerprint, or the production host: exit 3", () => {
    expect(run({ ...good, PAYPAL_MODE: "mock" }, [...ok, "--approve-stage1-three-requests"]).status).toBe(3);
    const db = run({ ...good, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate" }, [...ok, "--approve-stage1-three-requests"]);
    expect(db.status).toBe(3);
    expect(db.stdout).toMatch(/dedicated database mandate_e2e/);
    const wrongFp = run(good, ["--expect-client-id-fingerprint", "00000000", "--expect-business-email", "x@business.example.com", "--approve-stage1-three-requests"]);
    expect(wrongFp.status).toBe(3);
    expect(wrongFp.stdout).toMatch(/fingerprint does not match/);
    expect(run({ ...good, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, [...ok, "--approve-stage1-three-requests"]).status).toBe(3);
    expect(run(good, ["--approve-stage1-three-requests"]).status).toBe(3); // the expected fingerprint and business alias are mandatory
  }, 200_000);
  it("everything correct but NOT approved: prints the plan and exits 4 without sending anything or printing a credential", () => {
    const r = run(good, ok);
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/NOT APPROVED: no request was made/);
    expect(r.stdout).toMatch(/exactly THREE/);
    expect(r.stdout).toMatch(/will NOT\s+start buyer checkout, approve, authorize, capture, void or refund/);
    expect(text(r)).not.toContain(SECRET);
    expect(text(r)).not.toContain(ID);
    expect(r.stdout).not.toMatch(/RESULT/);
  }, 100_000);
});

describe("source guarantees", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage1.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("the guard allows exactly three request kinds, one each, and is installed before the only operation", () => {
    expect([...code.matchAll(/name: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-create-order", "3-read-order"]);
    expect(code.match(/max: 1 \}/g)).toHaveLength(3);
    expect(code.indexOf("installOutboundGuard(")).toBeGreaterThan(-1);
    expect(code.indexOf("installOutboundGuard(")).toBeLessThan(code.indexOf("orchestrator.openDeal("));
    expect(code.match(/orchestrator\.openDeal\(/g)).toHaveLength(1);
  });
  it("the buyer-approval poll is replaced by a local answer, and no money operation beyond the order is called anywhere in the script", () => {
    expect(code).toMatch(/refreshApproval: async \(dealId\) => \(\{ status: "WAITING"/);
    expect(code).not.toMatch(/\.advance\(|authorizeOrder|captureAuthorized|voidPayment|reauthorize|refund\(|settleDeal|acceptVerification|\.spike/i);
  });
  it("the process-level mode and write lock are required from the operator and the persistent env file is never written", () => {
    expect(code).toMatch(/process\.env\.PAYPAL_SANDBOX_WRITES !== "authorized"/);
    expect(code).not.toMatch(/writeFileSync\([^)]*env/i);
  });
});
