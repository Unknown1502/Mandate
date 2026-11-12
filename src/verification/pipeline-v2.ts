/**
 * V2 verification core (P4; docs/15 section 15.9.1). Called by pipeline.ts ONLY for deals whose locked terms are V2; V1 verification is untouched (and never calls a model).
 *
 * Flow: re-derive the whole authorization (mandate seal, terms hash, language-policy floor, TermsAttestation) -> classify the artifact against the approved schema (closed
 * world) -> deterministic checks and prescan over ALL fields -> per MODEL GROUP: build the restricted ModelInput, assess the language of exactly the text the prompt
 * contains, and only then call the ModelRunner (two verifier passes + one skeptic) -> validate every output (evidence resolved against the group's restricted view only)
 * -> assemble the unsealed result with a `binding`. Anything that is not a clean, evidenced, unanimous answer is UNVERIFIABLE. No model is ever constructed for a deal
 * without LLM-judged criteria, and nothing in this module can move money: its output is a result, not a decision.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { authorizeLoadedDeal, type AuthorizationDeps } from "../domain/authorization";
import { effectivePolicyHash, stricterOf, weakerDimensions, type DeploymentFloor } from "../domain/language-policy";
import { hasLlmCriteria, languagePolicyHashOf, mappingHashV2, modelGroups, normalizeTermsV2, type CriterionV2, type ModelGroup } from "../domain/terms-v2";
import { mergePasses, validateAiOutput, validateSkepticOutput, type Rejected, type ValidatedAi } from "./ai";
import {
  aiVerifierOutputSchema,
  skepticLlmOutputSchema,
  V2_VERIFIER_VERSION,
  type CriterionResult,
  type Observation,
  type SkepticFlag,
  type VerificationBinding,
  type VerificationResult,
} from "./contracts";
import { PARSER_VERSION, type ParsedCsv } from "./csv";
import { VerificationError } from "./errors";
import { shippedDetector } from "./language";
import { assessAndClear } from "./language-v2";
import { buildModelInput, deriveModelAuthorization, type ModelAuthorization } from "./model-input";
import { ModelBudgetExceeded, ModelInputViolation, type CallManifest, type ModelRunner } from "./model-runner";
import { metadataContradictions, prescan, type PrescanBudget } from "./prescan";
import { runDeterministicChecks } from "./validators";

export interface V2Deployment {
  floor?: DeploymentFloor;
  /** the detector actually shipped (default: this build's own, see shippedDetector): must equal the one pinned by the approved terms, else every group is blocked */
  runtimeDetector?: { id: string; version: string; vocabularyHash: string };
}
export interface VerifyV2Options {
  /** verification context for the stored authorization (key registry, deployment switches, detector permission) */
  authz: AuthorizationDeps;
  /** absent => LLM criteria are UNVERIFIABLE (MODEL_NOT_CONFIGURED); never constructed for a deal without LLM criteria */
  runner?: ModelRunner;
  deployment?: V2Deployment;
  passes?: number;
}

type Merged = { status: "PASS" | "FAIL" | "UNVERIFIABLE"; reason: string; actual: string; evidenceRefs: string[] };
const BLOCK_TEXT: Record<string, string> = {
  LLM_CRITERIA_NOT_ENABLED: "AI-judged criteria are not enabled in this deployment; human review is required",
  DETECTOR_NOT_PERMITTED: "the pinned language detector is not an approved release; human review is required",
  MODEL_NOT_PERMITTED: "AI verification is not permitted for this deal; human review is required",
  MODEL_NOT_CONFIGURED: "no AI verifier is configured; human review is required",
  FIELD_UNCLASSIFIED: "the delivery contains fields the approved schema does not declare; no AI verdict is accepted",
  SCAN_INCOMPLETE: "the delivery was not fully scanned; no AI verdict is accepted",
  LANGUAGE_UNSUPPORTED: "model-readable text is outside the supported languages; no AI was consulted",
  LANGUAGE_UNCERTAIN: "the language of model-readable text could not be established; no AI was consulted",
  DETECTOR_ERROR: "the language detector failed; no AI was consulted",
  LANGUAGE_DETECTOR_MISMATCH: "the shipped language detector is not the one the terms pin; no AI was consulted",
  INPUT_FIELD_ABSENT: "a field the criterion is approved to read is absent from the delivery",
  FIELD_AMBIGUOUS: "a field the criterion is approved to read appears more than once in the delivery",
  INPUT_TOO_LARGE: "the approved view exceeds the model input limit",
  GROUP_UNKNOWN: "internal: model group not found",
  FIELD_NOT_MODEL_READABLE: "a field is not model-readable under the approved mapping",
  MODEL_INPUT_VIOLATION: "the model input failed its own manifest check; no call was made",
  MODEL_CALL_BUDGET_EXCEEDED: "the model call budget was exhausted",
};

