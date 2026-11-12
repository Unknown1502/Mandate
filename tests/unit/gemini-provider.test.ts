/** GeminiProvider contract, with a fake SDK client: no network, no key, no model. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiProvider, LlmProviderError, callLLM } from "@/agents/llm";

const KEY = "AIza-test-key-must-never-appear";
function fake(impl: (args: Record<string, any>) => Promise<unknown>) {
  const generateContent = vi.fn(impl);
  return { client: { models: { generateContent } } as never, generateContent };
}
const req = { role: "buyer", system: "SYS", user: "USR", maxTokens: 300 };

describe("GeminiProvider", () => {
  it("sends one system instruction + one user message, JSON mime type, an output cap and the abort signal, and NO tools", async () => {
    const { client, generateContent } = fake(async () => ({ text: '{"kind":"accept"}', usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, thoughtsTokenCount: 2 } }));
    const p = new GeminiProvider(KEY, "gemini-test-model", client);
    const ac = new AbortController();
    const out = await p.complete(req, ac.signal);
    expect(out).toEqual({ text: '{"kind":"accept"}', tokensIn: 11, tokensOut: 5 });
    const a = generateContent.mock.calls[0]![0];
    expect(a.model).toBe("gemini-test-model");
    expect(a.contents).toBe("USR");
    expect(a.config).toMatchObject({ systemInstruction: "SYS", maxOutputTokens: 300, responseMimeType: "application/json", abortSignal: ac.signal });
    for (const k of ["tools", "toolConfig", "automaticFunctionCalling", "cachedContent", "safetySettings"]) expect(a.config, k).not.toHaveProperty(k);
    expect(JSON.stringify(a)).not.toContain(KEY);
  });

  it("maps provider failures to short, secret-free messages", async () => {
    for (const [status, word] of [[429, "rate limit"], [404, "model not found"], [403, "check the key"]] as const) {
      const { client } = fake(async () => { throw Object.assign(new Error(`boom ${KEY}`), { status }); });
      const err = await new GeminiProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
      expect(err).toBeInstanceOf(LlmProviderError);
      expect(err.safeMessage).toContain(`GEMINI_HTTP_${status}`);
      expect(err.safeMessage).toContain(word);
      expect(err.safeMessage + err.message).not.toContain(KEY);
    }
    const { client } = fake(async () => { throw new Error(`network ${KEY}`); });
    const e2 = await new GeminiProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
    expect(e2.safeMessage).toBe("GEMINI_REQUEST_FAILED");
  });

  it("an empty or blocked response is an error, not an empty success", async () => {
    const { client } = fake(async () => ({ text: "", candidates: [{ finishReason: "SAFETY" }] }));
    const err = await new GeminiProvider(KEY, "m", client).complete(req, new AbortController().signal).catch((e) => e);
    expect(err.safeMessage).toBe("GEMINI_EMPTY_RESPONSE:SAFETY");
  });

  it("through callLLM: a failure is reported with its safe reason and there is no retry beyond maxAttempts; usage is recorded", async () => {
    const schema = z.object({ kind: z.literal("accept") }).strict();
    const bad = fake(async () => { throw Object.assign(new Error("x"), { status: 429 }); });
    let run: any;
    const r = await callLLM({ provider: new GeminiProvider(KEY, "m", bad.client), model: "m", role: "buyer", system: "s", user: "u", schema, maxAttempts: 1, onRun: (x) => { run = x; } });
    expect(r).toMatchObject({ ok: false, error: "LLM_ERROR" });
    expect(!r.ok && r.detail).toContain("GEMINI_HTTP_429");
    expect(bad.generateContent).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ ok: false, error: "LLM_ERROR" });

    const good = fake(async () => ({ text: '{"kind":"accept"}', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } }));
    const ok = await callLLM({ provider: new GeminiProvider(KEY, "m", good.client), model: "m", role: "buyer", system: "s", user: "u", schema, maxAttempts: 1, onRun: (x) => { run = x; } });
    expect(ok.ok).toBe(true);
    expect(run).toMatchObject({ ok: true, tokensIn: 7, tokensOut: 2 });
  });

  it("an aborted request is reported as a timeout by callLLM", async () => {
    const hang = fake((a) => new Promise((_res, rej) => a.config.abortSignal.addEventListener("abort", () => rej(new Error("aborted")))));
    const r = await callLLM({ provider: new GeminiProvider(KEY, "m", hang.client), model: "m", role: "buyer", system: "s", user: "u", schema: z.object({}), maxAttempts: 1, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: "LLM_TIMEOUT" });
  });
});
