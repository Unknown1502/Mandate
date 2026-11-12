/**
 * P0 / W1 model-isolation gate: pure and static tests. No database, no network, no real model (providers are SCRIPTED).
 * The canary tests here include a POSITIVE CONTROL: they prove the probe can see artifact text when a model IS called, so a
 * "canary not observed" result elsewhere is meaningful.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmAiVerifier, LlmSkepticAgent, type AiContext } from "@/verification/ai";
import { parseCsv, toCsv } from "@/verification/csv";
import { DEFAULT_LANGUAGE_POLICY } from "@/verification/language";
import { MODEL_BLOCKED_REASON, UnclassifiableTermsError, modelPolicyFor } from "@/verification/model-gate";
import { ScriptedLlm } from "../helpers/scripted";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const det = { type: "deterministic" as const };
const llm = { type: "llm_judged" as const };

describe("modelPolicyFor: decides from the parsed criteria of the locked terms, fails closed on anything else", () => {
  it("deterministic-only terms: no model is permitted", () => {
    expect(modelPolicyFor([det, det])).toEqual({ permitted: false, hasLlmCriteria: false, reason: "NO_LLM_CRITERIA" });
  });
  it("terms with an llm_judged criterion: AI-based verification is blocked (P0: no V2 exists yet)", () => {
    expect(modelPolicyFor([det, llm])).toEqual({ permitted: false, hasLlmCriteria: true, reason: "LLM_CRITERIA_BLOCKED_PENDING_V2" });
    expect(modelPolicyFor([llm])).toMatchObject({ permitted: false, hasLlmCriteria: true });
  });
  it("an unknown or missing criterion type, an empty list, or a non-list throws (the caller fails closed)", () => {
    for (const bad of [[{ type: "oracle" }], [det, { type: "" }], [det, {}], [det, { type: undefined }], [det, null], [], undefined, null, "llm_judged"]) {
      expect(() => modelPolicyFor(bad as never), JSON.stringify(bad)).toThrow(UnclassifiableTermsError);
    }
  });
  it("the policy never permits a model, whatever the criteria", () => {
    for (const set of [[det], [llm], [det, llm], [llm, llm, det]]) expect(modelPolicyFor(set).permitted).toBe(false);
    expect(MODEL_BLOCKED_REASON).toBe("LEGACY_TERMS_NO_INPUT_BOUNDARY");
  });
});

describe("static: the only paths to a model are the ones the gate controls", () => {
  const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

  it("the pipeline calls assess() only on the gated handles, and obtains them through modelPolicyFor", () => {
    const s = src("src/verification/pipeline.ts");
    expect(s).toContain("modelPolicyFor(");
    const callees = [...s.matchAll(/([A-Za-z_][\w.]*)\.assess\(/g)].map((m) => m[1]).sort();
    expect(callees).toEqual(["models.ai", "models.skeptic"]);
    expect(s).not.toMatch(/\bd\.ai\.assess|\bd\.skeptic\.assess/);
  });

  it("callLLM has exactly three call sites (legacy V1 verifier/skeptic in ai.ts, the P4 ModelRunner, negotiation buyer) and a provider is only ever invoked inside callLLM (or the runner's counting wrapper)", () => {
    const files = walk(join(ROOT, "src")).map(rel);
    const callers = files.filter((f) => /(^|[^\w.])callLLM\(/.test(src(f)) && !/export async function callLLM/.test(src(f)));
    expect(callers.sort()).toEqual(["src/agents/buyer.ts", "src/verification/ai.ts", "src/verification/model-runner.ts"]);
    const providerInvokers = files.filter((f) => /\.complete\(/.test(src(f)));
    expect(providerInvokers).toEqual(["src/agents/llm.ts", "src/verification/model-runner.ts"]);
  });

  it("model-gate.ts imports only a type from the terms module (no agents, database, PayPal or settlement code)", () => {
    const imports = [...src("src/verification/model-gate.ts").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../domain/terms"]);
  });

  it("the buyer agent source cannot import verification, delivery or settlement code (the buyer sees negotiation context only)", () => {
    const s = src("src/agents/buyer.ts");
    for (const spec of [...s.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)) expect(spec, spec).not.toMatch(/verification|delivery|settlement|orchestration|prisma/);
  });
});

describe("canary positive control: when a model IS called directly, the artifact text DOES reach the provider", () => {
  const canary = `CANARY-${randomUUID()}`;
  const csv = parseCsv(toCsv(["id", "email"], [["1", canary]]));
  const ctx: AiContext = { criteria: [{ id: "quality", text: "looks plausible", type: "llm_judged", required: true, weight: 100 }], checks: [], csv, sha12: "abcdef123456", metadata: { note: canary }, evidence: {} as never, language: DEFAULT_LANGUAGE_POLICY };

  it("verifier prompt carries the cell and the metadata", async () => {
    const provider = new ScriptedLlm([JSON.stringify({ assessments: [], observations: [], summary: "s" })]);
    await new LlmAiVerifier(provider, "scripted").assess(ctx, 1);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests).includes(canary)).toBe(true);
  });
  it("skeptic prompt carries the cell and the metadata", async () => {
    const provider = new ScriptedLlm([JSON.stringify({ flags: [] })]);
    await new LlmSkepticAgent(provider, "scripted").assess(ctx);
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests).includes(canary)).toBe(true);
  });
});
