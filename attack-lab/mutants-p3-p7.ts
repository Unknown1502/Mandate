/**
 * Mutant definitions for the P3-P7 layers (consumed by mutate-layers.ts; this file never runs anything).
 *
 *   Layer E  "P3/P4: V2 terms, attestation, approval, restricted model input, language assessment, evidence scoping, intake binding"
 *   Layer F  "P5: authorization re-derivation, settlement gates, reservation cleanup, HTTP hardening"
 *   Layer G  "P7: detector registry, governance workflow, evaluation core, detector identity"
 *
 * Each mutant weakens ONE real control (or adds a forbidden consumer). The runner applies it inside its own process, runs the named detectors, and restores src/ byte for
 * byte. A mutant that survives is a finding; an INVALID one (search string not found exactly once) is reported as such and never counted as killed.
 */
export interface DetectorDef {
  name: string;
  kind: "unit" | "db" | "lab";
  files?: string[];
}
export interface EditDef {
  find: string;
  replace: string;
}
export interface MutantDef {
  id: string;
  suite: "E" | "F" | "G";
  defence: string;
  file: string;
  edits: EditDef[];
  create?: { content: string };
  detectors: DetectorDef[];
  stopAtFirstKill: boolean;
}

const T2 = "src/domain/terms-v2.ts";
const ATT = "src/domain/attestation.ts";
const POL = "src/domain/policy.ts";
const LPOL = "src/domain/language-policy.ts";
const AUTH = "src/domain/authorization.ts";
const DEALS = "src/domain/deals.ts";
const APPR = "src/domain/deal-approval.ts";
const MIN = "src/verification/model-input.ts";
const MRUN = "src/verification/model-runner.ts";
const LV2 = "src/verification/language-v2.ts";
const PV2 = "src/verification/pipeline-v2.ts";
const BIND = "src/settlement/binding-check.ts";
const ENG = "src/settlement/engine.ts";
const INTAKE = "src/settlement/verification-intake.ts";
const RES = "src/domain/reservations.ts";
const HG = "src/lib/http-guard.ts";
const LOGIN = "src/app/api/auth/login/route.ts";
const NEXTCFG = "next.config.ts";
const REG = "src/domain/detector-registry.ts";
const DEV = "scripts/lib/detector-eval-core.ts";
const LANG = "src/verification/language.ts";
const NEG = "src/domain/negotiation.ts";
const MANDATES = "src/domain/mandates.ts";
const WRITER = "src/domain/mandate-v2-writer.ts";
const GATE = "src/domain/v2-release-gate.ts";
const GLOAD = "src/lib/v2-gate-loader.ts";

const unit = (name: string, ...files: string[]): DetectorDef => ({ name, kind: "unit", files });
const db = (name: string, ...files: string[]): DetectorDef => ({ name, kind: "db", files });

const U_TERMS = unit("V2 terms + policy + lattice + attestation (unit)", "tests/unit/terms-v2.test.ts", "tests/unit/policy-v2.test.ts", "tests/unit/language-policy-attestation.test.ts");
const U_MODEL = unit("restricted model input + language + runner (unit)", "tests/unit/model-input.test.ts", "tests/unit/model-runner-guard.test.ts");
const U_ARCH = unit("architecture (unit)", "tests/unit/authorization-reader-architecture.test.ts", "tests/unit/v2-verifier-isolation.test.ts", "tests/unit/model-boundary-architecture.test.ts", "tests/unit/verification-isolation.test.ts", "tests/unit/orchestration-isolation.test.ts");
const D_AUTH = db("V2 authorization + approval (PostgreSQL)", "tests/db/v2-authorization.db.test.ts");
const D_VERIF = db("V2 verification + intake binding (PostgreSQL)", "tests/db/v2-verification.db.test.ts");
const D_ENF = db("V2 enforcement (PostgreSQL)", "tests/db/v2-enforcement.db.test.ts");
const U_HTTP = unit("HTTP guards (unit)", "tests/unit/http-guard.test.ts");
const U_DEV = unit("detector identity + evaluation (unit)", "tests/unit/detector-eval.test.ts");
const D_NEG = db("V2 negotiation + release gate + terms history (PostgreSQL)", "tests/db/v2-negotiation.db.test.ts");
const U_GATE = unit("V2 release gate (unit)", "tests/unit/v2-release-gate.test.ts");
const D_GOV = db("detector governance (PostgreSQL)", "tests/db/detector-governance.db.test.ts");

const e = (id: string, defence: string, file: string, edits: EditDef[], detectors: DetectorDef[]): MutantDef => ({ id, suite: "E", defence, file, edits, detectors, stopAtFirstKill: true });
const f = (id: string, defence: string, file: string, edits: EditDef[], detectors: DetectorDef[]): MutantDef => ({ id, suite: "F", defence, file, edits, detectors, stopAtFirstKill: true });
const g = (id: string, defence: string, file: string, edits: EditDef[], detectors: DetectorDef[]): MutantDef => ({ id, suite: "G", defence, file, edits, detectors, stopAtFirstKill: true });
const rm = (find: string): EditDef[] => [{ find, replace: "" }];

const SHADOW_RUNNER = `import { ModelRunner } from "./model-runner";
import type { LlmProvider } from "../agents/llm";
export const shadowRunner = (p: LlmProvider) => new ModelRunner(p, "shadow");
`;
const SHADOW_BRIDGE_AUTH = `import { deriveModelAuthorization } from "../verification/model-input";
export const shadowAuth = deriveModelAuthorization;
`;

