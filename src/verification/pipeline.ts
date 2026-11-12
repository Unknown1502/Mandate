/**
 * Verification pipeline. Reads the stored delivery and the ORIGINAL locked terms, produces one immutable, hash-sealed
 * VerificationResult per (delivery, sequence), and records it. It never imports PayPal, the settlement engine, the gateway or
 * the budget code, and it produces no number that could be mistaken for money. Handing the result to Gate 2 is a separate step
 * (src/settlement/verification-intake.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type VerificationRun } from "@prisma/client";
import type { AgentRunRecord } from "../agents/llm";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { appendEvent } from "../domain/ledger";
import { readTermsOrThrow, termsMatchLock } from "../domain/terms";
import { mergePasses, validateAiOutput, validateSkepticOutput, type AiContext, type AiVerifier, type LlmSkeptic, type Rejected, type ValidatedAi } from "./ai";
import { VERIFIER_VERSION, deliveryManifestSchema, verificationResultSchema, type CriterionResult, type Observation, type SkepticFlag, type VerificationResult } from "./contracts";
import { PARSER_VERSION, parseCsv } from "./csv";
import type { EvidenceContext } from "./evidence";
import { DEFAULT_LANGUAGE_POLICY, type LanguagePolicy } from "./language";
import { MODEL_BLOCKED_REASON, UnclassifiableTermsError, modelPolicyFor, type ModelPolicy } from "./model-gate";
import { metadataContradictions, prescan, type PrescanBudget } from "./prescan";
import { MODEL_SAMPLE_ROWS, assessLanguageScope } from "./scope";
import { runDeterministicChecks } from "./validators";
import { VerificationError } from "./errors";
import { computeV2Verification, type VerifyV2Options } from "./pipeline-v2";
import { readLockedTerms } from "../domain/terms-v2";

export { VerificationError };

export interface VerifyDeps {
  db: PrismaClient;
  ai?: AiVerifier;
  skeptic?: LlmSkeptic;
  /** independent AI passes that must agree (default 2) */
  passes?: number;
  now?: () => Date;
  /** claim tuning; defaults: random owner id, 60s lease, 15s wait */
  claim?: { owner?: string; leaseMs?: number; waitMs?: number };
  /** deployment language policy (default: English/French/Chinese, criterion scope, nothing withheld). Validate with parseLanguagePolicy. */
  language?: LanguagePolicy;
  /** prescan processing limits (default: DEFAULT_PRESCAN_BUDGET). Hitting a limit yields a SCAN_INCOMPLETE flag, never a pass. */
  prescanBudget?: Partial<PrescanBudget>;
  /** V2 deals: the verification context (key registry, deployment switches), the ModelRunner and the deployment language floor. A V2 deal cannot be verified without it. */
  v2?: VerifyV2Options;
}

const EVIDENCE_REF = /^(ledger:\d{1,6}|delivery:[A-Za-z0-9_-]{5,40}|external:https:\/\/[^\s]{4,300})$/;

export function resultHashOf(r: Omit<VerificationResult, "resultHash"> | VerificationResult): string {
  const { resultHash: _omit, ...rest } = r as VerificationResult;
  void _omit;
  return sha256Hex(canonicalJson(rest));
}

