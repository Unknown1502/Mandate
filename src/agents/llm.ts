/**
 * Controlled LLM access. There is NO tool-calling parameter anywhere in this file: an agent can produce text that
 * must parse into a Zod schema, and nothing else. Providers are injected; none runs unless the caller supplies one.
 */
import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import type { z } from "zod";
import { redact } from "../lib/redact";

export interface LlmRequest {
  role: string;
  system: string;
  user: string;
  maxTokens: number;
}
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest, signal: AbortSignal): Promise<{ text: string; tokensIn?: number; tokensOut?: number }>;
}

export interface AgentRunRecord {
  role: string;
  model: string;
  promptHash: string;
  outputRedacted: unknown;
  latencyMs: number;
  attempts: number;
  ok: boolean;
  error?: string;
  /** short provider reason (status words only, never a secret), for example GEMINI_HTTP_429 */
  detail?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export type LlmResult<T> = { ok: true; value: T; promptHash: string } | { ok: false; error: "LLM_OUTPUT_INVALID" | "LLM_TIMEOUT" | "LLM_ERROR"; promptHash: string; detail?: string };

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

/**
 * Zod-validated JSON with bounded retries and a timeout. A failed attempt is retried with the IDENTICAL prompt:
 * model output is never fed back into the next prompt (that would be an injection channel).
 */
export async function callLLM<T>(p: {
  provider: LlmProvider;
  model: string;
  role: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxAttempts?: number;
  timeoutMs?: number;
  maxTokens?: number;
  onRun?: (r: AgentRunRecord) => void | Promise<void>;
}): Promise<LlmResult<T>> {
  const maxAttempts = Math.min(Math.max(p.maxAttempts ?? 2, 1), 3);
  const promptHash = createHash("sha256").update(`${p.system}\n---\n${p.user}`).digest("hex");
  const started = Date.now();
  let lastText = "";
  let error: "LLM_OUTPUT_INVALID" | "LLM_TIMEOUT" | "LLM_ERROR" = "LLM_OUTPUT_INVALID";
  let attempts = 0;
  let value: T | undefined;
  let detail: string | undefined;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  for (let i = 0; i < maxAttempts && value === undefined; i++) {
    attempts++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), p.timeoutMs ?? 15_000);
    try {
      const out = await p.provider.complete({ role: p.role, system: p.system, user: p.user, maxTokens: p.maxTokens ?? 600 }, ac.signal);
      lastText = out.text;
      tokensIn = (tokensIn ?? 0) + (out.tokensIn ?? 0);
      tokensOut = (tokensOut ?? 0) + (out.tokensOut ?? 0);
      let json: unknown;
      try {
        json = JSON.parse(stripFences(out.text));
      } catch {
        error = "LLM_OUTPUT_INVALID";
        continue;
      }
      const parsed = p.schema.safeParse(json);
      if (parsed.success) value = parsed.data;
      else error = "LLM_OUTPUT_INVALID";
    } catch (e) {
      error = ac.signal.aborted ? "LLM_TIMEOUT" : "LLM_ERROR";
      detail = e instanceof LlmProviderError ? e.safeMessage : undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  let shown: unknown = lastText.slice(0, 2000);
  try {
    shown = redact(JSON.parse(stripFences(lastText)));
  } catch {
    /* keep truncated text */
  }
  await p.onRun?.({ role: p.role, model: p.model, promptHash, outputRedacted: shown, latencyMs: Date.now() - started, attempts, ok: value !== undefined, error: value === undefined ? error : undefined, detail: value === undefined ? detail : undefined, tokensIn, tokensOut });
  return value !== undefined ? { ok: true, value, promptHash } : { ok: false, error, promptHash, detail };
}

/** A provider failure whose message is safe to show and to store: status/code words only, never a key, a URL with a key, or request/response content. */
export class LlmProviderError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "LlmProviderError";
  }
}

