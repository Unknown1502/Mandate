/**
 * Repository-wide architecture checks for the P0 model-isolation boundary (docs/15 s15.9.0, s15.21).
 *
 * These are STATIC checks over the source text. They make it fail the build when a future module could place artifact-derived text in front of a model
 * from OUTSIDE the protected pipeline: instantiating or calling the artifact-bearing verifier / skeptic, calling `callLLM`, creating a provider, or
 * reaching the vendor over HTTP. They cannot prove behaviour; the behavioural proof is tests/db/model-isolation.db.test.ts (scripted providers + canaries).
 * They also show that the test-only gate override used by the dormant-defence tests is not part of production code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|js|mjs)$/.test(n) ? [p] : [];
  });
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
/** comments are not code: a mention in prose must not trip (or hide) a check */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

const PRODUCTION = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "seller-service"))].map(rel).sort();
const withText = (re: RegExp, files = PRODUCTION) => files.filter((f) => re.test(code(read(f))));

describe("the approved model-consumer inventory is closed (production source: src/ and seller-service/)", () => {
  it("found the production tree we expect to police", () => {
    expect(PRODUCTION.length).toBeGreaterThan(40);
    expect(PRODUCTION).toContain("src/verification/pipeline.ts");
    expect(PRODUCTION.some((f) => f.startsWith("seller-service/"))).toBe(true);
  });

  it("callLLM is CALLED only by the legacy V1 verifier/skeptic (ai.ts; permanently gated off by the P0 gate), the P4 ModelRunner and the negotiation buyer", () => {
    const callers = withText(/(^|[^\w.])callLLM\(/).filter((f) => !/export async function callLLM/.test(code(read(f))));
    expect(callers).toEqual(["src/agents/buyer.ts", "src/verification/ai.ts", "src/verification/model-runner.ts"]);
  });

  it("a provider is invoked (.complete) only inside callLLM, and the vendor endpoint appears only in the provider", () => {
    // P4: the ModelRunner wraps the provider to count tokens; that wrapper is only ever handed to callLLM
    expect(withText(/\.complete\(/)).toEqual(["src/agents/llm.ts", "src/verification/model-runner.ts"]);
    expect(code(read("src/verification/model-runner.ts")).match(/\.complete\(/g)).toHaveLength(1);
    // the vendor SDK is imported only by the provider module, and no vendor endpoint string appears anywhere else
    expect(withText(/@google\/genai/)).toEqual(["src/agents/llm.ts"]);
    expect(withText(/groq-sdk/)).toEqual(["src/agents/llm.ts"]);
    expect(withText(/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis|api\.groq\.com|openrouter\.ai/)).toEqual([]);
  });

  it("nothing in production source CREATES a provider or an artifact-bearing verifier/skeptic", () => {
    // providers are constructed only inside the single factory in llm.ts; the demo composition root (src/lib/runtime.ts) is the ONLY production caller of that factory, and only to back the
    // Buyer Agent brain (negotiation). The verifier and skeptic never get one.
    expect(withText(/new\s+(?:Gemini|Groq)Provider\s*\(/)).toEqual(["src/agents/llm.ts"]);
    expect(withText(/createLlmProvider\s*\(/)).toEqual(["src/agents/llm.ts", "src/lib/runtime.ts"]);
    expect(code(read("src/lib/runtime.ts"))).not.toMatch(/LlmAiVerifier|LlmSkepticAgent|\bverify\s*:|ModelRunner/);
    expect(code(read("src/lib/runtime.ts")).match(/new\s+LlmBuyerBrain\(createLlmProvider\(/g)).toHaveLength(1);
    expect(withText(/new\s+LlmAiVerifier\s*\(/)).toEqual([]);
    expect(withText(/new\s+LlmSkepticAgent\s*\(/)).toEqual([]);
  });

  it("the verifier/skeptic implementations are named only in the module that defines them", () => {
    expect(withText(/\bLlmAiVerifier\b|\bLlmSkepticAgent\b/)).toEqual(["src/verification/ai.ts"]);
    expect(withText(/\bGeminiProvider\b|\bGroqProvider\b/)).toEqual(["src/agents/llm.ts"]);
    expect(withText(/AnthropicProvider/)).toEqual([]);
  });

  it(".assess( is called only by the verification pipeline (the single gated call site), including via optional chaining", () => {
    expect(withText(/\.assess\s*\(|\?\.\s*assess\s*\(|\[\s*["']assess["']\s*\]/)).toEqual(["src/verification/pipeline.ts"]);
  });

  it("only the pipeline and the orchestrator (types) import the verification/ai module; only buyer, ai, pipeline (types) and negotiation (types) import agents/llm", () => {
    const importers = (re: RegExp) => withText(re);
    // P4: pipeline-v2 reuses the evidence-validating, output-merging functions of ai.ts (never its LLM classes); only the ModelRunner (plus buyer, negotiation types, ai, pipeline types) imports agents/llm
    expect(importers(/from\s+["'](?:\.\.\/verification\/ai|\.\/ai|@\/verification\/ai)["']/)).toEqual(["src/orchestration/service.ts", "src/verification/pipeline-v2.ts", "src/verification/pipeline.ts"]);
    expect(importers(/from\s+["'](?:\.\.\/agents\/llm|\.\/llm|@\/agents\/llm)["']/)).toEqual(["src/agents/buyer.ts", "src/domain/negotiation.ts", "src/lib/runtime.ts", "src/verification/ai.ts", "src/verification/model-runner.ts", "src/verification/pipeline.ts"]);
  });

  it("P4: model authority is derived, and a ModelRunner is used, only inside the verification layer; nothing in production source constructs a ModelRunner", () => {
    expect(withText(new RegExp("deriveModelAuthorization"))).toEqual(["src/verification/model-input.ts", "src/verification/pipeline-v2.ts"]);
    expect(withText(new RegExp("buildModelInput"))).toEqual(["src/verification/model-input.ts", "src/verification/pipeline-v2.ts"]);
    expect(withText(/new\s+ModelRunner\s*\(/)).toEqual([]);
    expect(withText(new RegExp("ModelRunner"))).toEqual(["src/verification/model-runner.ts", "src/verification/pipeline-v2.ts"]);
  });

  it("final directive: a model input can be language-cleared only by assessAndClear; the V2 release gate is evaluated only by the gate module and its loader", () => {
    expect(withText(new RegExp("markLanguageCleared"))).toEqual(["src/verification/language-v2.ts", "src/verification/model-input.ts"]);
    expect(withText(new RegExp("assessAndClear"))).toEqual(["src/verification/language-v2.ts", "src/verification/pipeline-v2.ts"]);
    expect(withText(new RegExp("evaluateV2Gate"))).toEqual(["src/domain/v2-release-gate.ts", "src/lib/v2-gate-loader.ts"]);
    expect(withText(new RegExp("issueReleaseRecord"))).toEqual(["src/domain/v2-release-gate.ts"]);
    // the runner enforces its own checks before any provider call
    const runner = code(read("src/verification/model-runner.ts"));
    for (const needle of ["isLanguageCleared", "DETECTOR_MISMATCH", "AUTHORIZATION_STALE", "CRITERION_NOT_APPROVED", "APPROVAL_EVIDENCE_MISSING"]) expect(runner, needle).toContain(needle);
    expect(runner.indexOf("LANGUAGE_NOT_ASSESSED")).toBeLessThan(runner.indexOf("callLLM({"));
  });

  it("outbound HTTP from production source is limited to the provider, the seller client and the PayPal client", () => {
    expect(withText(/(^|[^\w.])fetch\s*\(|\bfetchImpl\b|\bhttps?\.request\s*\(|\baxios\b|\bXMLHttpRequest\b|new\s+WebSocket\s*\(/)).toEqual(["src/agents/seller-client.ts", "src/app/ui/api.ts", "src/paypal/client.ts"]); // the Gemini SDK does its own HTTP inside src/agents/llm.ts: no fetch and no URL in our code
    // src/app/ui/api.ts is the BROWSER client of this app's own API: it fetches only a relative /api/... path and holds no host, key or provider
    const ui = code(read("src/app/ui/api.ts"));
    expect(ui.match(/fetch\(/g)).toHaveLength(1);
    expect(ui).toMatch(/fetch\(path,/);
    expect(ui).not.toMatch(/https?:\/\//);
  });

  it("the HTTP routes under src/app never build a model client", () => {
    const routes = PRODUCTION.filter((f) => f.startsWith("src/app/"));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) expect(code(read(f)), f).not.toMatch(/agents\/llm|verification\/ai|callLLM|Provider/);
  });
});

describe("the only repository script that reaches a real model sends a fixed non-artifact prompt", () => {
  it("only scripts/ai-smoke.ts (bounded, authorized, synthetic) calls a model outside src/", () => {
    // the two mutation runners hold the source text of deliberately malicious mutants as DATA (strings); they execute no model call
    const MUTATION_RUNNERS = ["attack-lab/mutate.ts", "attack-lab/mutate-layers.ts"];
    const outside = [...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "attack-lab"))].map(rel).filter((f) => !f.includes("/reports/") && !MUTATION_RUNNERS.includes(f));
    const callers = outside.filter((f) => /(^|[^\w.])callLLM\(|createLlmProvider\(|new\s+(?:Gemini|Groq)Provider\s*\(/.test(code(read(f))));
    expect(callers).toEqual(["scripts/ai-smoke.ts"]);
    // the demo AI smoke test: synthetic prompts built by the Buyer Agent's own builders, a hard cap of two requests, explicit authorization, and no database / PayPal / settlement import
    const smoke = read("scripts/ai-smoke.ts");
    expect(smoke).toMatch(/MAX_REQUESTS = 2/);
    expect(smoke).toMatch(/flag\("authorize-calls"\)/);
    expect(smoke).toMatch(/maxAttempts: 1/);
    const imports = [...smoke.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../src/agents/buyer", "../src/agents/contracts", "../src/agents/llm", "node:fs", "node:path"].sort());
  });
});

describe("the test-only gate override cannot be a runtime bypass", () => {
  it("model-gate.ts exports exactly the decision function, its error and its reason constant: no setter, no override, no environment switch", () => {
    const s = code(read("src/verification/model-gate.ts"));
    const exported = [...s.matchAll(/export\s+(?:const|class|function|interface|type)\s+(\w+)/g)].map((m) => m[1]).sort();
    expect(exported).toEqual(["MODEL_BLOCKED_REASON", "ModelPolicy", "ModelPolicyReason", "UnclassifiableTermsError", "modelPolicyFor"]);
    expect(s).not.toMatch(/process\.env|globalThis|setModelPolicy|override|testOnly|__test/i);
  });

  it("no production source reads an environment variable that could select a model policy, imports a test framework, or mocks anything", () => {
    for (const f of PRODUCTION) {
      const s = code(read(f));
      expect(s, f).not.toMatch(/from\s+["']vitest["']|\bvi\.(mock|doMock|spyOn|stubEnv)\b/);
      expect(s, f).not.toMatch(/process\.env\.[A-Z_]*(MODEL_POLICY|MODEL_GATE|ALLOW_MODEL|PERMIT_MODEL|MODELS_ENABLED|DISABLE_MODEL_GATE)/);
    }
  });

  it("the pipeline obtains models only through modelPolicyFor, imported from the one gate module", () => {
    const s = code(read("src/verification/pipeline.ts"));
    expect(s).toMatch(/import\s*\{[^}]*\bmodelPolicyFor\b[^}]*\}\s*from\s*["']\.\/model-gate["']/);
    expect(withText(/\bmodelPolicyFor\b/)).toEqual(["src/verification/model-gate.ts", "src/verification/pipeline.ts"]);
  });

  it("the gate is substituted only by vitest module mocks, and only in these named test files", () => {
    const testFiles = walk(join(ROOT, "tests")).map(rel).filter((f) => f !== "tests/unit/model-boundary-architecture.test.ts");
    const mockers = testFiles.filter((f) => /vi\.mock\(\s*["']@\/verification\/model-gate["']/.test(read(f))).sort();
    expect(mockers).toEqual([
      "tests/db/dormant-downstream-defences.db.test.ts",
      "tests/db/orchestration.db.test.ts",
      "tests/db/verification-integration.db.test.ts",
      "tests/db/verification.db.test.ts",
    ]);
    // the real gate is exercised unmocked by the P0 boundary tests
    for (const f of ["tests/db/model-isolation.db.test.ts", "tests/unit/model-gate.test.ts"]) expect(read(f), f).not.toMatch(/vi\.mock\(/);
  });
});
