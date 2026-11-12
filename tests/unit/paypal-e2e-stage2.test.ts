/** Stage 2 script: refusal paths (no request, no database access) and source guarantees. Nothing here contacts PayPal or the database. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const ID = "fake-client-id-for-the-stage-two-refusal-tests";
const SECRET = "fake-client-secret-must-never-appear";
const FP = createHash("sha256").update(ID).digest("hex").slice(0, 8);
const base = { PAYPAL_MODE: "sandbox", PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate_e2e" };
const run = (env: Record<string, string>, args: string[]) =>
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/paypal-e2e-stage2.ts", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
const verifyArgs = ["--verify-approval", "--expect-client-id-fingerprint", FP, "--expect-buyer-email", "b@personal.example.com", "--expect-business-email", "s@business.example.com"];

describe("scripts/paypal-e2e-stage2.ts refuses to start (exit 3) unless the preconditions hold", () => {
  it("no mode, or both modes: refused", () => {
    expect(run(base, []).status).toBe(3);
    expect(run(base, ["--open-checkout", "--verify-approval"]).status).toBe(3);
  }, 100_000);
  it("an OPEN write lock refuses both modes (Stage 2 must run with writes closed)", () => {
    for (const mode of [["--open-checkout"], [...verifyArgs, "--approve-stage2-read"]]) {
      const r = run({ ...base, PAYPAL_SANDBOX_WRITES: "authorized" }, mode);
      expect(r.status).toBe(3);
      expect(r.stdout).toMatch(/write lock must be CLOSED/);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
    }
  }, 200_000);
  it("the wrong database is refused", () => {
    const r = run({ ...base, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/mandate" }, ["--open-checkout"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/dedicated database mandate_e2e/);
  }, 100_000);
  it("verify mode needs the approval flag, the Client ID fingerprint, both expected aliases and Sandbox mode", () => {
    const noFlag = run(base, verifyArgs);
    expect(noFlag.status).toBe(3);
    expect(noFlag.stdout).toMatch(/NOT APPROVED/);
    expect(run(base, ["--verify-approval", "--approve-stage2-read"]).status).toBe(3);
    expect(run(base, [...verifyArgs.map((a) => (a === FP ? "00000000" : a)), "--approve-stage2-read"]).status).toBe(3);
    expect(run({ ...base, PAYPAL_MODE: "mock" }, [...verifyArgs, "--approve-stage2-read"]).status).toBe(3);
    expect(run({ ...base, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, [...verifyArgs, "--approve-stage2-read"]).status).toBe(3);
  }, 300_000);
});

describe("source guarantees", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage2.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("the verification guard allows exactly one token request and one read of the expected order, and the open mode allows nothing", () => {
    expect([...code.matchAll(/name: "([^"]+)"/g)].map((m) => m[1])).toEqual(["1-oauth-token", "2-read-order"]);
    expect(code.match(/max: 1 \}/g)).toHaveLength(2);
    expect(code).toMatch(/installOutboundGuard\(\[\]\)/);
    expect(code).toMatch(/new SandboxWriteLock\(createSandboxSdkGateway\([^)]*\)[^)]*, false\)/);
    expect(code.match(/gateway\.getOrder\(/g)).toHaveLength(1);
  });
  it("no money operation, no order creation, no database write, no spike reference", () => {
    expect(code).not.toMatch(/\.write\(|authorizeOrder|captureAuthorized|voidPayment|reauthorize|createOrder|\.advance\(|openDeal|settleDeal|\.spike/i);
    expect(code).not.toMatch(/prisma\.[a-zA-Z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw|\$transaction/);
  });
  it("the open mode only opens the recorded Sandbox checkout page for the expected order, in incognito", () => {
    expect(code).toMatch(/u\.hostname === "www\.sandbox\.paypal\.com" && u\.pathname === "\/checkoutnow" && u\.searchParams\.get\("token"\) === EXPECTED_ORDER/);
    expect(code).toMatch(/"--incognito"/);
  });
});

describe("no order id is built into the Stage 2 script; it must be named and cross-checked", () => {
  const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage2.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("without --expect-order-id and --stage1-evidence every mode is refused (exit 3, no request)", () => {
    for (const mode of [["--validate-offline"], ["--open-checkout"], [...verifyArgs, "--approve-stage2-read"]]) {
      const r = run(base, mode);
      expect(r.status).toBe(3);
      expect(r.stdout).toMatch(/--expect-order-id is required/);
      expect(r.stdout).toMatch(/--stage1-evidence <file> is required/);
    }
  }, 300_000);
  it("a malformed order id is refused, and the offline validation also refuses an open write lock", () => {
    expect(run(base, ["--validate-offline", "--expect-order-id", "x y;z", "--stage1-evidence", "e.json"]).status).toBe(3);
    const r = run({ ...base, PAYPAL_SANDBOX_WRITES: "authorized" }, ["--validate-offline", "--expect-order-id", "4ABCDEFGHJ1234567", "--stage1-evidence", "e.json"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/write lock must be CLOSED/);
  }, 200_000);
  it("the source contains no PayPal order id literal (neither the abandoned one nor the current one), and cross-checks the evidence, the deal and the approval link", () => {
    expect(code).not.toMatch(/["'`][0-9][A-Z0-9]{15,17}["'`]/);
    expect(code).not.toContain("4R58521703025521B");
    expect(code).toMatch(/ev\.order\?\.id !== EXPECTED_ORDER/);
    expect(code).toMatch(/ev\.deal\?\.id !== deal\.id/);
    expect(code).toMatch(/u\.searchParams\.get\("token"\) === EXPECTED_ORDER/);
  });
  it("the offline validation mode installs an empty guard and neither opens a browser nor reads PayPal", () => {
    const block = code.slice(code.indexOf("if (validateOnly) {"), code.indexOf("if (open) {"));
    expect(block).toMatch(/installOutboundGuard\(\[\]\)/);
    expect(block).not.toMatch(/spawn\(|getOrder|createSandboxSdkGateway/);
  });
});