export const LAYER_E: MutantDef[] = [
  // ---- P3: strict V2 terms and classification
  e("P3-E01", "an AI-judged criterion may carry an EMPTY inputFields list (a criterion with no declared view)", T2, [{ find: "inputFields: z.array(fieldIdSchema).min(1).max(50),", replace: "inputFields: z.array(fieldIdSchema).min(0).max(50)," }], [U_TERMS]),
  e("P3-E02", "unknown keys in V2 terms are silently dropped instead of refused", T2, [{ find: "export const termsV2Schema = z.strictObject({", replace: "export const termsV2Schema = z.object({" }], [U_TERMS]),
  e("P3-E03", "bijection: a field listing a criterion that does not list it back is accepted", T2, rm('      else if (!c.inputFields.includes(f.id)) issues.add("CLASSIFICATION_CONFLICT");\n'), [U_TERMS]),
  e("P3-E04", "bijection: a criterion naming a field that does not list it back is accepted", T2, rm('      else if (!f.criteria.includes(c.id)) issues.add("CLASSIFICATION_CONFLICT");\n'), [U_TERMS]),
  e("P3-E05", "an OPAQUE field may appear in a criterion's inputFields", T2, rm('      else if (f.classification !== "CRITERION_INPUT") issues.add("CLASSIFICATION_CONFLICT");\n'), [U_TERMS]),
  e("P3-E06", "a criterion may name a field that is not declared at all (unclassified fields become model-readable)", T2, [{ find: 'if (!f) issues.add("FIELD_UNKNOWN_IN_CRITERION");', replace: "if (!f) { /* accepted */ }" }], [U_TERMS]),
  e("P3-E07", "the header row and manifest fields no longer have to be declared", T2, [{ find: 'if (!f) issues.add("RESERVED_FIELD_MISSING");', replace: "if (!f) { /* accepted */ }" }], [U_TERMS]),
  e("P3-E08", "the header row / manifest fields may be promoted to CRITERION_INPUT (seller metadata becomes model-readable)", T2, rm('    else if (f.classification !== "OPAQUE") issues.add("RESERVED_FIELD_NOT_OPAQUE");\n'), [U_TERMS]),
  e("P3-E09", "the model-group cap is not enforced", T2, rm('  if (modelGroups(t).length > cap) issues.add("MODEL_GROUP_CAP_EXCEEDED");\n'), [U_TERMS]),
  e("P3-E10", "a deployment can raise the group cap above the absolute maximum of 5", T2, [{ find: "const cap = Math.min(opts.modelGroupCap ?? DEFAULT_MODEL_GROUP_CAP, MAX_MODEL_GROUPS_ABSOLUTE);", replace: "const cap = opts.modelGroupCap ?? DEFAULT_MODEL_GROUP_CAP;" }], [U_TERMS]),
  e("P3-E11", "the default group cap is 5 instead of the strictest 1 (docs/15 Q5 unresolved)", T2, [{ find: "export const DEFAULT_MODEL_GROUP_CAP = 1;", replace: "export const DEFAULT_MODEL_GROUP_CAP = 5;" }], [U_TERMS]),
  e("P3-E12", "the language policy's criterion scope may differ from the AI-judged criteria", T2, rm('    if (scope.length !== want.length || scope.some((s, i) => s !== want[i])) issues.add("LANGUAGE_SCOPE_MISMATCH");\n'), [U_TERMS]),
  e("P3-E13", "deterministic-only V2 terms may carry model configuration", T2, rm('    if (t.artifactSchema || t.languagePolicy) issues.add("MODEL_CONFIG_NOT_ALLOWED");\n'), [U_TERMS]),
  e("P3-E14", "the terms hash does NOT cover the artifact schema or the language policy", T2, [{ find: "export const termsHashV2 = (t: TermsV2): string => sha256Hex(canonicalJson(normalizeTermsV2(t)));", replace: "export const termsHashV2 = (t: TermsV2): string => sha256Hex(canonicalJson((({ artifactSchema: _a, languagePolicy: _l, ...rest }) => rest)(normalizeTermsV2(t))));" }], [U_TERMS]),
  e("P3-E15", "the mapping hash is a constant (the attestation no longer states which mapping was approved)", T2, [{ find: "  const n = normalizeTermsV2(t);\n  return sha256Hex(", replace: '  const n = normalizeTermsV2(t);\n  if (n) return "0".repeat(64);\n  return sha256Hex(' }], [U_TERMS]),
  e("P3-E16", "a terms document with an unknown schemaVersion is no longer refused as unsupported", T2, rm('  if (raw.schemaVersion !== 2) return { ok: false, code: "TERMS_VERSION_UNSUPPORTED" };\n'), [U_TERMS]),
  // ---- P3: TermsAttestation
  e("P3-E17", "the attestation signature is not verified", ATT, rm('  if (!verifyMessage(record.payloadJson, record.signature, rec.publicKeyB64)) return fail("SIGNATURE_INVALID");\n'), [U_TERMS]),
  e("P3-E18", "the attestation is not compared with the CURRENT deal / mandate / terms / mapping / policy", ATT, rm('  for (const [field, got, want] of pairs) if (got !== want) return fail("ATTESTATION_BINDING_MISMATCH", field);\n'), [U_TERMS]),
  e("P3-E19", "the attestation actor is not compared with the mandate's principal (impersonation)", ATT, rm('  if (!ctEqual(p.actor.id, ctx.expectedActorId)) return fail("ATTESTATION_ACTOR_MISMATCH");\n'), [U_TERMS]),
  e("P3-E20", "a non-canonical (but correctly signed) attestation payload is accepted", ATT, rm('  if (canonicalJson(p) !== record.payloadJson) return fail("ATTESTATION_NON_CANONICAL");\n'), [U_TERMS]),
  e("P3-E21", "a disabled key still verifies attestations", ATT, rm('  if (rec.status !== "ACTIVE") return fail("KEY_DISABLED");\n'), [U_TERMS]),
  e("P3-E22", "the attestation purpose tag is not constrained (domain separation lost)", ATT, [{ find: "purpose: z.literal(ATTESTATION_PURPOSE),", replace: "purpose: z.string()," }], [U_TERMS]),
  e("P3-E23", "an attestation of any approval kind is accepted (not only a human approval)", ATT, [{ find: 'approvalKind: z.literal("HUMAN_PREAUTH"),', replace: "approvalKind: z.string()," }], [U_TERMS]),
  // ---- P3: policy and the language lattice
  e("P3-E24", "V2 deals no longer require a human approval attestation", POL, rm('  if (parsed.version === 2) human.push(llm ? "LLM_MAPPING_APPROVAL_REQUIRED" : "V2_TERMS_APPROVAL_REQUIRED");\n'), [U_TERMS]),
  e("P3-E25", "V2 terms are accepted under a V1 mandate", POL, rm('  if (parsed.version === 2 && !v2Mandate) reasons.push("MANDATE_V2_REQUIRED");\n'), [U_TERMS]),
  e("P3-E26", "V1 terms are accepted under a V2 mandate (downgrade around the signed language policy)", POL, rm('  if (parsed.version === 1 && v2Mandate) reasons.push("TERMS_V2_REQUIRED");\n'), [U_TERMS]),
  e("P3-E27", "a terms language policy weaker than the signed mandate floor is accepted", POL, rm('        if (m.schemaVersion === 2 && strictnessFailures(tp, m.languagePolicy).length > 0) reasons.push("LANGUAGE_POLICY_WEAKER_THAN_MANDATE");\n'), [U_TERMS]),
  e("P3-E28", "the deployment switch for AI-judged criteria is ignored (docs/15 Q3 unresolved)", POL, rm('      if (!i.llmCriteriaEnabled) reasons.push("LLM_CRITERIA_NOT_ENABLED");\n'), [U_TERMS]),
  e("P3-E29", "a different detector (version / vocabulary hash) counts as the same detector in the strictness order", LPOL, rm('  if (!sameDetector(a.detector, b.detector)) out.push("DETECTOR_DIFFERS");\n'), [U_TERMS]),
  e("P3-E30", "a deployment floor can WIDEN the supported languages", LPOL, [{ find: "supportedLanguages: p.supportedLanguages.filter((l) => (floorLangs ? floorLangs.has(l) : true)),", replace: "supportedLanguages: f?.supportedLanguages ? [...f.supportedLanguages] : p.supportedLanguages," }], [U_TERMS, U_MODEL]),
  e("P3-E31", "a deployment floor can LOOSEN a behaviour", LPOL, [{ find: "unsupportedBehavior: f?.unsupportedBehavior ? strictest(p.unsupportedBehavior, f.unsupportedBehavior) : p.unsupportedBehavior,", replace: "unsupportedBehavior: f?.unsupportedBehavior ?? p.unsupportedBehavior," }], [U_TERMS]),
  // ---- P3: two-step approval and the legacy path
  e("P3-E32", "the human's echoed digest is not checked", APPR, [{ find: 'if (!safeEqual(p.confirmDigest, digest) || issued.attestationDigest === undefined || !safeEqual(issued.attestationDigest, digest)) throw new ApprovalError("DIGEST_MISMATCH");', replace: "" }], [D_AUTH]),
  e("P3-E33", "an expired approval nonce is accepted", APPR, rm('      if (issued.expiresAt === undefined || new Date(issued.expiresAt) <= now) throw new ApprovalError("NONCE_EXPIRED");\n'), [D_AUTH]),
  e("P3-E34", "the legacy approval path can approve a V2 deal", DEALS, [{ find: 'if (deal.termsSchemaVersion !== 1 || isObjectWithVersion(deal.termsJson)) return { ok: false, reasons: ["ATTESTATION_FLOW_REQUIRED"] };', replace: "" }], [D_AUTH]),
  e("P3-E35", "a human decision waives the V2 approval requirement WITHOUT a verifying attestation", DEALS, [{ find: "if (!v2 || authorizeLoadedDeal(deal, { ...deps, now: deps.now ?? new Date() }, { checkExpiry: true }).ok) result = { outcome: \"OK\", reasons: [] };", replace: 'if (true) result = { outcome: "OK", reasons: [] };' }], [D_AUTH]),
  // ---- P4: restricted model input
  e("P4-E36", "the model-input builder accepts a field that is not CRITERION_INPUT for the group (an OPAQUE field reaches the prompt)", MIN, [{ find: 'if (!f || f.classification !== "CRITERION_INPUT" || name === null || !group.criterionIds.every((c) => f.criteria.includes(c))) return', replace: "if (!f || name === null) return" }], [U_MODEL]),
  e("P4-E37", "rows beyond inputMaxRows are placed in the prompt", MIN, [{ find: "const nRows = Math.min(group.inputMaxRows, MODEL_ROWS_MAX, csv.rows.length);", replace: "const nRows = Math.min(MODEL_ROWS_MAX, csv.rows.length);" }], [U_MODEL]),
  e("P4-E38", "the input size limit is not enforced", MIN, rm('  if (inputChars > MODEL_LIMITS.maxInputChars) return { ok: false, code: "INPUT_TOO_LARGE" };\n'), [U_MODEL]),
  e("P4-E39", "an approved field present twice in the artifact is silently resolved to the first column", MIN, rm('    if (hits.length > 1) return { ok: false, code: "FIELD_AMBIGUOUS", fieldId: fid };\n'), [U_MODEL]),
  e("P4-E40", "an approved field that is absent from the artifact is silently dropped from the view", MIN, rm('    if (hits.length === 0) return { ok: false, code: "INPUT_FIELD_ABSENT", fieldId: fid };\n'), [U_MODEL]),
  e("P4-E41", "the ModelAuthorization brand is never registered (a hand-built authorization is accepted)", MIN, [{ find: "  ISSUED_AUTH.add(a);\n", replace: "" }], [U_MODEL]),
  e("P4-E42", "an authorization without a verified attestation can be derived", MIN, rm('  if (!auth.attestation) return { ok: false, code: "NO_ATTESTATION" };\n'), [U_MODEL]),
  e("P4-E43", "the deployment floor is not applied to the effective policy", MIN, [{ find: "const effective = stricterOf(terms.languagePolicy, floor);", replace: "const effective = stricterOf(terms.languagePolicy, undefined);" }], [U_MODEL]),
  // ---- P4: ModelRunner
  e("P4-E44", "the runner accepts an input that was not issued by buildModelInput", MRUN, rm('    if (!isModelInput(input)) throw new ModelInputViolation(["NOT_A_MODEL_INPUT"]);\n'), [U_MODEL]),
  e("P4-E45", "the runner does not re-check the manifest against the approved view before calling the provider", MRUN, rm("    if (violations.length > 0) throw new ModelInputViolation(violations);\n"), [U_MODEL]),
  e("P4-E46", "the per-verification call budget is not enforced", MRUN, rm("    if (this.opts.maxCalls !== undefined && this.calls >= this.opts.maxCalls) throw new ModelBudgetExceeded();\n"), [U_MODEL]),
  e("P4-E47", "a recording failure changes the outcome of a model call", MRUN, [{ find: "    } catch {\n      /* recording must never turn into a decision */\n    }", replace: "    } catch (err) {\n      throw err;\n    }" }], [U_MODEL]),
  e("P4-E48", "a NEW module constructs a ModelRunner (a second route to a provider)", "src/verification/shadow-runner.ts", [], [U_ARCH]),
  // ---- P4: language assessment on the exact prompt text
  e("P4-E49", "a name-like token in a model-visible field is auto-passed", LV2, [{ find: 'if (c.kind === "NOT_LANGUAGE" || c.kind === "SUPPORTED") continue;', replace: 'if (c.kind === "NOT_LANGUAGE" || c.kind === "SUPPORTED" || c.kind === "NAME_LIKE") continue;' }], [U_MODEL]),
  e("P4-E50", "a detector exception is swallowed as 'not blocked'", LV2, [{ find: 'return { blocked: true, reason: "DETECTOR_ERROR", behaviour: policy.uncertainBehavior, examined, total, findings };', replace: "return { blocked: false, reason: null, behaviour: null, examined, total, findings };" }], [U_MODEL]),
  e("P4-E51", "the fragment-count limit is not enforced (an over-large view is scanned partially or not at all)", LV2, rm('  if (frags.length > lim.maxFragments) return { blocked: true, reason: "SCAN_INCOMPLETE", behaviour: policy.incompleteScanBehavior, ...empty, total: frags.length };\n'), [U_MODEL]),
  e("P4-E52", "the language scan deadline is ignored", LV2, rm('      if (now() - started > lim.deadlineMs) return { blocked: true, reason: "SCAN_INCOMPLETE", behaviour: policy.incompleteScanBehavior, examined, total, findings };\n'), [U_MODEL]),
  e("P4-E53", "a shipped detector that is not the pinned one is not detected", LV2, [{ find: "  if (opts.runtimeDetector) {", replace: "  if (false && opts.runtimeDetector) {" }], [U_MODEL]),
  e("P4-E54", "instructions split across the fields of one row are not screened", LV2, [{ find: "if (fs.length < 2 || fs.some((f) => flaggedCells.has(`${f.row}:${f.fieldId}`))) continue;", replace: "continue;" }], [U_MODEL]),
  // ---- P4: V2 pipeline
  e("P4-E55", "an undeclared artifact column no longer stops AI verification (FIELD_UNCLASSIFIED ignored)", PV2, [{ find: '    if (unclassified.length > 0) {\n      block("FIELD_UNCLASSIFIED");\n      continue;\n    }\n', replace: "" }], [D_VERIF]),
  e("P4-E56", "the language assessment of the exact prompt text is skipped", PV2, [{ find: "    if (lang.blocked) {", replace: "    if (false && lang.blocked) {" }], [D_VERIF]),
  e("P4-E57", "evidence references resolve against the WHOLE artifact instead of the group's restricted view", PV2, [{ find: "const evidence = { sha12, csv: first.input.visibleCsv as ParsedCsv, manifestFields: [] as string[] };", replace: "const evidence = { sha12, csv, manifestFields: Object.keys(p.metadata) };" }], [D_VERIF]),
  e("P4-E58", "the deployment switch / detector permission is not applied at verification time", PV2, [{ find: "!eligibility.ok ?", replace: "false ?" }], [D_VERIF]),
  e("P4-E59", "the stored authorization (attestation, seal, terms hash) is not re-derived before verifying a V2 deal", PV2, [{ find: "if (!base.ok || base.auth.terms.version !== 2 || base.auth.mandate.version !== 2 || !base.auth.attestation || !loaded.attestation) throw new VerificationError(\"AUTHORIZATION_INVALID\");", replace: "" }], [D_VERIF]),
  e("P4-E60", "the shipped detector is not compared with the pinned one by default", PV2, [{ find: "const lang = assessAndClear(first.input, { runtimeDetector: p.v2.deployment?.runtimeDetector ?? shippedDetector() });", replace: "const lang = assessAndClear(first.input, { runtimeDetector: p.v2.deployment?.runtimeDetector });" }], [D_VERIF]),
  // ---- P4: intake binding
  e("P4-E61", "the result's terms hash is not compared with the deal's", BIND, rm('  if (b.termsHash !== a.terms.termsHash || r.termsHash !== a.terms.termsHash) return "BINDING_TERMS_MISMATCH";\n'), [D_VERIF]),
  e("P4-E62", "the result's mapping hash is not compared with the approved mapping", BIND, rm('  if (b.mappingHash !== mappingHashV2(terms)) return "BINDING_MAPPING_MISMATCH";\n'), [D_VERIF]),
  e("P4-E63", "a substituted detector in the result's binding is accepted", BIND, [{ find: 'if (terms.languagePolicy && (b.detector?.id !== terms.languagePolicy.detector.id || b.detector.version !== terms.languagePolicy.detector.version || b.detector.vocabularyHash !== terms.languagePolicy.detector.vocabularyHash)) return "BINDING_POLICY_MISMATCH";', replace: "" }], [D_VERIF]),
  e("P4-E64", "the attestation recorded in the result's binding is not compared with the deal's attestation", BIND, rm('  if (b.attestationNonce !== a.attestation.approvalNonce || b.attestationRecordSha256 !== sha256Hex(a.deal.attestation.payloadJson)) return "BINDING_ATTESTATION_MISMATCH";\n'), [D_VERIF]),
  e("P4-E65", "model calls on fields outside the group's approved view are accepted", BIND, [{ find: " || m.fieldIds.some((f) => !g.fieldIds.includes(f))) return \"BINDING_MODEL_CALLS_INVALID\";", replace: ") return \"BINDING_MODEL_CALLS_INVALID\";" }], [D_VERIF]),
  e("P4-E66", "evidence outside the criterion's approved fields is accepted", BIND, rm('    if (e.fieldId !== null && !c.inputFields.includes(e.fieldId)) return "BINDING_EVIDENCE_INVALID";\n'), [D_VERIF]),
  e("P4-E67", "an AI-judged PASS / FAIL without bound evidence is accepted", BIND, rm('    if (!b.evidence.some((e) => e.criterionId === cr.criterionId)) return "BINDING_UNVERIFIED_CLAIM";\n'), [D_VERIF]),
  e("P4-E68", "a result without a binding is accepted for a V2 deal", BIND, rm('  if (!b) return "V2_RESULT_WITHOUT_BINDING";\n'), [D_VERIF]),
  e("P4-E69", "the runner runs an input whose language was never assessed", MRUN, rm('    if (!isLanguageCleared(input)) own.push("LANGUAGE_NOT_ASSESSED");\n'), [U_MODEL]),
  e("P4-E70", "the runner does not compare the pinned detector with the one this build ships", MRUN, rm('    if (a.detector.id !== rt.id || a.detector.version !== rt.version || a.detector.vocabularyHash !== rt.vocabularyHash) own.push("DETECTOR_MISMATCH");\n'), [U_MODEL]),
  e("P4-E71", "the runner accepts a stale ModelAuthorization", MRUN, rm('    if ((this.opts.now ?? (() => new Date()))().getTime() - a.issuedAtMs > MODEL_AUTH_MAX_AGE_MS) own.push("AUTHORIZATION_STALE");\n'), [U_MODEL]),
  e("P4-E72", "an input is registered as language-cleared even when the assessment blocked it", LV2, [{ find: "  if (!a.blocked) markLanguageCleared(input);", replace: "  markLanguageCleared(input);" }], [U_MODEL]),
  e("P4-E73", "V2 negotiation: a V1 brief is accepted under a V2 mandate (and the reverse)", NEG, rm('  if ((opened.version === 2) !== (p.brief.v2 !== undefined)) return block("BRIEF_VERSION_MISMATCH");\n'), [D_NEG]),
  e("P4-E74", "V2 negotiation: the terms are locked without the verification context (no floor / switch / detector check)", NEG, [{ find: "principalId: p.principalId, deps: d.policy });", replace: "principalId: p.principalId });" }], [D_NEG]),
  e("P4-E75", "V2 negotiation: an invalid classification in the brief is only discovered at lock time, after messages were exchanged", NEG, rm('    if (v2issues.length > 0) return block(`BRIEF_INVALID:${v2issues.join(",")}`);\n'), [D_NEG]),
];
// P4-E48 creates a file
LAYER_E.find((m) => m.id === "P4-E48")!.create = { content: SHADOW_RUNNER };
LAYER_E.find((m) => m.id === "P4-E48")!.file = "src/verification/shadow-runner.ts";
export const SHADOW_AUTH = SHADOW_BRIDGE_AUTH;