type VerifyOutcome = { run: VerificationRun; result: VerificationResult; created: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Persistent atomic claim on (delivery, sequence). Exactly one caller becomes the owner and may call the AI provider; the others
 * wait for the owner's immutable record. A crashed owner's claim becomes takeable only after its lease expires (atomic
 * compare-and-set), so a restart recovers without two live owners. The claim is released if the owner fails before recording.
 */
export async function verifyDelivery(d: VerifyDeps, p: { dealId: string; sequence?: number; inputEvidenceRefs?: string[] }): Promise<VerifyOutcome> {
  const sequence = p.sequence ?? 1;
  const deal = await d.db.deal.findUnique({ where: { id: p.dealId }, include: { delivery: true } });
  if (!deal) throw new VerificationError("DEAL_NOT_FOUND");
  if (!deal.delivery) throw new VerificationError("NO_DELIVERY");
  const deliveryId = deal.delivery.id;
  const me = d.claim?.owner ?? randomUUID();
  const leaseMs = d.claim?.leaseMs ?? 60_000;
  const giveUpAt = Date.now() + (d.claim?.waitMs ?? 15_000);
  const clock = d.now ?? (() => new Date());

  for (;;) {
    const run = await d.db.verificationRun.findUnique({ where: { deliveryId_sequence: { deliveryId, sequence } } });
    if (run) return { run, result: verificationResultSchema.parse(run.resultJson), created: false };
    const now = clock();
    let owner = false;
    try {
      await d.db.verificationClaim.create({ data: { deliveryId, sequence, claimedBy: me, leaseExpiresAt: new Date(now.getTime() + leaseMs) } });
      owner = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      // someone else holds the claim; take over ONLY if its lease has expired (atomic)
      const took = await d.db.verificationClaim.updateMany({ where: { deliveryId, sequence, leaseExpiresAt: { lt: now } }, data: { claimedBy: me, leaseExpiresAt: new Date(now.getTime() + leaseMs), status: "CLAIMED" } });
      owner = took.count === 1;
    }
    if (owner) {
      let recorded = false;
      try {
        const out = await verifyDeliveryUnclaimed(d, p);
        recorded = true;
        return out;
      } finally {
        if (recorded) await d.db.verificationClaim.updateMany({ where: { deliveryId, sequence, claimedBy: me }, data: { status: "DONE" } });
        else await d.db.verificationClaim.deleteMany({ where: { deliveryId, sequence, claimedBy: me, status: "CLAIMED" } });
      }
    }
    if (Date.now() > giveUpAt) throw new VerificationError("IN_PROGRESS");
    await sleep(40);
  }
}

async function verifyDeliveryUnclaimed(
  d: VerifyDeps,
  p: { dealId: string; sequence?: number; inputEvidenceRefs?: string[] },
): Promise<VerifyOutcome> {
  const sequence = p.sequence ?? 1;
  const deal = await d.db.deal.findUnique({ where: { id: p.dealId }, include: { delivery: true } });
  if (!deal) throw new VerificationError("DEAL_NOT_FOUND");
  const delivery = deal.delivery;
  if (!delivery) throw new VerificationError("NO_DELIVERY");

  // Idempotency: one immutable record per (delivery, sequence). A repeat returns it without recomputing or re-calling the AI.
  const existing = await d.db.verificationRun.findUnique({ where: { deliveryId_sequence: { deliveryId: delivery.id, sequence } } });
  if (existing) return { run: existing, result: verificationResultSchema.parse(existing.resultJson), created: false };

  if (sequence > 1) {
    if (!(await d.db.verificationRun.findUnique({ where: { deliveryId_sequence: { deliveryId: delivery.id, sequence: sequence - 1 } } }))) throw new VerificationError("PREVIOUS_RUN_MISSING");
    if (!p.inputEvidenceRefs?.length || !p.inputEvidenceRefs.every((r) => EVIDENCE_REF.test(r))) throw new VerificationError("EVIDENCE_REQUIRED");
  }

  // V2 deals take the V2 core (authorization re-derived, restricted model inputs, binding); V1 deals continue below, unchanged, and never reach a model.
  const lockedAny = readLockedTerms(deal.termsJson);
  if (lockedAny.ok && lockedAny.version === 2) return verifyV2Delivery(d, p, deal, delivery, sequence);

  // The agreement is read from the LOCKED terms; the seller's manifest and artifact cannot alter it.
  if (!deal.termsHash || !termsMatchLock(deal.termsJson, deal.termsHash)) throw new VerificationError("TERMS_DRIFT");
  const terms = readTermsOrThrow(deal.termsJson);

  // P0 model-isolation gate (docs/15 s15.9.0, W1). Decided from the parsed, hash-verified LOCKED terms only; the verifier and skeptic below are reachable
  // ONLY through `models`, which is empty unless the gate permits a model. Terms whose criteria cannot be classified fail closed, like any other drift.
  let modelPolicy: ModelPolicy;
  try {
    modelPolicy = modelPolicyFor(terms.criteria);
  } catch (e) {
    if (e instanceof UnclassifiableTermsError) throw new VerificationError("TERMS_DRIFT");
    throw e;
  }
  const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted ? { ai: d.ai, skeptic: d.skeptic } : {};

  // Tamper-after-submission defence: the stored bytes and manifest must still hash to what was accepted.
  const manifestOk = deliveryManifestSchema.safeParse(delivery.manifestJson);
  const integrity =
    createHash("sha256").update(Buffer.from(delivery.artifactText, "utf8")).digest("hex") === delivery.artifactSha256 &&
    manifestOk.success &&
    sha256Hex(canonicalJson(manifestOk.data)) === delivery.manifestHash &&
    delivery.termsHash === deal.termsHash;
  if (!integrity) {
    await d.db.$transaction((tx) => appendEvent(tx, deal.id, "ARTIFACT_INTEGRITY_FAILURE", "verification", { deliveryId: delivery.id }));
    throw new VerificationError("ARTIFACT_INTEGRITY_FAILURE");
  }
  const manifest = manifestOk.data!;
  const csv = parseCsv(delivery.artifactText);
  const sha12 = delivery.artifactSha256.slice(0, 12);
  const metadata = manifest.metadata ?? {};
  const evidence: EvidenceContext = { sha12, csv, manifestFields: Object.keys(metadata).concat(["artifactReference", "artifactSha256", "artifactSize", "mediaType", "submittedAt"]) };

  // 1. deterministic checks
  const checks = runDeterministicChecks(terms.criteria, csv, delivery.artifactSha256);
  const anyRequiredFailed = terms.criteria.some((c) => c.required && c.type === "deterministic" && checks.find((x) => x.criterionId === c.id)?.status === "FAIL");

  // 2. deterministic skeptic, under the deployment language policy (criterion-scoped: docs/14 §14.20). The policy is evaluated FIRST so the prescan knows
  //    whether a model can be influenced by the text (mode HIGH) or not (LOW, informational), and which cells the language guard must skip.
  const language = d.language ?? DEFAULT_LANGUAGE_POLICY;
  const langScope = assessLanguageScope(terms.criteria, { csv, sha12, metadata }, language);
  const opaque = (col: number) => language.opaqueColumns.includes(csv.headers[col] ?? "");
  const flags: SkepticFlag[] = [
    ...prescan({
      csv,
      sha12,
      metadata,
      budget: d.prescanBudget,
      language: langScope.relevant ? { mode: "HIGH", skip: (row, col) => opaque(col) || (language.scope === "criterion" && row >= MODEL_SAMPLE_ROWS) } : { mode: "LOW" },
    }),
    ...metadataContradictions(metadata, { rowCount: csv.rows.length, anyRequiredFailed }),
  ];
  if (langScope.findings.length > 0 || langScope.incomplete) {
    // merge the scope findings (short strings, uncertain text, split instructions) into the single UNSCANNED_LANGUAGE flag
    const at = flags.findIndex((f) => f.code === "UNSCANNED_LANGUAGE");
    const prior = at >= 0 ? flags[at]! : undefined;
    const reasons = [...new Set(langScope.findings.map((f) => f.reason))].sort().join(", ");
    const merged: SkepticFlag = {
      code: "UNSCANNED_LANGUAGE",
      severity: "HIGH",
      severe: false,
      source: "deterministic",
      evidenceRefs: [...new Set([...(prior?.evidenceRefs ?? []), ...langScope.findings.map((f) => f.ref)])].slice(0, 10).concat(langScope.findings.length || prior ? [] : [`csv:${sha12}#header`]),
      detail: `model-readable text outside the supported languages (${language.supported.join(",")}): ${langScope.total} fragment(s)${langScope.incomplete ? ", not all fragments examined" : ""}${reasons ? ` [${reasons}]` : ""}${prior ? `; ${prior.detail}` : ""}`.slice(0, 300),
    };
    if (at >= 0) flags[at] = merged;
    else flags.push(merged);
  }
  // Text this system cannot read, or did not fully check, is kept away from the AI and can never be turned into a verdict by it.
  const scanIncomplete = flags.some((f) => f.code === "SCAN_INCOMPLETE");
  const languageBlocked = langScope.incomplete || flags.some((f) => f.code === "UNSCANNED_LANGUAGE" && f.severity === "HIGH");
  const blockedReason = scanIncomplete ? "SCAN_INCOMPLETE" : languageBlocked ? "LANGUAGE_UNVERIFIABLE" : null;

  // 3. AI (optional). Its absence or failure never prevents the deterministic result.
  const aiRunRefs: string[] = [];
  let modelCallsMade = 0;
  const onRun = (r: AgentRunRecord) => {
    modelCallsMade++;
    aiRunRefs.push(r.promptHash);
    return d.db.agentRun.create({ data: { dealId: deal.id, role: r.role, model: r.model, promptHash: r.promptHash, outputJson: (r.outputRedacted ?? {}) as Prisma.InputJsonValue, latencyMs: r.latencyMs } }).then(() => undefined);
  };
  const aiCtx: AiContext = { criteria: terms.criteria, checks, csv, sha12, metadata, evidence, language };
  const wantedPasses = Math.min(Math.max(d.passes ?? 2, 1), 3);
  const passes: (ValidatedAi | undefined)[] = [];
  const aiRejected: Rejected[] = [];
  const observations: Observation[] = [];
  let aiStatus: VerificationResult["ai"]["status"] = d.ai ? "UNAVAILABLE" : "NOT_CONFIGURED";
  let summary = "";
  if (d.ai && !modelPolicy.permitted) aiRejected.push({ kind: "pass", reason: "WITHHELD_MODEL_ISOLATION" });
  else if (d.ai && blockedReason) aiRejected.push({ kind: "pass", reason: `WITHHELD_${blockedReason}` });
  if (models.ai && !blockedReason) {
    for (let i = 1; i <= wantedPasses; i++) {
      const out = await models.ai.assess(aiCtx, i, onRun);
      if (out.status !== "COMPLETED") {
        passes.push(undefined);
        aiRejected.push({ kind: "pass", reason: `AI_PASS_${i}_UNAVAILABLE` });
        continue;
      }
      const v = validateAiOutput(out.output, terms.criteria, evidence);
      passes.push(v);
      aiRejected.push(...v.rejected);
      for (const o of v.observations) if (!observations.some((x) => x.kind === o.kind && x.text === o.text)) observations.push(o);
      summary ||= v.summary;
      aiStatus = "COMPLETED";
    }
  }
  let skepticStatus: VerificationResult["skeptic"]["llmStatus"] = d.skeptic ? "UNAVAILABLE" : "NOT_CONFIGURED";
  const skepticRejected: Rejected[] = [];
  if (d.skeptic && !modelPolicy.permitted) skepticRejected.push({ kind: "call", reason: "WITHHELD_MODEL_ISOLATION" });
  if (models.skeptic && !blockedReason) {
    const out = await models.skeptic.assess(aiCtx, onRun);
    if (out.status === "COMPLETED") {
      skepticStatus = "COMPLETED";
      const v = validateSkepticOutput(out.output, evidence);
      skepticRejected.push(...v.rejected);
      for (const f of v.flags) if (!flags.some((x) => x.code === f.code && x.source === f.source)) flags.push(f);
    }
  }

  // 4. per-criterion results. Deterministic criteria take the deterministic verdict, always; llm_judged take the merged AI verdict.
  const criteriaResults: CriterionResult[] = [...terms.criteria]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => {
      const base = { criterionId: c.id, type: c.type, required: c.required, weight: c.weight } as const;
      if (c.type === "deterministic") {
        const k = checks.find((x) => x.criterionId === c.id)!;
        return { ...base, status: k.status, source: "deterministic", validator: k.validator, expected: k.expected, actual: k.actual, reason: k.reason, evidenceRefs: k.evidenceRefs };
      }
      const merged = !modelPolicy.permitted
        ? { status: "UNVERIFIABLE" as const, reason: MODEL_BLOCKED_REASON, actual: "AI-based verification is not permitted for these terms; human review is required until a newly approved V2 deal exists", evidenceRefs: [] as string[] }
        : blockedReason
        ? { status: "UNVERIFIABLE" as const, reason: blockedReason, actual: blockedReason === "SCAN_INCOMPLETE" ? "the delivery was not fully scanned; no AI verdict is accepted" : "model-readable text is outside the supported languages; no AI verdict is accepted", evidenceRefs: [] as string[] }
        : models.ai ? mergePasses(c.id, passes) : { status: "UNVERIFIABLE" as const, reason: "AI_NOT_CONFIGURED", actual: "no AI verifier is configured", evidenceRefs: [] };
      return { ...base, status: merged.status, source: "verifier", expected: c.text.slice(0, 500), actual: merged.actual, reason: merged.reason, evidenceRefs: merged.evidenceRefs, ...(aiRunRefs.length ? { aiRunRefs: aiRunRefs.slice(0, 5) } : {}) };
    });
  const required = criteriaResults.filter((c) => c.required);
  const overall = required.some((c) => c.status === "FAIL") ? "REQUIRED_FAILED" : required.some((c) => c.status === "UNVERIFIABLE") ? "REQUIRED_UNVERIFIABLE" : "ALL_REQUIRED_PASSED";

  const evidenceReferences = [...new Set([...criteriaResults.flatMap((c) => c.evidenceRefs), ...flags.flatMap((f) => f.evidenceRefs), ...observations.flatMap((o) => o.evidenceRefs)])].sort().slice(0, 40);
  const unsealed: Omit<VerificationResult, "resultHash"> = {
    verificationId: sha256Hex(`${deal.id}|${delivery.id}|${sequence}|${VERIFIER_VERSION}`).slice(0, 32),
    dealId: deal.id,
    termsHash: deal.termsHash!,
    artifactSha256: delivery.artifactSha256,
    sequence,
    overall,
    criteriaResults,
    deterministicFailures: criteriaResults.filter((c) => c.type === "deterministic" && c.status === "FAIL").map((c) => c.criterionId),
    unverifiableCriteria: criteriaResults.filter((c) => c.status === "UNVERIFIABLE").map((c) => c.criterionId),
    ai: { status: aiStatus, passes: passes.filter(Boolean).length, observations: observations.slice(0, 60), rejected: aiRejected.slice(0, 100), summary },
    skeptic: { llmStatus: skepticStatus, flags: flags.slice(0, 60), rejected: skepticRejected.slice(0, 100) },
    evidenceReferences,
    provenance: { artifactSizeBytes: delivery.artifactSize, rowCount: csv.rows.length, columnCount: csv.headers.length, parserVersion: PARSER_VERSION, aiRunRefs: [...new Set(aiRunRefs)].slice(0, 10), inputEvidenceRefs: p.inputEvidenceRefs ?? [],
      scan: { languageSupported: [...language.supported], languageScope: language.scope, opaqueColumns: [...language.opaqueColumns], languageRelevant: langScope.relevant, languageFindings: langScope.total, prescanComplete: !scanIncomplete, aiWithheld: blockedReason !== null },
      isolation: { modelCallsPermitted: modelPolicy.permitted, reason: modelPolicy.reason, modelCallsMade },
    },
    verifierVersion: VERIFIER_VERSION,
    createdAt: (d.now ?? (() => new Date()))().toISOString(),
  };
  const result = verificationResultSchema.parse({ ...unsealed, resultHash: resultHashOf(unsealed as VerificationResult) });

  return persistResult(d, { deal, delivery, sequence, result, inputEvidenceRefs: p.inputEvidenceRefs });
}

