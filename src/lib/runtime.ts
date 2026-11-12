/**
 * Composition root for the HTTP layer. Built lazily, only AFTER a request passed the principal guard (src/lib/principal.ts), so an unauthenticated request can never
 * construct a PayPal client or reach the database.
 *
 *  - PayPal: PAYPAL_MODE=mock (the DEFAULT) uses the in-memory mock gateway and never contacts PayPal; PAYPAL_MODE=sandbox uses the real Sandbox gateway built on the official
 *    PayPal Server SDK (src/paypal/sdk-gateway.ts), and then parsePayPalEnv() throws unless PAYPAL_ENV=sandbox, the base URL is exactly the Sandbox host and the client id and
 *    secret are set. There is no production mode and no fallback between the two: incomplete Sandbox configuration is an error, never a switch to the mock.
 *  - V2: no key registry and no release gate are supplied, so V2 mandates and deals stay closed (fail closed); this file contains no way to open the gate.
 *  - Buyer Agent brain: a REAL model (server-side) only when LLM_PROVIDER is gemini or groq, that vendor's key (GEMINI_API_KEY / GROQ_API_KEY) and LLM_MODEL_AGENTS are all set;
 *    otherwise the deterministic rule-based brain. `info` reports which one is active (and whether the model configuration was requested but incomplete) so the UI can never
 *    present a rule-based negotiation as AI. A provider FAILURE during a negotiation blocks that deal with the reason; it never falls back to the rule-based brain or the other vendor.
 *  - The model has no tools and no payment authority: it only produces a typed negotiation intent that the orchestrator re-validates (ceiling, rounds, protocol).
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/db/client";
import { createLlmProvider, resolveLlmConfig } from "@/agents/llm";
import { BuyerAgent, LlmBuyerBrain, RuleBasedBuyerBrain } from "@/agents/buyer";
import { HttpSellerClient, type SellerDelivery } from "@/agents/seller-client";
import type { PolicyDeps } from "@/domain/deals";
import { loadSigningKeys, type SigningKeys } from "@/domain/signing";
import { Orchestrator } from "@/orchestration/service";
import { PAYPAL_JS_SDK_V6_SANDBOX_URL } from "@/paypal/checkout";
import type { GwResult, PayPalGateway, WriteType } from "@/paypal/gateway";
import { createSandboxSdkGateway } from "@/paypal/sdk-gateway";
import { MockPayPal } from "@/paypal/mock-gateway";
import { createSettlementPort } from "@/settlement/port";
import { defaultEngineConfig } from "@/settlement/engine";
import { getEnv, parsePayPalEnv } from "./env";

/**
 * Sandbox write lock. In PAYPAL_MODE=sandbox every PayPal WRITE (create order, authorize, capture, void) is refused unless PAYPAL_SANDBOX_WRITES=authorized is set in the
 * server environment, which the operator does only after approving the exact Sandbox transaction. Reads (GET) are always allowed. A refusal is reported as a definitive
 * rejection that never reached PayPal, so the engine treats it as "nothing happened".
 */
export class SandboxWriteLock implements PayPalGateway {
  constructor(private readonly inner: PayPalGateway, private readonly authorized: boolean) {}
  async write(type: WriteType, a: { requestId: string; path: string; body?: unknown; timeoutMs?: number }): Promise<GwResult> {
    if (!this.authorized) return { kind: "rejected", status: 0, code: "PAYPAL_VALIDATION", body: { message: "Sandbox writes are locked (PAYPAL_SANDBOX_WRITES is not 'authorized'); nothing was sent to PayPal" } };
    return this.inner.write(type, a);
  }
  getOrder(id: string) {
    return this.inner.getOrder(id);
  }
  getAuthorization(id: string) {
    return this.inner.getAuthorization(id);
  }
  getCapture(id: string) {
    return this.inner.getCapture(id);
  }
}

export interface RuntimeInfo {
  paypal: "mock" | "sandbox-live";
  /** which gateway implementation is wired: the in-memory simulation or the official-SDK Sandbox gateway */
  paypalGateway: "mock-in-memory" | "sandbox-sdk";
  /** sandbox mode only: false = every PayPal write is locked */
  sandboxWritesAuthorized: boolean;
  buyerBrain: "llm" | "rule-based";
  /** not_requested: no LLM_PROVIDER; configured: Gemini will be called; incomplete: a provider was requested but the key/model is missing or the provider is unsupported (the buyer is then rule-based and the UI says so) */
  llmConfig: "not_requested" | "configured" | "incomplete";
  llmConfigNote: string | null;
  llmVendor: string | null;
  llmModel: string | null;
  sellerConfigured: boolean;
  challengeWindowSeconds: number;
  v2: "disabled";
}
export interface Runtime {
  db: PrismaClient;
  keys: SigningKeys;
  policy: PolicyDeps;
  orchestrator: Orchestrator;
  /** the simulated seller's delivery endpoint (same fixed local URL as negotiation); undefined when no seller is configured */
  sellerDelivery?: SellerDelivery;
  /** present ONLY in PAYPAL_MODE=mock: lets the demo simulate the buyer's PayPal checkout. It cannot touch Sandbox. */
  mockPayPal?: MockPayPal;
  /** present ONLY in PAYPAL_MODE=sandbox: the PUBLIC client id and the exact Sandbox browser-SDK URL for the buyer's checkout button (never the secret) */
  checkout?: { clientId: string; sdkUrl: string };
  info: RuntimeInfo;
}

