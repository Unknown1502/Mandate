/** Test doubles for the agents. They are SCRIPTED: nothing here is evidence about real LLM behaviour. */
import type { BuyerBrain, BuyerContext } from "@/agents/buyer";
import type { LlmProvider, LlmRequest } from "@/agents/llm";

export class ScriptedLlm implements LlmProvider {
  readonly name = "scripted";
  readonly requests: LlmRequest[] = [];
  private i = 0;
  /** `outputs` are returned in order, then the last one repeats. A function receives the request (to simulate a model that obeys the prompt). */
  constructor(private readonly outputs: (string | ((req: LlmRequest) => string))[]) {}
  async complete(req: LlmRequest) {
    this.requests.push(req);
    const o = this.outputs[Math.min(this.i++, this.outputs.length - 1)]!;
    return { text: typeof o === "function" ? o(req) : o };
  }
}

/** A provider that never answers (to test timeouts). Honors abort. */
export const hangingLlm: LlmProvider = {
  name: "hanging",
  complete: (_req, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
};

export class ScriptedBuyerBrain implements BuyerBrain {
  readonly kind = "scripted";
  readonly seen: BuyerContext[] = [];
  private i = 0;
  constructor(private readonly outputs: (unknown | ((ctx: BuyerContext) => unknown))[]) {}
  async decide(ctx: Readonly<BuyerContext>) {
    this.seen.push(ctx as BuyerContext);
    const o = this.outputs[Math.min(this.i++, this.outputs.length - 1)];
    return { ok: true as const, raw: typeof o === "function" ? (o as (c: BuyerContext) => unknown)(ctx as BuyerContext) : o };
  }
}