export const LAYER_F: MutantDef[] = [
  f("P5-F01", "a tampered / invalid TermsAttestation is no longer refused by the central authorization", AUTH, rm('    if (!v.ok) return fail("ATTESTATION_INVALID", v.field ? `${v.code}:${v.field}` : v.code);\n'), [D_AUTH, D_ENF]),
  f("P5-F02", "a V2 deal without an attestation is authorized", AUTH, [{ find: 'if (!a) return fail("ATTESTATION_MISSING");', replace: "if (!a) return { ok: true, auth: { deal, mandate: m, terms, attestation: null } };" }], [D_AUTH]),
  f("P5-F03", "a revoked mandate still authorizes", AUTH, rm('  if (deal.mandate.revokedAt) return fail("MANDATE_REVOKED");\n'), [D_ENF, D_AUTH]),
  f("P5-F04", "mandate expiry is not checked", AUTH, rm('  if (opts.checkExpiry && new Date(m.doc.expiresAt) <= now) return fail("MANDATE_EXPIRED");\n'), [D_ENF]),
  f("P5-F05", "terms drift (the stored terms no longer hash to the locked hash) is not detected", AUTH, rm('  if (termsHash !== deal.termsHash) return fail("TERMS_DRIFT");\n'), [D_ENF, D_AUTH]),
  f("P5-F06", "a flipped mirrored column (termsSchemaVersion) is not detected", AUTH, rm('  if (deal.termsSchemaVersion !== parsed.version) return fail("COLUMN_HINT_MISMATCH", "termsSchemaVersion");\n'), [D_ENF]),
  f("P5-F07", "a flipped mirrored column (languagePolicyHash) is not detected", AUTH, rm('  if ((deal.languagePolicyHash ?? null) !== lpHash) return fail("COLUMN_HINT_MISMATCH", "languagePolicyHash");\n'), [D_ENF]),
  f("P5-F08", "the active-reservation requirement is ignored", AUTH, [{ find: "const reservationOk = !opts.requireActiveReservation || deal.reservations.some((r) => r.status === \"ACTIVE\" || r.status === \"CONVERTED\");", replace: "const reservationOk = true;" }], [D_ENF]),
  f("P5-F09", "the attestation columns are not compared with the signed payload", AUTH, [{ find: 'return fail("ATTESTATION_INVALID", "COLUMNS_DIFFER_FROM_SIGNED_PAYLOAD");', replace: "attestation = null;" }], [D_AUTH]),
  f("P5-F10", "order creation: an authorization failure no longer refuses the order", ENG, rm("      if (!auth.ok && !TERMS_FAILURES.has(auth.reason)) return { kind: \"refuse\", reason: auth.reason } as const; // nothing is changed; a human can look\n"), [D_AUTH]),
  f("P5-F11", "order creation ignores mandate expiry", ENG, [{ find: "const auth = authorizeLoadedDeal(deal, { ...ctx.deps, now: ctx.now() }, { checkExpiry: true });", replace: "const auth = authorizeLoadedDeal(deal, { ...ctx.deps, now: ctx.now() }, { checkExpiry: false });" }], [D_ENF]),
  f("P5-F12", "settlement does not stop on an authorization failure (it proceeds with unverified terms)", ENG, [{ find: "if (!authz.ok) return toHuman([TERMS_FAILURES.has(authz.reason) ? \"TERMS_DRIFT\" : authz.reason]);", replace: "if (!authz.ok) return toHuman([\"IGNORED\"]);" }], [D_ENF]),
  f("P5-F13", "the pre-send re-derivation before a first CAPTURE is skipped", ENG, rm('    const full = await authorizeDealForCapture(ctx, op.dealId);\n    if (full) return fail("AUTHORIZATION:" + full);\n'), [D_ENF]),
  f("P5-F14", "the intake binding refusal is ignored", INTAKE, rm("  if (refusal) return refuse(refusal);\n"), [D_VERIF]),
  f("P5-F15", "a result resting on model calls is accepted after the deployment stopped permitting them", INTAKE, [{ find: "if (r.binding && r.binding.modelCalls.length > 0 && !authorizeLoadedDeal(full, { ...ctx.deps, now }).ok) return refuse(\"MODEL_USE_NO_LONGER_PERMITTED\");", replace: "" }], [D_VERIF]),
  f("P5-F16", "the reservation sweeper never expires an idle pre-order deal", RES, [{ find: "if (!mandateExpired && d.updatedAt > cutoff) continue;", replace: "continue;" }], [D_ENF]),
  f("P5-F17", "the reservation sweeper does not release a reservation of a terminal deal", RES, [{ find: "      await releaseReservation(tx, fresh.dealId);\n", replace: "" }], [D_ENF]),
  f("P5-F18", "the rate limiter never refuses", HG, rm("      if (arr.length >= o.limit) return false;\n"), [U_HTTP]),
  f("P5-F19", "a request body larger than the limit is buffered and accepted", HG, [{ find: "    if (total > maxBytes) {", replace: "    if (false) {" }], [U_HTTP]),
  f("P5-F20", "the login route no longer consults the rate limiter", LOGIN, [{ find: 'if (!globalLimiter.take("*") || !perClient.take(key)) {', replace: "if (false) {" }], [U_HTTP]),
  f("P5-F21", "the login route reads an unbounded body", LOGIN, [{ find: "const raw = await readJsonBounded(req, 4_096);", replace: "const raw = { ok: true as const, value: await req.json().catch(() => null) };" }], [U_HTTP]),
  f("P5-F22", "clickjacking protection (X-Frame-Options) is removed", NEXTCFG, rm('  { key: "X-Frame-Options", value: "DENY" },\n'), [U_HTTP]),
  f("P5-F23", "API responses are cacheable", NEXTCFG, [{ find: '{ source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },', replace: "" }], [U_HTTP]),
  f("P5-F24", "a NEW settlement-side module derives a ModelAuthorization (model authority outside verification)", "src/settlement/shadow-auth.ts", [], [U_ARCH]),
];
LAYER_F.find((m) => m.id === "P5-F24")!.create = { content: SHADOW_BRIDGE_AUTH };
LAYER_F.push(
  f("P5-F25", "a V2 mandate opens without an open release gate", MANDATES, [{ find: "  if (!gateStillValid(ctx.v2Gate, new Date())) return null; // V2 is disabled until the release gate is open\n", replace: "" }], [D_NEG]),
  f("P5-F26", "the mirrored detector columns are not compared with the signed pin", MANDATES, rm("  if (row.detectorId !== dp.id || row.detectorVersion !== dp.version || row.detectorVocabularyHash !== dp.vocabularyHash) return null;\n"), [D_NEG]),
  f("P5-F27", "a V2 mandate can be written without an open release gate", WRITER, rm('  if (!gateStillValid(p.v2Gate, p.now ?? new Date())) throw new V2DisabledError("V2 is disabled: the release gate is not open");\n'), [D_NEG]),
  f("P5-F28", "an expired release record still opens the gate", GATE, rm('    if (expires <= i.now.getTime()) return closed("RECORD_EXPIRED");\n'), [U_GATE]),
  f("P5-F29", "the release record's signature is not verified", GATE, rm('    if (!verifyMessage(rec.data.payloadJson, rec.data.signature, key.publicKeyB64)) return closed("SIGNATURE_INVALID");\n'), [U_GATE]),
  f("P5-F30", "a release record issued for different source code still opens the gate", GATE, rm('    if (i.runtimeSourceDigest !== p.data.sourceDigest) return closed("SOURCE_DIGEST_MISMATCH");\n'), [U_GATE]),
  f("P5-F31", "the deployment opt-in is ignored", GATE, rm('    if (!i.optedIn) return closed("NOT_OPTED_IN");\n'), [U_GATE]),
  f("P5-F32", "an open gate never expires once built", GATE, [{ find: "isV2GateOpen(g) && new Date(g.expiresAt).getTime() > now.getTime();", replace: "isV2GateOpen(g);" }], [U_GATE]),
  f("P5-F33", "a hand-built object is accepted as an open gate", GATE, [{ find: 'typeof g === "object" && g !== null && OPEN.has(g);', replace: 'typeof g === "object" && g !== null && (g as { kind?: string }).kind === "V2GateOpen";' }], [U_GATE]),
  f("P5-F34", "a disabled / revoked / wrong-algorithm key still validates a release record", GATE, [{ find: 'if (!key || key.status !== "ACTIVE" || key.algorithm !== "ed25519" || publicKeyFingerprint(key.publicKeyB64) !== key.fingerprint) return closed("KEY_NOT_TRUSTED");', replace: 'if (!key) return closed("KEY_NOT_TRUSTED");' }], [U_GATE]),
  f("P5-F35", "a release record may be valid for longer than 30 days", GATE, rm('    if (expires - issued > GATE_MAX_VALIDITY_MS) return closed("RECORD_VALIDITY_TOO_LONG");\n'), [U_GATE]),
  f("P5-F36", "the loader treats the deployment as opted in without the variable", GLOAD, [{ find: 'optedIn: env.MANDATE_V2_ENABLED === "true"', replace: "optedIn: true" }], [U_GATE]),
  f("P5-F37", "the terms version history row is not written", DEALS, rm("    await tx.termsVersion.create({ data: { dealId: p.dealId, version: 1, termsSchemaVersion: 2, termsHash: hash, termsJson: parsed as unknown as Prisma.InputJsonValue, lockedBy: p.actor } });\n"), [D_NEG]),
  f("P5-F38", "a NEW settlement-side module evaluates the release gate itself", "src/settlement/shadow-gate.ts", [], [U_ARCH]),
);
LAYER_F.find((m) => m.id === "P5-F38")!.create = { content: 'import { evaluateV2Gate } from "../domain/v2-release-gate";\nexport const shadowGate = evaluateV2Gate;\n' };

