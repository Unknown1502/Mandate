/**
 * Gemini as the Buyer Agent brain, on real PostgreSQL (mandate_test) with a FAKE SDK client: no network, no key, no real model.
 *  - the runtime reports exactly which provider/model is configured, and an incomplete configuration is reported as such (rule-based, never as AI);
 *  - a Gemini failure BLOCKS the negotiation with the reason and records the failed run; it never falls back to the rule-based brain;
 *  - a Gemini success is validated by the deterministic checks (a price above the ceiling is rejected) and its tokens are recorded.
 */
import { describe, expect, it, vi } from "vitest";
import { BuyerAgent, LlmBuyerBrain } from "@/agents/buyer";
import { GeminiProvider } from "@/agents/llm";
import { createDeal } from "@/domain/deals";
import { runNegotiation, type TaskBrief } from "@/domain/negotiation";
import { buildRuntime } from "@/lib/runtime";
import { deps, keys, makeMandate, makePrincipal, prisma } from "./fixtures";

const brief: TaskBrief = {
  description: "Clean the CSV (synthetic)",
  criteria: [{ id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: true, weight: 100 }],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice: "20.00",
};
const sellerAccepts = { negotiate: async () => ({ ok: true as const, body: { kind: "accept" as const } }) };
const sdk = (impl: () => Promise<unknown>) => ({ models: { generateContent: vi.fn(impl) } }) as never;

async function negotiate(client: never) {
  const p = await makePrincipal();
  const m = await makeMandate(p);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  const buyer = new BuyerAgent(new LlmBuyerBrain(new GeminiProvider("test-key", "gemini-test-model", client), "gemini-test-model"));
  const out = await runNegotiation({ db: prisma, buyer, seller: sellerAccepts, policy: deps, maxRounds: 4 }, { dealId: deal.id, principalId: p.id, brief });
  return { out, dealId: deal.id };
}

describe("runtime reports the exact provider and model, and incomplete configuration honestly", () => {
  const base = { ...process.env, PAYPAL_MODE: "mock", LLM_PROVIDER: undefined, GEMINI_API_KEY: undefined, GROQ_API_KEY: undefined, LLM_MODEL_AGENTS: undefined, SELLER_URL: "http://127.0.0.1:1" };
  it("configured: Live AI, vendor gemini, the configured model id", () => {
    const rt = buildRuntime({ ...base, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-123", LLM_MODEL_AGENTS: "gemini-3.5-flash-lite" });
    expect(rt.info).toMatchObject({ buyerBrain: "llm", llmVendor: "gemini", llmModel: "gemini-3.5-flash-lite", llmConfig: "configured", llmConfigNote: null });
  });
  it("not requested: rule-based, nothing claimed", () => {
    expect(buildRuntime(base).info).toMatchObject({ buyerBrain: "rule-based", llmVendor: null, llmModel: null, llmConfig: "not_requested" });
  });
  it("requested but incomplete (no key, wrong provider): rule-based AND flagged as incomplete with the missing names", () => {
    const a = buildRuntime({ ...base, LLM_PROVIDER: "gemini", LLM_MODEL_AGENTS: "m" });
    expect(a.info).toMatchObject({ buyerBrain: "rule-based", llmConfig: "incomplete" });
    expect(a.info.llmConfigNote).toMatch(/GEMINI_API_KEY/);
    const b = buildRuntime({ ...base, LLM_PROVIDER: "anthropic", GEMINI_API_KEY: "k", LLM_MODEL_AGENTS: "m" });
    expect(b.info).toMatchObject({ buyerBrain: "rule-based", llmConfig: "incomplete" });
    expect(b.info.llmConfigNote).toMatch(/LLM_PROVIDER must be one of: gemini, groq/);
  });
  it("configured with Groq: vendor groq and the model id; the Gemini key does not substitute for the Groq key", () => {
    const rt = buildRuntime({ ...base, LLM_PROVIDER: "groq", GROQ_API_KEY: "test-key-456", LLM_MODEL_AGENTS: "groq-test-model" });
    expect(rt.info).toMatchObject({ buyerBrain: "llm", llmVendor: "groq", llmModel: "groq-test-model", llmConfig: "configured", llmConfigNote: null });
    const wrongKey = buildRuntime({ ...base, LLM_PROVIDER: "groq", GEMINI_API_KEY: "k", LLM_MODEL_AGENTS: "m" });
    expect(wrongKey.info).toMatchObject({ buyerBrain: "rule-based", llmVendor: null, llmConfig: "incomplete" });
    expect(wrongKey.info.llmConfigNote).toMatch(/GROQ_API_KEY/);
  });
});

describe("Gemini failure and success inside a negotiation", () => {
  it("a provider failure blocks the deal with the safe reason, records the failed run, and does NOT fall back to the rule-based brain", async () => {
    const { out, dealId } = await negotiate(sdk(async () => { throw Object.assign(new Error("secret-ish detail"), { status: 429 }); }));
    expect(out.outcome).toBe("BLOCKED");
    if (out.outcome === "BLOCKED") expect(out.reason).toMatch(/BUYER_OUTPUT_INVALID:LLM_ERROR:GEMINI_HTTP_429/);
    expect(await prisma.negotiationMessage.count({ where: { dealId } })).toBe(0); // no buyer message was invented
    const runs = await prisma.agentRun.findMany({ where: { dealId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.model).toBe("gemini-test-model");
    expect(runs[0]!.outputJson).toMatchObject({ failed: true, error: "LLM_ERROR", detail: expect.stringContaining("GEMINI_HTTP_429") });
    expect(JSON.stringify(runs[0]!.outputJson)).not.toContain("secret-ish");
  });

  it("an invalid (non-JSON) answer blocks the deal too", async () => {
    const { out } = await negotiate(sdk(async () => ({ text: "I think 15 dollars is fine!" })));
    expect(out.outcome).toBe("BLOCKED");
  });

  it("a valid answer is accepted only after the deterministic checks: tokens recorded; a price above the ceiling is rejected", async () => {
    const ok = await negotiate(sdk(async () => ({ text: JSON.stringify({ kind: "propose", price: "20.00" }), usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 12 } })));
    expect(ok.out.outcome).toBe("LOCKED");
    const runs = await prisma.agentRun.findMany({ where: { dealId: ok.dealId } });
    expect(runs[0]).toMatchObject({ tokensIn: 321, tokensOut: 12, model: "gemini-test-model" });

    const over = await negotiate(sdk(async () => ({ text: JSON.stringify({ kind: "propose", price: "99.00" }) })));
    expect(over.out.outcome).toBe("BLOCKED");
    if (over.out.outcome === "BLOCKED") expect(over.out.reason).toMatch(/BUYER_INTENT_REJECTED/);
  });
});