/**
 * Google Gemini provider (official @google/genai SDK), server-side only. The key is passed in by the caller and never logged. The request has NO tools, no tool config,
 * no function calling and no grounding: only a system instruction, one user message, a JSON response mime type, a low temperature and an output-token cap. The caller's
 * AbortSignal cancels the request. Provider errors become a short, secret-free LlmProviderError so the UI can say what failed; there is no fallback to another model.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;
  constructor(apiKey: string, private readonly model: string, client?: GoogleGenAI) {
    this.client = client ?? new GoogleGenAI({ apiKey });
  }
  async complete(req: LlmRequest, signal: AbortSignal) {
    try {
      const res = await this.client.models.generateContent({
        model: this.model,
        contents: req.user,
        config: { systemInstruction: req.system, maxOutputTokens: req.maxTokens, temperature: 0.2, responseMimeType: "application/json", abortSignal: signal },
      });
      const text = res.text ?? "";
      if (!text) {
        const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason;
        throw new LlmProviderError(`GEMINI_EMPTY_RESPONSE${reason ? `:${String(reason).slice(0, 40)}` : ""}`);
      }
      const u = res.usageMetadata;
      return { text, tokensIn: u?.promptTokenCount, tokensOut: u ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : undefined };
    } catch (e) {
      if (e instanceof LlmProviderError) throw e;
      if (signal.aborted) throw e; // callLLM reports this as a timeout
      const status = (e as { status?: unknown }).status;
      if (typeof status === "number") throw new LlmProviderError(`GEMINI_HTTP_${status}${status === 404 ? " (model not found)" : status === 429 ? " (rate limit or quota)" : status === 400 || status === 403 ? " (check the key and model id)" : ""}`);
      throw new LlmProviderError("GEMINI_REQUEST_FAILED");
    }
  }
}

export const LLM_VENDORS = ["gemini", "groq"] as const;
export type LlmVendor = (typeof LLM_VENDORS)[number];
const KEY_VAR: Record<LlmVendor, string> = { gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY" };
const isSet = (v: string | undefined) => !!v && !/^replace(_|-)?me|^replace_with/i.test(v);

export interface LlmConfig {
  /** LLM_PROVIDER was set to something */
  requested: boolean;
  vendor?: LlmVendor;
  /** names of the settings that are missing or invalid (names only, never values) */
  missing: string[];
  /** true only when the vendor is supported and its key and LLM_MODEL_AGENTS are present */
  ready: boolean;
}
/** Pure: reads only the record it is given. Exactly one vendor is selected by LLM_PROVIDER; there is no fallback from one vendor to the other. */
export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  const requested = isSet(env.LLM_PROVIDER);
  const vendor = LLM_VENDORS.find((v) => v === env.LLM_PROVIDER);
  const missing = [vendor ? null : `LLM_PROVIDER must be one of: ${LLM_VENDORS.join(", ")}`, vendor ? (isSet(env[KEY_VAR[vendor]]) ? null : KEY_VAR[vendor]) : null, isSet(env.LLM_MODEL_AGENTS) ? null : "LLM_MODEL_AGENTS"].filter(Boolean) as string[];
  return { requested, vendor, missing, ready: requested && missing.length === 0 };
}
/** the only factory for a provider: callers pass values from a ready LlmConfig */
export function createLlmProvider(vendor: LlmVendor, env: Record<string, string | undefined>, model: string): LlmProvider {
  const key = env[KEY_VAR[vendor]];
  if (!isSet(key)) throw new Error(`${KEY_VAR[vendor]} is not set`);
  return vendor === "groq" ? new GroqProvider(key!, model) : new GeminiProvider(key!, model);
}

/**
 * Groq provider (official groq-sdk, OpenAI-compatible chat completions), server-side only. Same contract as GeminiProvider: a system message and one user message,
 * JSON-object response format, low temperature, an output-token cap, the caller's AbortSignal, and NO tools / tool_choice / functions. SDK retries are off (callLLM owns
 * retry policy). Errors become short, secret-free LlmProviderError messages; there is no fallback to another model or vendor.
 */
export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  private readonly client: Groq;
  constructor(apiKey: string, private readonly model: string, client?: Groq) {
    this.client = client ?? new Groq({ apiKey, maxRetries: 0 });
  }
  async complete(req: LlmRequest, signal: AbortSignal) {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_completion_tokens: req.maxTokens,
          temperature: 0.2,
          response_format: { type: "json_object" },
          // gpt-oss models are reasoning models whose thinking tokens count against the output cap: keep the effort low so the JSON answer is not cut off. Other models reject this field.
          ...(this.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" as const } : {}),
        },
        { signal },
      );
      const choice = res.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (!text) throw new LlmProviderError(`GROQ_EMPTY_RESPONSE${choice?.finish_reason ? `:${String(choice.finish_reason).slice(0, 40)}` : ""}`);
      return { text, tokensIn: res.usage?.prompt_tokens, tokensOut: res.usage?.completion_tokens };
    } catch (e) {
      if (e instanceof LlmProviderError) throw e;
      if (signal.aborted) throw e; // callLLM reports this as a timeout
      const status = (e as { status?: unknown }).status;
      if (typeof status === "number") throw new LlmProviderError(`GROQ_HTTP_${status}${status === 404 ? " (model not found)" : status === 429 ? " (rate limit or quota)" : status === 400 || status === 401 || status === 403 ? " (check the key and model id)" : ""}`);
      throw new LlmProviderError("GROQ_REQUEST_FAILED");
    }
  }
}
