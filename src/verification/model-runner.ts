/**
 * ModelRunner (P4): the ONE boundary through which a verification model call can happen.
 *
 * A provider is reachable only from here (tests/unit/model-boundary-architecture.test.ts pins that no other verification module imports callLLM or a provider), and
 * `run` accepts nothing but a branded ModelInput issued by buildModelInput(). Before any provider is touched the runner re-checks the input against its own manifest
 * (fields within the approved view, digest of the exact text, binding to the approved terms). A violation throws ModelInputViolation and NO call is made.
 *
 * Every call yields a CallManifest: provider / model, prompt and policy versions, role, criteria, field ids, artifact hash, input digest, output digest, call id,
 * timestamps, token usage and result status. It deliberately contains NO artifact text, NO prompt text and NO model output text, only digests and counts.
 * The runner has no PayPal, settlement, mandate or database import: provider output is parsed into a closed Zod schema and can do nothing else.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { callLLM, type LlmProvider, type LlmRequest } from "../agents/llm";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { shippedDetector } from "./language";
import { isLanguageCleared, isModelInput, manifestViolations, MODEL_AUTH_MAX_AGE_MS, MODEL_LIMITS, type ModelInput, type ModelRole } from "./model-input";

export class ModelInputViolation extends Error {
  constructor(readonly violations: string[]) {
    super(`MODEL_INPUT_VIOLATION: ${violations.join(",")}`);
    this.name = "ModelInputViolation";
  }
}
export class ModelBudgetExceeded extends Error {
  constructor() {
    super("MODEL_CALL_BUDGET_EXCEEDED");
    this.name = "ModelBudgetExceeded";
  }
}

export interface CallManifest {
  callId: string;
  provider: string;
  model: string;
  role: ModelRole;
  pass: number;
  groupKey: string;
  criterionIds: string[];
  fieldIds: string[];
  artifactSha256: string;
  deliveryId: string;
  inputManifestHash: string;
  inputDigest: string;
  inputChars: number;
  promptVersion: string;
  policyVersion: string;
  /** sha256 of the canonical JSON of the validated output, or null if there was none */
  outputDigest: string | null;
  status: "OK" | "OUTPUT_INVALID" | "TIMEOUT" | "ERROR";
  attempts: number;
  latencyMs: number;
  startedAt: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** `redacted` is the secret-redacted model output for the audit row (never fed to another model) */
export type RunResult<T> = { ok: true; value: T; manifest: CallManifest; redacted: unknown } | { ok: false; error: "LLM_OUTPUT_INVALID" | "LLM_TIMEOUT" | "LLM_ERROR"; manifest: CallManifest; redacted: unknown };

export interface ModelRunnerOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  maxTokens?: number;
  /** hard cap on calls this runner will make (per verification); the next call throws ModelBudgetExceeded and nothing is sent */
  maxCalls?: number;
  now?: () => Date;
  /** the detector this build ships (default: shippedDetector()); an input whose approved policy pins a different one is refused */
  runtimeDetector?: { id: string; version: string; vocabularyHash: string };
  newId?: () => string;
  /** called once per logical call with the manifest and the redacted output (for the AgentRun row); must not throw into the call */
  record?: (m: CallManifest, redactedOutput: unknown) => void | Promise<void>;
}

export class ModelRunner {
  private calls = 0;
  constructor(private readonly provider: LlmProvider, readonly model: string, private readonly opts: ModelRunnerOptions = {}) {}

  get callsMade(): number {
    return this.calls;
  }
  get providerName(): string {
    return this.provider.name;
  }