const parseEvidence = (ref: string): { fieldId: string | null; row: number | null } => {
  let m = /^csv:[0-9a-f]{12}#row:(\d{1,6}),col:(.+)$/.exec(ref);
  if (m) return { fieldId: `col:${m[2]}`, row: Number(m[1]) };
  m = /^csv:[0-9a-f]{12}#col:(.+)$/.exec(ref);
  if (m) return { fieldId: `col:${m[1]}`, row: null };
  m = /^csv:[0-9a-f]{12}#row:(\d{1,6})$/.exec(ref);
  if (m) return { fieldId: null, row: Number(m[1]) };
  return { fieldId: null, row: null };
};

export interface V2Computation {
  unsealed: Omit<VerificationResult, "resultHash">;
  /** model calls made (each already recorded in AgentRun by this module) */
  modelCallsMade: number;
}

export async function computeV2Verification(p: {
  db: PrismaClient;
  dealId: string;
  deliveryId: string;
  artifactSha256: string;
  artifactSize: number;
  termsHash: string;
  sequence: number;
  csv: ParsedCsv;
  sha12: string;
  metadata: Record<string, string | number | boolean>;
  v2: VerifyV2Options;
  now: () => Date;
  prescanBudget?: Partial<PrescanBudget>;
  inputEvidenceRefs: string[];
}): Promise<V2Computation> {
  const { db, csv, sha12 } = p;
  const authz: AuthorizationDeps = { ...p.v2.authz, now: p.now() };

  // ------------------------------------------------------------------------------------------------ 1. the whole stored authorization, re-derived
  const loaded = await db.deal.findUnique({ where: { id: p.dealId }, include: { mandate: true, reservations: true, attestation: true } });
  if (!loaded) throw new VerificationError("DEAL_NOT_FOUND");
  // everything EXCEPT model eligibility must hold (seal, identity, terms hash, counterparty, classification, group cap, attestation) ...
  const base = authorizeLoadedDeal(loaded, { ...authz, llmCriteriaEnabled: true, detectorPermitted: () => true });
  if (!base.ok || base.auth.terms.version !== 2 || base.auth.mandate.version !== 2 || !base.auth.attestation || !loaded.attestation) throw new VerificationError("AUTHORIZATION_INVALID");
  if (base.auth.terms.termsHash !== p.termsHash) throw new VerificationError("TERMS_DRIFT");
  // ... and separately whether this deployment may let a model read anything for it
  const eligibility = authorizeLoadedDeal(loaded, authz);
  const terms = normalizeTermsV2(base.auth.terms.terms);
  const llm = hasLlmCriteria(terms);
  const groups = llm ? modelGroups(terms) : [];
  const llmById = new Map(terms.criteria.filter((c): c is Extract<CriterionV2, { type: "llm_judged" }> => c.type === "llm_judged").map((c) => [c.id, c] as const));

  // ------------------------------------------------------------------------------------------------ 2. closed-world field classification (exact NFC bytes)
  const declared = new Set((terms.artifactSchema?.fields ?? []).map((f) => f.id));
  const unclassified = llm ? [...new Set(csv.headers.map((h) => `col:${h}`).filter((id) => !declared.has(id) || id !== id.normalize("NFC")))].slice(0, 100) : [];

  // ------------------------------------------------------------------------------------------------ 3. deterministic checks and prescan over ALL fields
  const checks = runDeterministicChecks(terms.criteria, csv, p.artifactSha256);
  const anyRequiredFailed = terms.criteria.some((c) => c.required && c.type === "deterministic" && checks.find((x) => x.criterionId === c.id)?.status === "FAIL");
  const flags: SkepticFlag[] = [
    ...prescan({ csv, sha12, metadata: p.metadata, budget: p.prescanBudget, language: { mode: "OFF" } }),
    ...metadataContradictions(p.metadata, { rowCount: csv.rows.length, anyRequiredFailed }),
  ];
  const scanIncomplete = flags.some((f) => f.code === "SCAN_INCOMPLETE");

  // ------------------------------------------------------------------------------------------------ 4. model groups
  const floor = p.v2.deployment?.floor;
  const effective = llm ? stricterOf(terms.languagePolicy!, floor) : null;
  const notEligible: string | null = !llm ? null : !eligibility.ok ? (eligibility.reason === "LLM_CRITERIA_NOT_ENABLED" || eligibility.reason === "DETECTOR_NOT_PERMITTED" ? eligibility.reason : "MODEL_NOT_PERMITTED") : !p.v2.runner ? "MODEL_NOT_CONFIGURED" : null;
  const derived = llm && notEligible === null ? deriveModelAuthorization(base.auth, floor, groups) : null;
  const authorization: ModelAuthorization | null = derived && derived.ok ? derived.authorization : null;
  if (llm && notEligible === null && !authorization) throw new VerificationError("AUTHORIZATION_INVALID");

  const wantedPasses = Math.min(Math.max(p.v2.passes ?? 2, 1), 3);
  const merged = new Map<string, Merged & { aiRunRefs: string[]; quote?: string; callIds: string[] }>();
  const groupRecords: VerificationBinding["groups"] = [];
  const modelCalls: VerificationBinding["modelCalls"] = [];
  const observations: Observation[] = [];
  const aiRejected: Rejected[] = [];
  const skepticRejected: Rejected[] = [];
  const allCallIds: string[] = [];
  let aiCompleted = 0;
  let skepticCompleted = false;
  let anyBlockedByLanguage = false;
  let languageFindingsTotal = 0;

  const recordCall = async (m: CallManifest, redacted: unknown, inputManifestHash: string) => {
    modelCalls.push({ callId: m.callId, role: m.role, pass: m.pass, groupKey: m.groupKey, criterionIds: m.criterionIds, fieldIds: m.fieldIds, provider: m.provider, model: m.model, promptVersion: m.promptVersion, policyVersion: m.policyVersion, inputManifestHash, inputDigest: m.inputDigest, outputDigest: m.outputDigest, status: m.status });
    allCallIds.push(m.callId);
    await db.agentRun.create({ data: { dealId: p.dealId, role: m.role, model: m.model, promptHash: m.inputDigest, outputJson: (redacted ?? {}) as Prisma.InputJsonValue, latencyMs: m.latencyMs, tokensIn: m.tokensIn, tokensOut: m.tokensOut, inputManifestHash } });
  };

  for (const g of groups) {
    const rec = (outcome: "MODEL_CALLED" | "BLOCKED" | "NOT_ELIGIBLE", blockedReason: string | null, behaviour: string | null, examined: number, findings: number) =>
      groupRecords.push({ groupKey: g.key, criterionIds: [...g.criterionIds], fieldIds: [...g.inputFields], outcome, blockedReason, behaviour, languageExamined: examined, languageFindings: findings });
    const block = (reason: string, outcome: "BLOCKED" | "NOT_ELIGIBLE" = "BLOCKED", behaviour: string | null = null, examined = 0, findings = 0) => {
      rec(outcome, reason, behaviour, examined, findings);
      for (const cid of g.criterionIds) merged.set(cid, { status: "UNVERIFIABLE", reason, actual: BLOCK_TEXT[reason] ?? reason, evidenceRefs: [], aiRunRefs: [], callIds: [] });
    };
    if (notEligible !== null) {
      block(notEligible, "NOT_ELIGIBLE");
      continue;
    }
    if (unclassified.length > 0) {
      block("FIELD_UNCLASSIFIED");
      continue;
    }
    if (scanIncomplete) {
      block("SCAN_INCOMPLETE");
      continue;
    }
    const runner = p.v2.runner!;
    const auth = authorization!;
    const artifact = { csv, sha12, sha256: p.artifactSha256, deliveryId: p.deliveryId };
    const deterministic = checks.map((c) => ({ criterionId: c.criterionId, status: c.status }));
    const first = buildModelInput({ authorization: auth, groupKey: g.key, role: "verifier", pass: 1, artifact, deterministic });
    if (!first.ok) {
      block(first.code);
      continue;
    }
    const lang = assessAndClear(first.input, { runtimeDetector: p.v2.deployment?.runtimeDetector ?? shippedDetector() });
    languageFindingsTotal += lang.total;
    if (lang.blocked) {
      anyBlockedByLanguage = true;
      block(lang.reason!, "BLOCKED", lang.behaviour, lang.examined, lang.total);
      if (lang.reason === "LANGUAGE_UNSUPPORTED" || lang.reason === "DETECTOR_ERROR" || lang.reason === "LANGUAGE_DETECTOR_MISMATCH")
        flags.push({ code: "UNSCANNED_LANGUAGE", severity: "HIGH", severe: false, source: "deterministic", evidenceRefs: lang.findings.map((f) => f.ref).slice(0, 10).concat(lang.findings.length ? [] : [`csv:${sha12}#header`]), detail: `${lang.reason}: ${lang.total} fragment(s) in the approved view; no AI was consulted [${[...new Set(lang.findings.map((f) => f.reason))].sort().join(", ")}]`.slice(0, 300) });
      continue;
    }

    // the evidence of this group can only resolve inside ITS restricted view (no other column, no row beyond inputMaxRows, no manifest field)
    const evidence = { sha12, csv: first.input.visibleCsv as ParsedCsv, manifestFields: [] as string[] };
    const groupCriteria = terms.criteria.filter((c) => g.criterionIds.includes(c.id));
    const passes: (ValidatedAi | undefined)[] = [];
    const callIds: string[] = [];
    let violated = false;
    try {
      for (let i = 1; i <= wantedPasses; i++) {
        const built = i === 1 ? first : buildModelInput({ authorization: auth, groupKey: g.key, role: "verifier", pass: i, artifact, deterministic });
        if (!built.ok) throw new ModelInputViolation([`BUILD_${built.code}`]);
        if (assessAndClear(built.input, { runtimeDetector: p.v2.deployment?.runtimeDetector ?? shippedDetector() }).blocked) throw new ModelInputViolation(["LANGUAGE_BLOCKED_ON_RETRY_PASS"]);
        const r = await runner.run(built.input, aiVerifierOutputSchema);
        await recordCall(r.manifest, r.redacted, built.input.manifestHash);
        callIds.push(r.manifest.callId);
        if (!r.ok) {
          passes.push(undefined);
          aiRejected.push({ kind: "pass", reason: `AI_PASS_${i}_UNAVAILABLE` });
          continue;
        }
        const v = validateAiOutput(r.value, groupCriteria, evidence);
        passes.push(v);
        aiRejected.push(...v.rejected);
        for (const o of v.observations) if (!observations.some((x) => x.kind === o.kind && x.text === o.text)) observations.push(o);
        aiCompleted = Math.max(aiCompleted, passes.filter(Boolean).length);
      }
      const sk = buildModelInput({ authorization: auth, groupKey: g.key, role: "skeptic", pass: 1, artifact, deterministic });
      if (!sk.ok) throw new ModelInputViolation([`BUILD_${sk.code}`]);
      if (assessAndClear(sk.input, { runtimeDetector: p.v2.deployment?.runtimeDetector ?? shippedDetector() }).blocked) throw new ModelInputViolation(["LANGUAGE_BLOCKED_ON_SKEPTIC"]);
      const sr = await runner.run(sk.input, skepticLlmOutputSchema);
      await recordCall(sr.manifest, sr.redacted, sk.input.manifestHash);
      callIds.push(sr.manifest.callId);
      if (sr.ok) {
        skepticCompleted = true;
        const v = validateSkepticOutput(sr.value, evidence);
        skepticRejected.push(...v.rejected);
        for (const f of v.flags) if (!flags.some((x) => x.code === f.code && x.source === f.source)) flags.push(f);
      }
    } catch (e) {
      if (e instanceof ModelInputViolation) violated = true;
      else if (e instanceof ModelBudgetExceeded) violated = true;
      else throw e;
      aiRejected.push({ kind: "group", reason: e instanceof ModelBudgetExceeded ? "MODEL_CALL_BUDGET_EXCEEDED" : "MODEL_INPUT_VIOLATION" });
    }
    if (violated) {
      block(aiRejected[aiRejected.length - 1]!.reason);
      continue;
    }
    rec("MODEL_CALLED", null, null, lang.examined, lang.total);
    for (const cid of g.criterionIds) {
      const m = mergePasses(cid, passes);
      const quote = passes.map((x) => x?.assessments.get(cid)?.quote).find((q) => q !== undefined);
      merged.set(cid, { ...m, aiRunRefs: callIds.slice(0, 5), callIds, ...(quote ? { quote } : {}) });
    }
  }

  // ------------------------------------------------------------------------------------------------ 5. per-criterion results (deterministic criteria ALWAYS take the deterministic verdict)
  const criteriaResults: CriterionResult[] = [...terms.criteria]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((c) => {
      const base_ = { criterionId: c.id, type: c.type, required: c.required, weight: c.weight } as const;
      if (c.type === "deterministic") {
        const k = checks.find((x) => x.criterionId === c.id)!;
        return { ...base_, status: k.status, source: "deterministic" as const, validator: k.validator, expected: k.expected, actual: k.actual, reason: k.reason, evidenceRefs: k.evidenceRefs };
      }
      const m = merged.get(c.id) ?? { status: "UNVERIFIABLE" as const, reason: "AI_NOT_CONFIGURED", actual: "no AI verification was available", evidenceRefs: [], aiRunRefs: [], callIds: [] };
      return { ...base_, status: m.status, source: "verifier" as const, expected: c.text.slice(0, 500), actual: m.actual.slice(0, 600), reason: m.reason.slice(0, 120), evidenceRefs: m.evidenceRefs, ...(m.aiRunRefs.length ? { aiRunRefs: m.aiRunRefs.slice(0, 5) } : {}) };
    });
  const required = criteriaResults.filter((c) => c.required);
  const overall = required.some((c) => c.status === "FAIL") ? "REQUIRED_FAILED" : required.some((c) => c.status === "UNVERIFIABLE") ? "REQUIRED_UNVERIFIABLE" : "ALL_REQUIRED_PASSED";

  const verificationId = sha256Hex(`${p.dealId}|${p.deliveryId}|${p.sequence}|${V2_VERIFIER_VERSION}`).slice(0, 32);
  const evidenceBindings: VerificationBinding["evidence"] = [];
  for (const c of criteriaResults) {
    if (c.type !== "llm_judged") continue;
    const m = merged.get(c.criterionId);
    for (const ref of c.evidenceRefs.slice(0, 20)) {
      const { fieldId, row } = parseEvidence(ref);
      evidenceBindings.push({ criterionId: c.criterionId, ref, fieldId, row, quoteSha256: m?.quote ? sha256Hex(m.quote) : null, callIds: (m?.callIds ?? []).slice(0, 5) });
    }
  }

  const lp = terms.languagePolicy ?? null;
  const floorClean: DeploymentFloor | null = floor ? (Object.fromEntries(Object.entries(floor).filter(([, v]) => v !== undefined)) as DeploymentFloor) : null;
  const binding: VerificationBinding = {
    termsSchemaVersion: 2,
    mandateId: base.auth.mandate.doc.mandateId,
    mandateDigest: base.auth.mandate.mandateDigest,
    termsHash: base.auth.terms.termsHash,
    mappingHash: mappingHashV2(terms),
    languagePolicyHash: languagePolicyHashOf(terms),
    effectivePolicyHash: effective ? effectivePolicyHash(effective) : null,
    deploymentFloorHash: floorClean ? sha256Hex(canonicalJson(floorClean)) : null,
    deploymentWeakerDimensions: lp ? weakerDimensions(lp, floorClean ?? undefined) : [],
    detector: lp ? { ...lp.detector } : null,
    attestationNonce: base.auth.attestation.approvalNonce,
    attestationRecordSha256: sha256Hex(loaded.attestation.payloadJson),
    deliveryId: p.deliveryId,
    verificationId,
    unclassifiedFields: unclassified,
    groups: groupRecords,
    modelCalls,
    evidence: evidenceBindings,
  };

  const evidenceReferences = [...new Set([...criteriaResults.flatMap((c) => c.evidenceRefs), ...flags.flatMap((f) => f.evidenceRefs), ...observations.flatMap((o) => o.evidenceRefs)])].sort().slice(0, 40);
  const llmStatus = (ok: boolean): "NOT_CONFIGURED" | "UNAVAILABLE" | "COMPLETED" => (!llm || !p.v2.runner ? "NOT_CONFIGURED" : ok ? "COMPLETED" : "UNAVAILABLE");
  const unsealed: Omit<VerificationResult, "resultHash"> = {
    verificationId,
    dealId: p.dealId,
    termsHash: base.auth.terms.termsHash,
    artifactSha256: p.artifactSha256,
    sequence: p.sequence,
    overall,
    criteriaResults,
    deterministicFailures: criteriaResults.filter((c) => c.type === "deterministic" && c.status === "FAIL").map((c) => c.criterionId),
    unverifiableCriteria: criteriaResults.filter((c) => c.status === "UNVERIFIABLE").map((c) => c.criterionId),
    ai: { status: llmStatus(aiCompleted > 0), passes: aiCompleted, observations: observations.slice(0, 60), rejected: aiRejected.slice(0, 100), summary: "" },
    skeptic: { llmStatus: llmStatus(skepticCompleted), flags: flags.slice(0, 60), rejected: skepticRejected.slice(0, 100) },
    evidenceReferences,
    provenance: {
      artifactSizeBytes: p.artifactSize,
      rowCount: csv.rows.length,
      columnCount: csv.headers.length,
      parserVersion: PARSER_VERSION,
      aiRunRefs: [...new Set(allCallIds)].slice(0, 10),
      inputEvidenceRefs: p.inputEvidenceRefs.slice(0, 10),
      scan: {
        languageSupported: effective ? [...effective.supportedLanguages] : [],
        languageScope: "criterion",
        opaqueColumns: [],
        languageRelevant: llm,
        languageFindings: languageFindingsTotal,
        prescanComplete: !scanIncomplete,
        aiWithheld: llm && (notEligible !== null || unclassified.length > 0 || scanIncomplete || anyBlockedByLanguage || groupRecords.some((g) => g.outcome !== "MODEL_CALLED")),
      },
      isolation: { modelCallsPermitted: llm && notEligible === null, reason: !llm ? "V2_NO_LLM_CRITERIA" : notEligible === null ? "V2_MODEL_PERMITTED" : "V2_MODEL_NOT_PERMITTED", modelCallsMade: modelCalls.length },
    },
    binding,
    verifierVersion: V2_VERIFIER_VERSION,
    createdAt: p.now().toISOString(),
  };
  return { unsealed, modelCallsMade: modelCalls.length };
}

export type { ModelGroup };