export const LAYER_G: MutantDef[] = [
  g("P7-G01", "tuning and held-out data need not be separate", REG, rm('  if (!datasetsSeparate(r)) out.push("TUNING_AND_HELD_OUT_NOT_SEPARATE");\n'), [U_DEV, D_GOV]),
  g("P7-G02", "undisclosed failures do not block a release", REG, rm("    if (s.undisclosedFailures > 0) out.push(`UNDISCLOSED_FAILURES:${s.name}`);\n"), [U_DEV, D_GOV]),
  g("P7-G03", "the disclosed known gaps may differ from the release manifest (a miss can be hidden after registration)", REG, rm('  if ([...r.knownGaps].sort().join("|") !== [...manifest.knownGaps].sort().join("|")) out.push("KNOWN_GAPS_DIFFER_FROM_MANIFEST");\n'), [U_DEV, D_GOV]),
  g("P7-G04", "surviving mutants do not block a release", REG, rm('  if (r.mutation.survived > 0 || r.mutation.invalid > 0 || r.mutation.unreached > 0) out.push("MUTATION_NOT_CLEAN");\n'), [U_DEV, D_GOV]),
  g("P7-G05", "the prescan performance budget is not enforced", REG, rm('  if (r.perf.ms > r.perf.budgetMs) out.push("PRESCAN_OVER_BUDGET");\n'), [U_DEV, D_GOV]),
  g("P7-G06", "the required evaluation suites are not enforced", REG, rm("  for (const need of REQUIRED_SUITES) if (names.filter((n) => n === need).length !== 1) out.push(`SUITE_MISSING_OR_DUPLICATE:${need}`);\n"), [U_DEV, D_GOV]),
  g("P7-G07", "the submitter may review their own release", REG, [{ find: 'if (p.reviewer.id === row.submittedBy) return deny("REVIEWER_NOT_INDEPENDENT", "the submitter cannot review their own release");', replace: "" }], [D_GOV]),
  g("P7-G08", "a language review need not cover every claimed language", REG, [{ find: 'if (!review.languages || [...need].some((l) => !review.languages!.includes(l as "en"))) return deny("LANGUAGE_REVIEW_INCOMPLETE", "the review must cover every language the release claims");', replace: "" }], [D_GOV]),
  g("P7-G09", "a security review need not name its adversarial corpus", REG, rm('    if (review.kind === "SECURITY" && !review.adversarialCorpusSha256) return deny("SECURITY_REVIEW_NEEDS_CORPUS");\n'), [D_GOV]),
  g("P7-G10", "one person may do both the language and the security review", REG, [{ find: 'if (others.some((e) => e.actor === `human:${p.reviewer.id}`)) return deny("REVIEWERS_NOT_DISTINCT", "language and security review must be done by different people");', replace: "" }], [D_GOV]),
  g("P7-G11", "the approver may be the submitter or a reviewer", REG, [{ find: 'if (actors.includes(`human:${p.approver.id}`)) return deny("APPROVER_NOT_INDEPENDENT", "the approver must differ from the submitter and both reviewers");', replace: "" }], [D_GOV]),
  g("P7-G12", "the releaser may be the submitter", REG, rm('    if (p.releaser.id === row.submittedBy) return deny("RELEASER_NOT_INDEPENDENT");\n'), [D_GOV]),
  g("P7-G13", "approval does not verify the release (hash chain, signatures) first", REG, [{ find: '    const v = verifyRelease(row, p.registry);\n    if (!v.ok) return deny("RELEASE_UNVERIFIABLE", v.code);\n    const evalOk', replace: "    const evalOk" }], [D_GOV]),
  g("P7-G14", "a more permissive release is released without an explicit acknowledgement", REG, [{ find: "if (permissive && p.acknowledgePermissive !== true) return deny(", replace: "if (false) return deny(" }], [D_GOV]),
  g("P7-G15", "the signature of a release-log event is not verified", REG, [{ find: '    if (!verifyMessage(canonicalJson({ purpose: "detector-release-event", releaseId: row.id, seq: e.seq, type: e.type, actor: e.actor, hash: e.hash, keyVersion: e.keyVersion }), e.signature, rec.publicKeyB64)) return { ok: false, code: "EVENT_SIGNATURE_INVALID" };\n', replace: "" }], [D_GOV]),
  g("P7-G16", "the hash chain of the release log is not checked", REG, rm('    if (e.seq !== i + 1 || e.prevHash !== prev) return { ok: false, code: "CHAIN_BROKEN" };\n'), [D_GOV]),
  g("P7-G17", "an event's own hash is not recomputed", REG, rm('    if (expect !== e.hash) return { ok: false, code: "EVENT_HASH_MISMATCH" };\n'), [D_GOV]),
  g("P7-G18", "the status column may differ from the status the log implies", REG, rm('  if (derived !== row.status) return { ok: false, code: "STATUS_DIFFERS_FROM_LOG" };\n'), [D_GOV]),
  g("P7-G19", "the release manifest is not checked against its content hash", REG, rm('  if (contentHashOf(m.data) !== row.contentHash) return { ok: false, code: "CONTENT_HASH_MISMATCH" };\n'), [D_GOV]),
  g("P7-G20", "an untrusted / revoked signing key still verifies the release log", REG, [{ find: 'if (!rec || rec.status !== "ACTIVE" || publicKeyFingerprint(rec.publicKeyB64) !== rec.fingerprint) return { ok: false, code: "SIGNING_KEY_NOT_TRUSTED" };', replace: 'if (!rec) return { ok: false, code: "SIGNING_KEY_NOT_TRUSTED" };' }], [D_GOV]),
  g("P7-G21", "a detector is permitted even if the build ships a different one", REG, [{ find: "    if (d.id !== shipped.id || d.version !== shipped.version || d.vocabularyHash !== shipped.vocabularyHash) return false;\n", replace: "" }], [D_GOV]),
  g("P7-G22", "a detector is permitted whatever the status of its release (draft, revoked ...)", REG, [{ find: "if (!rel || !usable.has(rel.status)) return false;", replace: "if (!rel) return false;" }], [D_GOV]),
  g("P7-G23", "release coverage need not meet the policy's supported languages", REG, [{ find: "return (supported ?? []).every((l) => rel.languageCoverage.includes(l));", replace: "return true;" }], [D_GOV]),
  g("P7-G24", "a RETIRED release can be pinned by new mandates", REG, [{ find: 'const usable = new Set<ReleaseStatus>(mode === "NEW_PIN" ? ["RELEASED"] : ["RELEASED", "RETIRED"]);', replace: 'const usable = new Set<ReleaseStatus>(["RELEASED", "RETIRED"]);' }], [D_GOV]),
  g("P7-G25", "the evaluation core accepts overlapping tuning and held-out fixtures", DEV, rm('  if (ids(inputs.heldOut).some((id) => tIds.has(id))) throw new Error("tuning and held-out fixture ids overlap");\n'), [U_DEV]),
  g("P7-G26", "the evaluation core counts every miss as disclosed", DEV, [{ find: "const undisclosed = failures.filter((r) => !gaps.has(r.id));", replace: "const undisclosed: typeof failures = [];" }], [U_DEV]),
  g("P7-G27", "the evaluation core passes mutation testing whatever the result", DEV, [{ find: "passed: m.killed > 0 && m.survived === 0 && m.invalid === 0 && m.unreached === 0,", replace: "passed: true," }], [U_DEV]),
  g("P7-G28", "the detector identity hash no longer covers the override vocabulary", LANG, [{ find: "    vocab: RAW_VOCAB,\n", replace: "" }], [U_DEV]),
  g("P7-G29", "classifier: a name-like or unidentifiable string is classed as SUPPORTED (auto-passed)", LANG, [{ find: '  return { kind: "NAME_LIKE" };\n}\n\n// ----', replace: '  return { kind: "SUPPORTED" };\n}\n\n// ----' }], [U_MODEL, U_DEV]),
  g("P7-G30", "classifier: Han text is classed as supported even when the policy does not support Chinese", LANG, [{ find: 'if (!policy.supported.includes("zh")) return { kind: "UNSUPPORTED", reason: "script:Han" };', replace: "" }], [U_MODEL]),
  g("P7-G31", "classifier: an identified language outside the policy is classed as supported", LANG, [{ find: 'return policy.supported.includes(lang) ? { kind: "SUPPORTED", reason: `language:${lang}` } : { kind: "UNSUPPORTED", reason: `language:${lang}` };', replace: 'return { kind: "SUPPORTED", reason: `language:${lang}` };' }], [U_MODEL]),
  g("P7-G32", "classifier: the override-vocabulary screen for uncovered languages is removed", LANG, [{ find: "  const vocab = lexiconLanguage(t);\n  if (vocab) return { kind: \"UNSUPPORTED\", reason: `vocabulary:${vocab}` };\n", replace: "" }], [U_MODEL, U_DEV]),
];