type DealRow = NonNullable<Awaited<ReturnType<PrismaClient["deal"]["findUnique"]>>>;
type DeliveryRow = NonNullable<Awaited<ReturnType<PrismaClient["delivery"]["findUnique"]>>>;

/** One immutable record per (delivery, sequence); the ledger event is written in the same transaction. A concurrent winner's record is returned instead of a duplicate. */
async function persistResult(
  d: VerifyDeps,
  a: { deal: DealRow; delivery: DeliveryRow; sequence: number; result: VerificationResult; inputEvidenceRefs?: string[] },
): Promise<VerifyOutcome> {
  const { deal, delivery, sequence, result } = a;
  const aiStatus = result.ai.status;
  const skepticStatus = result.skeptic.llmStatus;
  try {
    const run = await d.db.$transaction(async (tx) => {
      const row = await tx.verificationRun.create({
        data: {
          verificationId: result.verificationId,
          dealId: deal.id,
          deliveryId: delivery.id,
          sequence,
          termsHash: result.termsHash,
          artifactSha256: result.artifactSha256,
          verifierVersion: result.verifierVersion,
          overall: result.overall,
          resultJson: result as unknown as Prisma.InputJsonValue,
          resultHash: result.resultHash,
          inputEvidenceRefs: a.inputEvidenceRefs ?? [],
          ...(result.binding ? { termsSchemaVersion: 2, bindingHash: sha256Hex(canonicalJson(result.binding)) } : {}),
        },
      });
      await appendEvent(tx, deal.id, "VERIFICATION_RECORDED", "verification", {
        verificationId: result.verificationId,
        sequence,
        resultHash: result.resultHash,
        overall: result.overall,
        deterministicFailures: result.deterministicFailures,
        unverifiableCriteria: result.unverifiableCriteria,
        flagCodes: result.skeptic.flags.map((f) => `${f.source}:${f.code}`),
        aiStatus,
        skepticStatus,
        aiRunRefs: result.provenance.aiRunRefs,
        rejectedAiItems: result.ai.rejected.length + result.skeptic.rejected.length,
        ...(result.binding ? { termsSchemaVersion: 2, modelCallsMade: result.binding.modelCalls.length, bindingHash: sha256Hex(canonicalJson(result.binding)) } : {}),
      });
      return row;
    });
    return { run, result, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const won = await d.db.verificationRun.findUniqueOrThrow({ where: { deliveryId_sequence: { deliveryId: delivery.id, sequence } } });
      return { run: won, result: verificationResultSchema.parse(won.resultJson), created: false };
    }
    throw e;
  }
}