type Source = Record<string, string | undefined>;
const present = (v: string | undefined) => !!v && !/^replace(_|-)?me|^replace_with/i.test(v);

export function buildRuntime(env: Source = process.env): Runtime {
  const app = getEnv();
  const mode = env.PAYPAL_MODE === "sandbox" ? "sandbox" : "mock";
  if (env.PAYPAL_MODE !== undefined && env.PAYPAL_MODE !== "sandbox" && env.PAYPAL_MODE !== "mock") throw new Error("PAYPAL_MODE must be mock or sandbox");
  const keys = loadSigningKeys(env);
  const policy: PolicyDeps = { publicKeyB64: keys.publicKeyB64, maxRounds: 4 };
  let gateway: PayPalGateway;
  let mockPayPal: MockPayPal | undefined;
  let checkout: Runtime["checkout"];
  if (mode === "sandbox") {
    const pp = parsePayPalEnv(env); // throws (names only) unless Sandbox with credentials: no fallback to the mock
    gateway = new SandboxWriteLock(createSandboxSdkGateway({ clientId: pp.PAYPAL_CLIENT_ID, clientSecret: pp.PAYPAL_CLIENT_SECRET }), env.PAYPAL_SANDBOX_WRITES === "authorized");
    checkout = { clientId: pp.PAYPAL_CLIENT_ID, sdkUrl: PAYPAL_JS_SDK_V6_SANDBOX_URL };
  } else {
    mockPayPal = new MockPayPal();
    gateway = mockPayPal;
  }
  // Demo only: shorten the buyer's challenge window (default 15 minutes) so a live walkthrough does not wait. 0..3600 seconds; anything else keeps the default.
  const windowSec = Number(env.DEMO_CHALLENGE_WINDOW_SECONDS);
  const config = defaultEngineConfig(app.APP_URL);
  if (env.DEMO_CHALLENGE_WINDOW_SECONDS !== undefined && Number.isInteger(windowSec) && windowSec >= 0 && windowSec <= 3600) config.challengeWindowMs = windowSec * 1000;
  const port = createSettlementPort({ db: prisma, gateway, deps: policy, config, now: () => new Date() });

  const llm = resolveLlmConfig(env);
  const useLlm = llm.ready;
  const missingLlm = llm.missing;
  const llmConfig: RuntimeInfo["llmConfig"] = useLlm ? "configured" : llm.requested ? "incomplete" : "not_requested";
  const brain = useLlm ? new LlmBuyerBrain(createLlmProvider(llm.vendor!, env, env.LLM_MODEL_AGENTS!), env.LLM_MODEL_AGENTS!) : new RuleBasedBuyerBrain();
  const sellerUrl = env.SELLER_URL ?? env.SELLER_SERVICE_URL;
  const seller = present(sellerUrl) ? new HttpSellerClient(sellerUrl!) : undefined;
  const orchestrator = new Orchestrator({ db: prisma, port, policy, negotiation: seller ? { buyer: new BuyerAgent(brain), seller, maxRounds: policy.maxRounds } : undefined });

  return {
    db: prisma,
    keys,
    policy,
    orchestrator,
    sellerDelivery: seller,
    mockPayPal,
    checkout,
    info: { paypal: mode === "sandbox" ? "sandbox-live" : "mock", paypalGateway: mode === "sandbox" ? "sandbox-sdk" : "mock-in-memory", sandboxWritesAuthorized: mode === "sandbox" && env.PAYPAL_SANDBOX_WRITES === "authorized", buyerBrain: useLlm ? "llm" : "rule-based", llmVendor: useLlm ? llm.vendor! : null, llmConfig, llmConfigNote: llmConfig === "incomplete" ? `Model not used – missing: ${missingLlm.join(", ")}` : null, llmModel: useLlm ? env.LLM_MODEL_AGENTS! : null, sellerConfigured: !!seller, challengeWindowSeconds: Math.round(config.challengeWindowMs / 1000), v2: "disabled" },
  };
}

/** one runtime per server process, shared by every route bundle (Next may load this module more than once in development) */
const g = globalThis as unknown as { __mandateRuntime?: Runtime };
export function getRuntime(): Runtime {
  g.__mandateRuntime ??= buildRuntime(process.env);
  return g.__mandateRuntime;
}
