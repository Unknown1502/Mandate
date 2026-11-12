/** GroqProvider contract and vendor selection, with a fake SDK client: no network, no key, no model. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GroqProvider, LlmProviderError, callLLM, createLlmProvider, resolveLlmConfig } from "@/agents/llm";

const KEY = "gsk-test-key-must-never-appear";
function fake(impl: (body: Record<string, any>, opts: Record<string, any>) => Promise<unknown>) {
  const create = vi.fn(impl);
  return { client: { chat: { completions: { create } } } as never, create };
}
const req = { role: "buyer", system: "SYS", user: "USR", maxTokens: 300 };
const reply = (content: string | null, extra: Record<string, unknown> = {}) => ({ choices: [{ message: { content }, finish_reason: "stop" }], ...extra });

describe("GroqProvider", () => {
  it("sends a system + user message, JSON object format, an output cap and the abort signal, and NO tools", async () => {
    const { client, create } = fake(async () => reply('{"kind":"accept"}', { usage: { prompt_tokens: 11, completion_tokens: 3 } }));
    const ac = new AbortController();
    const out = await new GroqProvider(KEY, "groq-test-model", client).complete(req, ac.signal);
    expect(out).toEqual({ text: '{"kind":"accept"}', tokensIn: 11, tokensOut: 3 });
    const [body, opts] = create.mock.calls[0]!;
    expect(body).toMatchObject({ model: "groq-test-model", max_completion_tokens: 300, temperature: 0.2, response_format: { type: "json_object" } });
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USR" }]);
    expect(opts.signal).toBe(ac.signal);
    for (const k of ["tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "search_settings", "citation_options"]) expect(body, k).not.toHaveProperty(k);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("gpt-oss (reasoning) models get low reasoning effort; other models never get the field", async () => {
    const a = fake(async () => reply("{}"));
    await new GroqProvider(KEY, "openai/gpt-oss-20b", a.client).complete(req, new AbortController().signal);
    expect(a.create.mock.calls[0]![0]).toMatchObject({ reasoning_effort: "low" });
    const b = fake(async () => reply("{}"));
    await new GroqProvider(KEY, "some-other-model", b.client).complete(req, new AbortController().signal);
    expect(b.create.mock.calls[0]![0]).not.toHaveProperty("reasoning_effort");
  });

  it("maps provider failures to short, secret-free messages", async () => {
    for (const [status, word] of [[429, "rate limit"], [404, "model not found"], [401, "check the key"]] as const) {
      const { client } = fake(async () => { throw Object.assign(new Error(`boom ${KEY}`), { status }); });
      const err = await new GroqProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
      expect(err).toBeInstanceOf(LlmProviderError);
      expect(err.safeMessage).toContain(`GROQ_HTTP_${status}`);
      expect(err.safeMessage).toContain(word);
      expect(err.safeMessage + err.message).not.toContain(KEY);
    }
    const { client } = fake(async () => { throw new Error(`network ${KEY}`); });
    const e2 = await new GroqProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
    expect(e2.safeMessage).toBe("GROQ_REQUEST_FAILED");
  });

  it("an empty response is an error, not an empty success", async () => {
    const { client } = fake(async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
    const err = await new GroqProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
    expect(err.safeMessage).toBe("GROQ_EMPTY_RESPONSE:length");
    const none = fake(async () => ({ choices: [] }));
    expect((await new GroqProvider(KEY, "m", none.client).complete(req, new AbortController().signal).catch((e) => e)).safeMessage).toBe("GROQ_EMPTY_RESPONSE");
  });

  it("through callLLM: a failure carries its safe reason, makes one request, and usage is recorded on success; an abort is a timeout", async () => {
    const schema = z.object({ kind: z.literal("accept") }).strict();
    const bad = fake(async () => { throw Object.assign(new Error("x"), { status: 429 }); });
    let run: any;
    const r = await callLLM({ provider: new GroqProvider(KEY, "m", bad.client), model: "m", role: "buyer", system: "s", user: "u", schema, maxAttempts: 1, onRun: (x) => { run = x; } });
    expect(r).toMatchObject({ ok: false, error: "LLM_ERROR" });
    expect(!r.ok && r.detail).toContain("GROQ_HTTP_429");
    expect(bad.create).toHaveBeenCalledTimes(1);

    const good = fake(async () => reply('{"kind":"accept"}', { usage: { prompt_tokens: 7, completion_tokens: 2 } }));
    expect((await callLLM({ provider: new GroqProvider(KEY, "m", good.client), model: "m", role: "buyer", system: "s", user: "u", schema, maxAttempts: 1, onRun: (x) => { run = x; } })).ok).toBe(true);
    expect(run).toMatchObject({ ok: true, tokensIn: 7, tokensOut: 2 });

    const hang = fake((_b, o) => new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))));
    expect(await callLLM({ provider: new GroqProvider(KEY, "m", hang.client), model: "m", role: "buyer", system: "s", user: "u", schema: z.object({}), maxAttempts: 1, timeoutMs: 20 })).toMatchObject({ ok: false, error: "LLM_TIMEOUT" });
  });
});

describe("vendor selection (pure)", () => {
  it("selects exactly the requested vendor and needs THAT vendor's key; the other vendor's key never substitutes", () => {
    expect(resolveLlmConfig({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k", LLM_MODEL_AGENTS: "m" })).toMatchObject({ vendor: "groq", ready: true, missing: [] });
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", LLM_MODEL_AGENTS: "m" })).toMatchObject({ vendor: "gemini", ready: true });
    expect(resolveLlmConfig({ LLM_PROVIDER: "groq", GEMINI_API_KEY: "k", LLM_MODEL_AGENTS: "m" })).toMatchObject({ vendor: "groq", ready: false, missing: ["GROQ_API_KEY"] });
    expect(resolveLlmConfig({ LLM_PROVIDER: "gemini", GROQ_API_KEY: "k", LLM_MODEL_AGENTS: "m" })).toMatchObject({ ready: false, missing: ["GEMINI_API_KEY"] });
  });
  it("not requested, unsupported and placeholder values are not ready", () => {
    expect(resolveLlmConfig({})).toMatchObject({ requested: false, ready: false });
    expect(resolveLlmConfig({ LLM_PROVIDER: "anthropic", GROQ_API_KEY: "k", LLM_MODEL_AGENTS: "m" })).toMatchObject({ requested: true, vendor: undefined, ready: false });
    expect(resolveLlmConfig({ LLM_PROVIDER: "groq", GROQ_API_KEY: "replace_me", LLM_MODEL_AGENTS: "m" }).missing).toEqual(["GROQ_API_KEY"]);
  });
  it("the factory builds the matching provider and refuses a missing key", () => {
    expect(createLlmProvider("groq", { GROQ_API_KEY: "k" }, "m").name).toBe("groq");
    expect(createLlmProvider("gemini", { GEMINI_API_KEY: "k" }, "m").name).toBe("gemini");
    expect(() => createLlmProvider("groq", { GEMINI_API_KEY: "k" }, "m")).toThrow(/GROQ_API_KEY/);
  });
});