const CONF = "src/verification/confusables.ts";
const PRESCAN = "src/verification/prescan.ts";
const U_CONF = unit("confusable screening (unit)", "tests/unit/confusables.test.ts");
LAYER_G.push(
  g("P7-G33", "classifier: a mixed-script / look-alike string is no longer UNCERTAIN (auto-passed as language)", LANG, rm('  if (hasConfusableFinding(t)) return { kind: "UNCERTAIN", reason: "confusable-script" };' + String.fromCharCode(10)), [U_CONF, U_DEV]),
  g("P7-G34", "override vocabulary: the confusable skeleton is not re-screened (a look-alike spelling escapes)", LANG, [{ find: "return sk !== text ? lexiconLanguageOf(sk) : null;", replace: "return null;" }], [U_CONF, U_DEV]),
  g("P7-G35", "prescan: the skeleton re-screen of the joined-text rules is removed", PRESCAN, [{ find: "return sk !== clean && ASCII_WORD.test(sk) ? base(raw, sk) : false;", replace: "return false;" }], [U_CONF, U_DEV]),
  g("P7-G36", "prescan: the CONFUSABLE_SCRIPT_MIX rule never fires", PRESCAN, [{ find: 'test: (_r, c) => confusableFindings(c).map((f) => f.kind).filter((k, i, a) => a.indexOf(k) === i).join(",") || false,', replace: "test: () => false," }], [U_CONF]),
  g("P7-G37", "confusables: a word mixing scripts is not flagged", CONF, [{ find: 'if (scripts.size > 1 && letters >= 2) {', replace: "if (false) {" }], [U_CONF, U_DEV]),
  g("P7-G38", "confusables: a single look-alike letter in an ASCII identifier is not flagged", CONF, [{ find: "} else if (nonLatin.length === 1 && scripts.size === 1 && letters === 1 && asciiAlnum && confusableLetter) {", replace: "} else if (false) {" }], [U_CONF]),
  g("P7-G39", "confusables: a whole-script look-alike word inside Latin text is not flagged", CONF, [{ find: "if (latinOnlyChunks > 0) for (const w of nonLatinOnly)", replace: "if (false) for (const w of nonLatinOnly)" }], [U_CONF]),
  g("P7-G40", "confusables: a whole-script look-alike word is flagged even without Latin context (false positives on real Cyrillic)", CONF, [{ find: "if (latinOnlyChunks > 0) for (const w of nonLatinOnly)", replace: "if (true) for (const w of nonLatinOnly)" }], [U_CONF]),
  g("P7-G41", "skeleton: invisible characters are not removed", CONF, [{ find: 'const nf = text.normalize("NFKC").replace(INVISIBLE, "");', replace: 'const nf = text.normalize("NFKC");' }], [U_CONF]),
  g("P7-G42", "skeleton: combining marks are not removed", CONF, [{ find: '.replace(COMBINING, "")', replace: "" }], [U_CONF]),
  g("P7-G43", "skeleton: look-alike characters are not mapped", CONF, [{ find: "for (const ch of noMarks) out += CONFUSABLES[ch] ?? ch;", replace: "for (const ch of noMarks) out += ch;" }], [U_CONF, U_DEV]),
  g("P7-G44", "skeleton: compatibility (fullwidth) forms are not folded", CONF, [{ find: 'const nf = text.normalize("NFKC").replace(INVISIBLE, "");', replace: 'const nf = text.replace(INVISIBLE, "");' }], [U_CONF]),
  g("P7-G45", "prescan gate: text with a look-alike run is never re-screened", CONF, [{ find: "if (++run >= 4) return true;", replace: "if (++run >= 4000) return true;" }], [U_CONF]),
  g("P7-G46", "the detector identity hash no longer covers the confusable table", LANG, [{ find: "    confusables: Object.entries(CONFUSABLES).sort(([a], [b]) => (a < b ? -1 : 1))," + String.fromCharCode(10), replace: "" }], [U_DEV]),
);
