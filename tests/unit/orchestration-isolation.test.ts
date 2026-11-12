/**
 * Static guarantees for Gate 5. The orchestrator is application-level coordination: it may use domain and verification code and the
 * narrow SettlementPort, and may NOT reach PayPal, the gateway, the settlement engine, or anything that computes or moves money.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { settlementInstructionSchema } from "@/orchestration/ports";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const importsOf = (f: string) => [...readFileSync(f, "utf8").matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const target = (f: string, spec: string) => relative(ROOT, resolve(dirname(f), spec)).replace(/\\/g, "/");

const files = walk(join(ROOT, "src", "orchestration"));

describe("the orchestrator cannot reach PayPal or compute money", () => {
  it("covers the expected files", () => {
    expect(files.map(rel).sort()).toEqual(["src/orchestration/idempotency.ts", "src/orchestration/integrity.ts", "src/orchestration/ports.ts", "src/orchestration/service.ts"]);
  });

  it("imports only an explicit allow-list (no paypal/, no settlement/, no budget, no signing)", () => {
    const REL_OK = new Set([
      "src/agents/buyer", "src/agents/seller-client", "src/domain/authorization", "src/domain/canonical", "src/domain/deals", "src/domain/ledger", "src/domain/mandates", "src/domain/negotiation",
      "src/domain/statemachine", "src/domain/terms", "src/domain/terms-v2", "src/verification/ai", "src/verification/contracts", "src/verification/delivery", "src/verification/pipeline",
    ]);
    for (const f of files) {
      for (const spec of importsOf(f)) {
        if (spec.startsWith(".")) {
          const t = target(f, spec);
          expect(t.startsWith("src/orchestration/") || REL_OK.has(t), `${rel(f)} imports ${spec} (${t})`).toBe(true);
        } else {
          expect(["zod", "node:crypto", "@prisma/client"], `${rel(f)} imports ${spec}`).toContain(spec);
        }
      }
    }
  });

  it("contains no PayPal, capture, void, amount or request-id construction", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // ignore comments
      expect(src, rel(f)).not.toMatch(/gateway|PayPal-Request-Id|captureBody|createOrderBody|\/v2\/|api-m\.|\bcapture\w*\s*\(|\bvoid\w*\s*\(|requestId|new Decimal|\bD\(|proportion\(|decideSettlement/i);
    }
  });

  it("the ONLY file that joins the orchestration port to the engine is src/settlement/port.ts", () => {
    const bridges = walk(join(ROOT, "src")).filter((f) => {
      const specs = importsOf(f).map((s) => (s.startsWith(".") ? target(f, s) : s));
      return specs.includes("src/orchestration/ports") && specs.includes("src/settlement/engine");
    });
    expect(bridges.map(rel)).toEqual(["src/settlement/port.ts"]);
    // and nothing under orchestration/ imports anything from settlement/
    for (const f of files) expect(importsOf(f).filter((s) => /settlement/.test(s))).toEqual([]);
  });

  it("no agent or seller-service file can import the orchestrator", () => {
    for (const f of [...walk(join(ROOT, "src", "agents")), ...walk(join(ROOT, "seller-service"))]) expect(importsOf(f).filter((s) => /orchestration/.test(s)), rel(f)).toEqual([]);
  });
});

describe("settlement instruction contract", () => {
  const ok = { kind: "SETTLE", dealId: "d1", verificationId: "v".repeat(16), termsHash: "a".repeat(64), resultHash: "b".repeat(64), idempotencyKey: "settle:vvvvvvvv" };
  it("accepts exactly the structured shape", () => {
    expect(settlementInstructionSchema.safeParse(ok).success).toBe(true);
  });
  it.each([
    ["an amount", { amount: "500.00" }],
    ["a decision", { decision: "FULL_CAPTURE" }],
    ["a PayPal id", { paypalOrderId: "ORD1" }],
    ["a different kind", { kind: "CAPTURE" }],
    ["a malformed hash", { termsHash: "xyz" }],
    ["a short verification id", { verificationId: "v" }],
  ])("refuses an instruction carrying %s", (_n, patch) => {
    expect(settlementInstructionSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});