  async run<T>(input: ModelInput, schema: z.ZodType<T>): Promise<RunResult<T>> {
    if (!isModelInput(input)) throw new ModelInputViolation(["NOT_A_MODEL_INPUT"]);
    const violations = manifestViolations(input);
    if (violations.length > 0) throw new ModelInputViolation(violations);
    // independent checks of what the approval and the policy require (the runner never trusts that its caller did them)
    const own: string[] = [];
    const a = input.authorization;
    const rt = this.opts.runtimeDetector ?? shippedDetector();
    if (!isLanguageCleared(input)) own.push("LANGUAGE_NOT_ASSESSED");
    if (a.detector.id !== rt.id || a.detector.version !== rt.version || a.detector.vocabularyHash !== rt.vocabularyHash) own.push("DETECTOR_MISMATCH");
    if ((this.opts.now ?? (() => new Date()))().getTime() - a.issuedAtMs > MODEL_AUTH_MAX_AGE_MS) own.push("AUTHORIZATION_STALE");
    if (input.system.length + input.user.length > MODEL_LIMITS.maxInputChars) own.push("INPUT_TOO_LARGE");
    if (!/^[0-9a-f]{64}$/.test(input.manifest.artifactSha256) || !/^[0-9a-f]{64}$/.test(a.termsHash) || !/^[0-9a-f]{64}$/.test(a.mandateDigest) || !/^[0-9a-f]{64}$/.test(a.mappingHash)) own.push("BINDING_NOT_WELL_FORMED");
    if (a.attestationNonce === "" || a.languagePolicyHash === "") own.push("APPROVAL_EVIDENCE_MISSING");
    if (input.criterionIds.length === 0 || input.criterionIds.some((c) => !a.terms.criteria.some((x) => x.id === c && x.type === "llm_judged"))) own.push("CRITERION_NOT_APPROVED");
    if (own.length > 0) throw new ModelInputViolation(own);
    if (this.opts.maxCalls !== undefined && this.calls >= this.opts.maxCalls) throw new ModelBudgetExceeded();
    this.calls++;

    const now = this.opts.now ?? (() => new Date());
    const startedAt = now();
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let providerCalls = 0;
    const tracked: LlmProvider = {
      name: this.provider.name,
      complete: async (req: LlmRequest, signal: AbortSignal) => {
        providerCalls++;
        const out = await this.provider.complete(req, signal);
        if (typeof out.tokensIn === "number") tokensIn = (tokensIn ?? 0) + out.tokensIn;
        if (typeof out.tokensOut === "number") tokensOut = (tokensOut ?? 0) + out.tokensOut;
        return out;
      },
    };
    let redacted: unknown = null;
    const r = await callLLM({
      provider: tracked,
      model: this.model,
      role: input.role,
      system: input.system,
      user: input.user,
      schema,
      maxAttempts: this.opts.maxAttempts ?? MODEL_LIMITS.maxAttempts,
      timeoutMs: this.opts.timeoutMs ?? MODEL_LIMITS.timeoutMs,
      maxTokens: this.opts.maxTokens ?? MODEL_LIMITS.maxOutputTokens,
      onRun: (rec) => {
        redacted = rec.outputRedacted;
      },
    });
    const m = input.manifest;
    const manifest: CallManifest = {
      callId: (this.opts.newId ?? randomUUID)(),
      provider: this.provider.name,
      model: this.model,
      role: input.role,
      pass: input.pass,
      groupKey: m.groupKey,
      criterionIds: [...m.criterionIds],
      fieldIds: m.fields.map((f) => f.id),
      artifactSha256: m.artifactSha256,
      deliveryId: m.deliveryId,
      inputManifestHash: input.manifestHash,
      inputDigest: m.inputDigest,
      inputChars: m.inputChars,
      promptVersion: m.promptVersion,
      policyVersion: m.policyVersion,
      outputDigest: r.ok ? sha256Hex(canonicalJson(r.value)) : null,
      status: r.ok ? "OK" : r.error === "LLM_OUTPUT_INVALID" ? "OUTPUT_INVALID" : r.error === "LLM_TIMEOUT" ? "TIMEOUT" : "ERROR",
      attempts: providerCalls,
      latencyMs: now().getTime() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      tokensIn,
      tokensOut,
    };
    try {
      await this.opts.record?.(manifest, redacted);
    } catch {
      /* recording must never turn into a decision */
    }
    return r.ok ? { ok: true, value: r.value, manifest, redacted } : { ok: false, error: r.error, manifest, redacted };
  }
}
