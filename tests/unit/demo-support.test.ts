/** Demo support pieces: the Sandbox write lock, the seller simulator's deliveries, and the AI smoke script's safe exits. No network, no database, no model. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SandboxWriteLock } from "@/lib/runtime";
import type { GwResult, PayPalGateway } from "@/paypal/gateway";
import { deliverResponseSchema, type DeliverRequest } from "@/agents/contracts";
import { buildDelivery } from "../../seller-service/delivery";

vi.mock("@/db/client", () => ({ prisma: {} })); // importing the runtime must not open a database connection in a unit test

const okResult: GwResult = { kind: "ok", status: 200, body: {} };
const inner = () => {
  const g = { write: vi.fn(async () => okResult), getOrder: vi.fn(async () => okResult), getAuthorization: vi.fn(async () => okResult), getCapture: vi.fn(async () => okResult) };
  return g satisfies PayPalGateway;
};

describe("Sandbox write lock", () => {
  it("refuses every write when not authorized, without reaching the inner gateway, and reports a definitive rejection", async () => {
    const g = inner();
    const lock = new SandboxWriteLock(g, false);
    for (const t of ["CREATE_ORDER", "AUTHORIZE", "CAPTURE", "VOID", "REAUTHORIZE"] as const) {
      const r = await lock.write(t, { requestId: "r", path: "/v2/x", body: {} });
      expect(r.kind).toBe("rejected");
    }
    expect(g.write).not.toHaveBeenCalled();
  });
  it("passes writes through only when authorized, and always allows reads", async () => {
    const g = inner();
    const open = new SandboxWriteLock(g, true);
    expect((await open.write("CREATE_ORDER", { requestId: "r", path: "/v2/x" })).kind).toBe("ok");
    expect(g.write).toHaveBeenCalledTimes(1);
    const locked = new SandboxWriteLock(g, false);
    await locked.getOrder("O1");
    await locked.getAuthorization("A1");
    await locked.getCapture("C1");
    expect(g.getOrder).toHaveBeenCalled();
  });
});

describe("seller simulator deliveries (synthetic data)", () => {
  const criteria: DeliverRequest["criteria"] = [
    { id: "schema", text: "s", type: "deterministic", required: true, weight: 50, validator: "csv_schema_matches", params: { columns: ["id", "email", "joined"] } },
    { id: "dates", text: "d", type: "deterministic", required: false, weight: 50, validator: "date_format_valid", params: { column: "joined", format: "YYYY-MM-DD" } },
  ];
  const req = (quality: DeliverRequest["quality"]): DeliverRequest => ({ dealId: "d1", termsHash: "a".repeat(64), criteria, quality });

  it("every quality yields a manifest that matches its artifact and satisfies the strict contract", async () => {
    for (const q of ["good", "duplicates", "injection"] as const) {
      const out = await buildDelivery(req(q));
      expect(deliverResponseSchema.safeParse(out).success, q).toBe(true);
      expect(out.manifest.artifactSha256).toBe(createHash("sha256").update(out.artifactText).digest("hex"));
      expect(out.manifest.artifactSize).toBe(Buffer.byteLength(out.artifactText));
      expect(out.manifest.dealId).toBe("d1");
      expect(out.artifactText.split("\n")[0]).toBe("id,email,joined");
    }
  });
  it("good has unique rows and valid dates; duplicates repeats a row; injection hides an instruction in a cell", async () => {
    const rows = (t: string) => t.trim().split("\n").slice(1);
    const good = rows((await buildDelivery(req("good"))).artifactText);
    expect(new Set(good).size).toBe(good.length);
    expect(good.every((r) => /,\d{4}-\d{2}-\d{2}$/.test(r))).toBe(true);
    const dup = rows((await buildDelivery(req("duplicates"))).artifactText);
    expect(new Set(dup).size).toBeLessThan(dup.length);
    expect((await buildDelivery(req("injection"))).artifactText).toMatch(/Ignore all previous instructions/);
  });
});

describe("ai-smoke script safe exits", () => {
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/ai-smoke.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  it("without credentials: NOT CONFIGURED, exit 3, no request", () => {
    const r = run({});
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT CONFIGURED/);
  });
  it("with credentials but without --authorize-calls: prints the plan, exit 4, never prints the key", () => {
    const key = "sk-test-do-not-print-0123456789";
    const r = run({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: key, LLM_MODEL_AGENTS: "model-x" });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/NOT AUTHORIZED/);
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(r.stdout).toMatch(/at most 2/);
  });
  it("Groq: NOT CONFIGURED without its own key (a Gemini key does not count); exit 4 without --authorize-calls; the key is never printed", () => {
    const g = run({ LLM_PROVIDER: "groq", GEMINI_API_KEY: "k-gemini-only", LLM_MODEL_AGENTS: "model-x" });
    expect(g.status).toBe(3);
    expect(g.stdout).toMatch(/GROQ_API_KEY/);
    const key = "gsk-test-do-not-print-0123456789";
    const r = run({ LLM_PROVIDER: "groq", GROQ_API_KEY: key, LLM_MODEL_AGENTS: "model-x" });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/provider\s+groq/);
    expect(r.stdout + r.stderr).not.toContain(key);
  }, 40_000); // two tsx process starts
});