/** V2 verification: integrity of the stored delivery, then the V2 core, then the same sealing and recording as V1. */
async function verifyV2Delivery(d: VerifyDeps, p: { dealId: string; sequence?: number; inputEvidenceRefs?: string[] }, deal: DealRow, delivery: DeliveryRow, sequence: number): Promise<VerifyOutcome> {
  if (!d.v2 || !deal.termsHash) throw new VerificationError("AUTHORIZATION_INVALID");
  const manifestOk = deliveryManifestSchema.safeParse(delivery.manifestJson);
  const integrity =
    createHash("sha256").update(Buffer.from(delivery.artifactText, "utf8")).digest("hex") === delivery.artifactSha256 &&
    manifestOk.success &&
    sha256Hex(canonicalJson(manifestOk.data)) === delivery.manifestHash &&
    delivery.termsHash === deal.termsHash;
  if (!integrity) {
    await d.db.$transaction((tx) => appendEvent(tx, deal.id, "ARTIFACT_INTEGRITY_FAILURE", "verification", { deliveryId: delivery.id }));
    throw new VerificationError("ARTIFACT_INTEGRITY_FAILURE");
  }
  const csv = parseCsv(delivery.artifactText);
  const comp = await computeV2Verification({
    db: d.db,
    dealId: deal.id,
    deliveryId: delivery.id,
    artifactSha256: delivery.artifactSha256,
    artifactSize: delivery.artifactSize,
    termsHash: deal.termsHash,
    sequence,
    csv,
    sha12: delivery.artifactSha256.slice(0, 12),
    metadata: manifestOk.data!.metadata ?? {},
    v2: d.v2,
    now: d.now ?? (() => new Date()),
    prescanBudget: d.prescanBudget,
    inputEvidenceRefs: p.inputEvidenceRefs ?? [],
  });
  const result = verificationResultSchema.parse({ ...comp.unsealed, resultHash: resultHashOf(comp.unsealed as VerificationResult) });
  return persistResult(d, { deal, delivery, sequence, result, inputEvidenceRefs: p.inputEvidenceRefs });
}
