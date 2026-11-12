/**
 * Layered mutation testing for the P0 architecture.   npm run attack:mutate:layers -- [--suite A|B|all] [--ids P0-A01,M10]
 *
 * WHY THIS EXISTS. attack-lab/mutate.ts (kept unchanged; it is the historical harness and writes reports/mutation.{json,md}) measured the Lab under the
 * pre-P0 architecture. After P0 a V1 deal can no longer reach a model, so six of its mutants became unobservable through the Lab and one (M25) lost its
 * target line. Scores from the two architectures must not be combined, so this runner reports two INDEPENDENT suites and never writes to the historical files:
 *
 *   Layer A  "P0 security boundary": weaken the REAL V1 enforcement (gate, call sites, terms-hash rejection, architecture). Detectors: the P0 isolation tests
 *            (scripted providers + canaries), the repository-wide architecture tests and a Lab subset. A surviving Layer A mutant is a finding.
 *   Layer B  "dormant downstream AI defences": the historical survivors, re-evaluated against an isolated, test-only harness that reaches them
 *            (tests/db/dormant-downstream-defences.db.test.ts; a vitest module mock of the gate that exists only in test code). For every Layer B mutant the
 *            control run on unmutated code must pass, and its tests assert REACH before the mutation is applied. If the control fails the mutant is UNREACHED.
 *
 * Product files are changed only inside this process, restored in a finally block, and the whole src/ tree is hashed before and after (byte-for-byte).
 * No real LLM and no PayPal call is possible: the Lab and the tests use a mock PayPal and scripted providers; the database is mandate_test.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYER_E, LAYER_F, LAYER_G } from "./mutants-p3-p7";

type DetectorKind = "unit" | "db" | "lab";
interface Detector {
  /** short name used in the report */
  name: string;
  kind: DetectorKind;
  files?: string[];
  /** Lab: regex of case ids */
  cases?: string;
}
interface Edit {
  find: string;
  replace: string;
}
interface Mutant {
  id: string;
  suite: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  defence: string;
  file: string;
  edits: Edit[];
  /** instead of editing an existing file, create this one (a new artifact-bearing consumer) */
  create?: { content: string };
  detectors: Detector[];
  /** Layer B only: the detector whose result decides the verdict (must also pass its control, i.e. REACH) */
  deciding?: string;
  /** Layer C: stop at the first detector that kills (cheap detectors first); survivors still run every detector */
  stopAtFirstKill?: boolean;
  /** Layer B: where the weakened line came from */
  historical?: string;
}

const PIPELINE = "src/verification/pipeline.ts";
const GATE = "src/verification/model-gate.ts";
const MODELS_LINE = 'const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted ? { ai: d.ai, skeptic: d.skeptic } : {};';

const UNIT_P0: Detector = { name: "P0 unit+architecture", kind: "unit", files: ["tests/unit/model-gate.test.ts", "tests/unit/model-boundary-architecture.test.ts"] };
const DB_P0: Detector = { name: "P0 isolation (canaries)", kind: "db", files: ["tests/db/model-isolation.db.test.ts"] };
const LAB_P0: Detector = { name: "Lab subset (real gate)", kind: "lab", cases: "^(A1|G18|G19|G20|G26|G27|G32)$" };

const SHADOW_VERIFIER = `import { LlmAiVerifier, type AiContext } from "./ai";
import type { LlmProvider } from "../agents/llm";
export async function shadowVerify(provider: LlmProvider, ctx: AiContext) {
  return new LlmAiVerifier(provider, "shadow").assess(ctx, 1);
}
`;
const SHADOW_LLM = `import { callLLM, type LlmProvider } from "../agents/llm";
import { z } from "zod";
export async function shadowJudge(provider: LlmProvider, artifactText: string) {
  return callLLM({ provider, model: "shadow", role: "shadow", system: "judge", user: artifactText, schema: z.object({ ok: z.boolean() }).strict() });
}
`;
const SHADOW_PROVIDER = `import { GeminiProvider } from "../agents/llm";
export const shadowProvider = new GeminiProvider("not-a-real-key", "not-a-real-model");
`;

const LAYER_A: Mutant[] = [
  { id: "P0-A01", suite: "A", defence: "the model gate decision is ignored (verifier and skeptic always reachable)", file: PIPELINE, edits: [{ find: MODELS_LINE, replace: "const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = { ai: d.ai, skeptic: d.skeptic };" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A02", suite: "A", defence: "a VERIFIER call is permitted for V1 deterministic-only terms", file: PIPELINE, edits: [{ find: MODELS_LINE, replace: "const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted ? { ai: d.ai, skeptic: d.skeptic } : modelPolicy.hasLlmCriteria ? {} : { ai: d.ai };" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A03", suite: "A", defence: "a SKEPTIC call is permitted for V1 deterministic-only terms", file: PIPELINE, edits: [{ find: MODELS_LINE, replace: "const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted ? { ai: d.ai, skeptic: d.skeptic } : modelPolicy.hasLlmCriteria ? {} : { skeptic: d.skeptic };" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A04", suite: "A", defence: "models are permitted for V1 LLM-judged terms (the gate returns permitted = hasLlmCriteria)", file: GATE, edits: [{ find: "return { permitted: false, hasLlmCriteria,", replace: "return { permitted: hasLlmCriteria, hasLlmCriteria," }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A05", suite: "A", defence: "the gate permits models for deterministic-only terms (permitted = !hasLlmCriteria)", file: GATE, edits: [{ find: "return { permitted: false, hasLlmCriteria,", replace: "return { permitted: !hasLlmCriteria, hasLlmCriteria," }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A06", suite: "A", defence: "missing / invalid terms-hash rejection is bypassed before the gate", file: PIPELINE, edits: [{ find: 'if (!deal.termsHash || !termsMatchLock(deal.termsJson, deal.termsHash)) throw new VerificationError("TERMS_DRIFT");', replace: "" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A07", suite: "A", defence: "an unknown criterion type no longer fails closed in the gate", file: GATE, edits: [{ find: 'else if (type !== "deterministic") throw new UnclassifiableTermsError("unknown criterion type");', replace: "" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A08", suite: "A", defence: "an empty / non-list criteria set no longer fails closed in the gate", file: GATE, edits: [{ find: 'if (!Array.isArray(criteria) || criteria.length === 0) throw new UnclassifiableTermsError("no criteria");', replace: "" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A09", suite: "A", defence: "the gate is bypassed on re-verification (sequence > 1: challenge / replay path)", file: PIPELINE, edits: [{ find: MODELS_LINE, replace: "const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted || sequence > 1 ? { ai: d.ai, skeptic: d.skeptic } : {};" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A10", suite: "A", defence: "the gate is bypassed whenever claim options are supplied (every orchestrated run: retry, restart, worker recovery)", file: PIPELINE, edits: [{ find: MODELS_LINE, replace: "const models: { ai?: AiVerifier; skeptic?: LlmSkeptic } = modelPolicy.permitted || d.claim !== undefined ? { ai: d.ai, skeptic: d.skeptic } : {};" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  { id: "P0-A11", suite: "A", defence: "a V1 LLM-judged criterion no longer carries the P0 blocked reason / UNVERIFIABLE status", file: PIPELINE, edits: [{ find: "const merged = !modelPolicy.permitted", replace: "const merged = false" }], detectors: [UNIT_P0, DB_P0, LAB_P0] },
  {
    id: "P0-M25", suite: "A", defence: "REPLACES historical M25: a blocked verifier call is allowed (the call falls back to the raw configured verifier d.ai when the gate refuses)", file: PIPELINE,
    edits: [{ find: "if (models.ai && !blockedReason) {", replace: "if ((models.ai ?? d.ai) && !blockedReason) {" }, { find: "const out = await models.ai.assess(aiCtx, i, onRun);", replace: "const out = await (models.ai ?? d.ai)!.assess(aiCtx, i, onRun);" }],
    detectors: [UNIT_P0, DB_P0, LAB_P0],
  },
  {
    id: "P0-A13", suite: "A", defence: "a blocked SKEPTIC call is allowed (falls back to the raw configured skeptic d.skeptic)", file: PIPELINE,
    edits: [{ find: "if (models.skeptic && !blockedReason) {", replace: "if ((models.skeptic ?? d.skeptic) && !blockedReason) {" }, { find: "const out = await models.skeptic.assess(aiCtx, onRun);", replace: "const out = await (models.skeptic ?? d.skeptic)!.assess(aiCtx, onRun);" }],
    detectors: [UNIT_P0, DB_P0, LAB_P0],
  },
  { id: "P0-A14", suite: "A", defence: "NEW direct artifact-bearing consumer: a module outside the pipeline instantiates and calls LlmAiVerifier", file: "src/verification/shadow-verifier.ts", edits: [], create: { content: SHADOW_VERIFIER }, detectors: [UNIT_P0] },
  { id: "P0-A15", suite: "A", defence: "NEW direct model consumer: a module outside the approved sites calls callLLM with artifact text", file: "src/settlement/shadow-llm.ts", edits: [], create: { content: SHADOW_LLM }, detectors: [UNIT_P0] },
  { id: "P0-A16", suite: "A", defence: "NEW model provider created in production source (a second route to the vendor)", file: "src/lib/shadow-provider.ts", edits: [], create: { content: SHADOW_PROVIDER }, detectors: [UNIT_P0] },
  {
    id: "P0-A17", suite: "A", defence: "the orchestrator calls the configured verifier directly, outside the pipeline", file: "src/orchestration/service.ts",
    edits: [{ find: "private async verifyAndSubmit(dealId: string, sequence: number, evidenceRefs: string[] | undefined): Promise<Step> {", replace: "private async verifyAndSubmit(dealId: string, sequence: number, evidenceRefs: string[] | undefined): Promise<Step> {\n    void this.d.verify?.ai?.assess({} as never, 1).catch(() => undefined);" }],
    detectors: [UNIT_P0, DB_P0],
  },
];

// ---- Layer B: the six survivors of the post-P0 run, verbatim from the historical definitions, plus M25b (M25's defence re-expressed on the current line)
const DORMANT: Detector = { name: "Layer B isolated harness", kind: "db", files: ["tests/db/dormant-downstream-defences.db.test.ts"] };
const REACH_P0: Detector = { name: "P0-reachable probes (real gate)", kind: "db", files: ["tests/db/p0-reachable-scan-defences.db.test.ts"] };
const labReal = (cases: string): Detector => ({ name: "historical Lab cases (real P0 gate)", kind: "lab", cases });
const unit = (name: string, ...files: string[]): Detector => ({ name, kind: "unit", files });

const LAYER_B: Mutant[] = [
  { id: "M10", suite: "B", historical: "M10", defence: "an LLM-only required failure must go to a human (mutant: it voids instead)", file: "src/domain/settlement.ts", edits: [{ find: "if (llmFailed.length > 0) return human(earned, llmFailed.map((c) => `LLM_REQUIRED_NOT_MET:${c.id}`));", replace: 'if (llmFailed.length > 0) return { decision: "VOID", earned, amount: zero(), reasons: llmFailed.map((c) => `LLM_REQUIRED_NOT_MET:${c.id}`) };' }], deciding: DORMANT.name, detectors: [labReal("^A[1-4]$"), DORMANT, unit("existing unit: settlement-pure", "tests/unit/settlement-pure.test.ts")] },
  { id: "M13", suite: "B", historical: "M13", defence: "UNSCANNED_LANGUAGE escalates (mutant: severity LOW, so it no longer reaches a human)", file: "src/verification/prescan.ts", edits: [{ find: 'code: "UNSCANNED_LANGUAGE", severity: "HIGH"', replace: 'code: "UNSCANNED_LANGUAGE", severity: "LOW"' }], deciding: DORMANT.name, detectors: [labReal("^(G35|I5g|I5h|I5i|I5j|I5k)$"), DORMANT, { name: "historical Lab G23 (det-only, scope all, real gate)", kind: "lab", cases: "^G23$" }, unit("existing unit: language-coverage", "tests/unit/language-coverage.test.ts")] },
  { id: "M20", suite: "B", historical: "M20", defence: "UNSCANNED_LANGUAGE blocks the AI: the model is no longer kept away from unreadable text", file: PIPELINE, edits: [{ find: 'const languageBlocked = langScope.incomplete || flags.some((f) => f.code === "UNSCANNED_LANGUAGE" && f.severity === "HIGH");', replace: "const languageBlocked = false;" }], deciding: DORMANT.name, detectors: [labReal("^(G01|G11|G15|G24|I5g|I5j|I5l)$"), DORMANT, unit("existing unit: language-scope", "tests/unit/language-scope.test.ts")] },
  { id: "M23", suite: "B", historical: "M23", defence: "withheld (opaque) columns are not withheld from the prompt", file: "src/verification/ai.ts", edits: [{ find: 'const withheld = (j: number) => ctx.language?.opaqueColumns.includes(ctx.csv.headers[j] ?? "") === true;', replace: "const withheld = (_j: number) => false;" }], deciding: DORMANT.name, detectors: [labReal("^(G18|G32)$"), DORMANT, unit("existing unit: language-scope", "tests/unit/language-scope.test.ts")] },
  { id: "M24", suite: "B", historical: "M24", defence: "withheld (opaque) columns are not exempt from the pipeline's language guard", file: PIPELINE, edits: [{ find: 'const opaque = (col: number) => language.opaqueColumns.includes(csv.headers[col] ?? "");', replace: "const opaque = (_col: number) => false;" }], deciding: DORMANT.name, detectors: [labReal("^G32$"), DORMANT, REACH_P0] },
  { id: "M27", suite: "B", historical: "M27", defence: "an incomplete prescan is treated as complete by the pipeline", file: PIPELINE, edits: [{ find: 'const scanIncomplete = flags.some((f) => f.code === "SCAN_INCOMPLETE");', replace: "const scanIncomplete = false;" }], deciding: DORMANT.name, detectors: [labReal("^G30$"), DORMANT, REACH_P0, unit("existing unit: prescan-budget", "tests/unit/prescan-budget.test.ts")] },
  { id: "M25b", suite: "B", historical: "M25 (target line changed by P0)", defence: "the AI verifier is called on text the policy blocked (M25 re-expressed on the current line: the language/scan block no longer stops the call)", file: PIPELINE, edits: [{ find: "if (models.ai && !blockedReason) {", replace: "if (models.ai) {" }], deciding: DORMANT.name, detectors: [labReal("^(G01|G11|G30|I5g|I5j)$"), DORMANT] },
];


// ---- Layer C: the P1 forward-compatibility reader guards (strict version dispatch, unknown fields, duplicate keys, bypass attempts)
const TERMS = "src/domain/terms.ts";
const MANDATE = "src/domain/mandate.ts";
const SJSON = "src/lib/strict-json.ts";
const UNIT_C: Detector[] = [
  { name: "strict-json unit", kind: "unit", files: ["tests/unit/strict-json.test.ts"] },
  { name: "readers unit (golden fixtures, adversarial)", kind: "unit", files: ["tests/unit/authorization-readers.test.ts"] },
  { name: "reader architecture", kind: "unit", files: ["tests/unit/authorization-reader-architecture.test.ts"] },
  { name: "session unit", kind: "unit", files: ["tests/unit/session.test.ts"] },
];
const DB_C: Detector = { name: "readers DB (all read paths)", kind: "db", files: ["tests/db/authorization-readers.db.test.ts"] };
const c = (id: string, defence: string, file: string, edits: Edit[], extra: Partial<Mutant> = {}): Mutant => ({ id, suite: "C", defence, file, edits, detectors: [...UNIT_C, DB_C], stopAtFirstKill: true, ...extra });
const ROGUE_READER = `import type { MandateDocument } from "./mandate";
export const rogueRead = (text: string) => JSON.parse(text) as MandateDocument;
`;
const ROGUE_TERMS = `import { termsSchema } from "../domain/terms";
export const rogueTerms = (deal: { termsJson: unknown }) => termsSchema.parse(deal.termsJson);
`;
const ROGUE_V2_WRITER = `export const futureMandate = { schemaVersion: 2, principalId: "p", languagePolicy: {} };
`;
const LAYER_C: Mutant[] = [
  c("P1-C01", "a duplicate JSON key is accepted (last value wins again)", SJSON, [{ find: 'if (seen.has(key)) throw new Fail("DUPLICATE_KEY");', replace: "" }]),
  c("P1-C02", "the __proto__ key is accepted", SJSON, [{ find: 'if (key === "__proto__") throw new Fail("FORBIDDEN_KEY");', replace: "" }]),
  c("P1-C03", "trailing text after the JSON document is accepted", SJSON, [{ find: "if (i !== text.length) bad();", replace: "" }]),
  c("P1-C04", "an explicit schemaVersion on a mandate is no longer refused as an unsupported version", MANDATE, [{ find: 'if (keys.includes("schemaVersion")) return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" };', replace: "" }]),
  c("P1-C05", "unknown mandate fields are tolerated and dropped (explicit check removed AND the strict schemas loosened)", MANDATE, [
    { find: 'if (keys.some((k) => !known.has(k))) return { ok: false, code: "UNKNOWN_FIELD" };', replace: "" },
    { find: "V1_FULL: z.strictObject(", replace: "V1_FULL: z.object(" },
    { find: "V1_NO_CANCELLATION_FLAG: z.strictObject(", replace: "V1_NO_CANCELLATION_FLAG: z.object(" },
    { find: "V1_BASE: z.strictObject(", replace: "V1_BASE: z.object(" },
  ]),
  c("P1-C06", "the ambiguous shape (cancellation flag without the partial flag) is guessed to be the base shape", MANDATE, [{ find: ': !cancel ? "V1_BASE" : null;', replace: ': "V1_BASE";' }]),
  c("P1-C07", "a missing base authorization field is no longer detected by the dispatcher", MANDATE, [{ find: 'if (BASE_KEYS.some((k) => !keys.includes(k))) return { ok: false, code: "MISSING_FIELD" };', replace: "" }]),
  c("P1-C08", "the opener casts JSON.parse output instead of validating (the pre-P1 behaviour)", MANDATE, [{ find: "  return readMandateDocument(s.canonicalJson);\n}", replace: '  return { ok: true, doc: JSON.parse(s.canonicalJson) as MandateDocument, shape: "V1_FULL" };\n}' }]),
  c("P1-C09", "the mandate reader uses JSON.parse (duplicate keys accepted) instead of the strict parser", MANDATE, [{ find: "  const parsed = parseStrictJson(text);\n  if (!parsed.ok) return { ok: false, code: parsed.code };\n  const v = parsed.value;", replace: '  let v: unknown;\n  try {\n    v = JSON.parse(text as string);\n  } catch {\n    return { ok: false, code: "MALFORMED_JSON" };\n  }' }]),
  c("P1-C10", "an explicit schemaVersion on terms is no longer refused as an unsupported version", TERMS, [{ find: 'if (has(raw, "schemaVersion")) return { ok: false, code: "TERMS_VERSION_UNSUPPORTED" };', replace: "" }]),
  c("P1-C11", "a schemaVersion on a criterion is no longer refused", TERMS, [{ find: 'if (Array.isArray(raw.criteria) && raw.criteria.some((c) => isPlainObject(c) && has(c, "schemaVersion"))) return { ok: false, code: "CRITERION_VERSION_UNSUPPORTED" };', replace: "" }]),
  c("P1-C12", "the terms schema silently strips unknown top-level fields again (non-strict)", TERMS, [{ find: "export const termsSchema = z.strictObject({", replace: "export const termsSchema = z.object({" }]),
  c("P1-C13", "the deterministic criterion schema silently strips unknown criterion fields again", TERMS, [{ find: '  z.strictObject({\n    ...criterionBase,\n    type: z.literal("deterministic"),', replace: '  z.object({\n    ...criterionBase,\n    type: z.literal("deterministic"),' }]),
  c("P1-C14", "termsMatchLock hashes the raw stored object without the version-dispatching reader", TERMS, [{ find: "  const r = readTerms(storedTermsJson);\n  return r.ok && termsHash(r.terms) === lockedHash;", replace: "  return termsHash(storedTermsJson as TermsV1) === lockedHash;" }]),
  c("P1-C15", "the policy engine reports a future terms version as plain invalid terms (version information lost)", "src/domain/policy.ts", [{ find: 'parsed.code === "TERMS_VERSION_UNSUPPORTED" || parsed.code === "CRITERION_VERSION_UNSUPPORTED" ? "TERMS_VERSION_UNSUPPORTED" : "TERMS_INVALID"', replace: '"TERMS_INVALID"' }]),
  c("P1-C16", "the session token schema silently strips unknown fields again", "src/lib/session.ts", [{ find: "z.strictObject({ uid", replace: "z.object({ uid" }]),
  c("P1-C17", "the mandate WRITER emits a version field (a V2-looking document)", MANDATE, [{ find: "  return {\n    principalId,\n    currency: draft.currency,", replace: "  return {\n    schemaVersion: 2,\n    principalId,\n    currency: draft.currency," }]),
  c("P1-C18", "NEW module parses a mandate document itself with JSON.parse and a cast", "src/domain/rogue-reader.ts", [], { create: { content: ROGUE_READER }, detectors: [UNIT_C[2]!] }),
  c("P1-C19", "NEW module reads stored terms with the writer schema, bypassing the dispatcher", "src/settlement/rogue-terms.ts", [], { create: { content: ROGUE_TERMS }, detectors: [UNIT_C[2]!] }),
  c("P1-C20", "NEW module writes a future-version authorization document", "src/domain/v2-writer.ts", [], { create: { content: ROGUE_V2_WRITER }, detectors: [UNIT_C[2]!] }),
  c("P1-C21", "integrity check trusts a non-string ledger digest (cast regression)", "src/orchestration/integrity.ts", [{ find: 'const recorded = stringField(created?.payload, "mandateDigest");', replace: 'const recorded = (created?.payload as { mandateDigest?: string } | undefined)?.mandateDigest;' }], { detectors: [UNIT_C[2]!] }),
];


// ---- Layer D: the P2 V2 seal verifier and its key registry (cryptographic checks, canonical bytes, key policy) and its operational isolation
const V2F = "src/domain/mandate-v2.ts";
const KREG = "src/domain/key-registry.ts";
const UNIT_D: Detector[] = [
  { name: "V2 seal vectors", kind: "unit", files: ["tests/unit/mandate-v2-seal.test.ts"] },
  { name: "key registry", kind: "unit", files: ["tests/unit/key-registry.test.ts"] },
  { name: "V2 isolation (architecture)", kind: "unit", files: ["tests/unit/v2-verifier-isolation.test.ts"] },
  { name: "reader architecture", kind: "unit", files: ["tests/unit/authorization-reader-architecture.test.ts"] },
  { name: "V1/P1 readers (golden, adversarial)", kind: "unit", files: ["tests/unit/authorization-readers.test.ts"] },
];
const d = (id: string, defence: string, file: string, edits: Edit[], extra: Partial<Mutant> = {}): Mutant => ({ id, suite: "D", defence, file, edits, detectors: UNIT_D, stopAtFirstKill: true, ...extra });
const SIGLINE = 'if (!verifyMessage(message, env.signature, rec.publicKeyB64)) return fail("SIGNATURE_INVALID");';
const SHADOW_V2_BRIDGE = `import { verifyV2MandateSeal } from "../domain/mandate-v2";
export const bridge = verifyV2MandateSeal;
`;
const LAYER_D: Mutant[] = [
  d("P2-D01", "signature check bypassed (a valid-looking envelope is accepted without verifying the Ed25519 signature)", V2F, [{ find: SIGLINE, replace: "" }]),
  d("P2-D02", "digest check bypassed", V2F, [{ find: 'if (!constantTimeEqual(sha256Hex(env.canonicalJson), env.mandateDigest)) return fail("DIGEST_MISMATCH");', replace: "" }]),
  d("P2-D03", "purpose-tag bypass: a signature made for ANOTHER purpose (terms-attestation) is also accepted", V2F, [{ find: SIGLINE, replace: 'if (!verifyMessage(message, env.signature, rec.publicKeyB64) && !verifyMessage(canonicalJson(buildV2SignedPayload(doc, env, "terms-attestation")), env.signature, rec.publicKeyB64)) return fail("SIGNATURE_INVALID");' }]),
  d("P2-D04", "schema-version bypass: a document whose schemaVersion is not 2 is no longer refused (peek removed AND the literal loosened)", V2F, [
    { find: 'if ((value as Record<string, unknown>).schemaVersion !== 2) return fail("UNSUPPORTED_SCHEMA_VERSION");', replace: "" },
    { find: "schemaVersion: z.literal(2),", replace: "schemaVersion: z.number()," },
  ]),
  d("P2-D05", "mandate-ID mismatch accepted (the signed id is not compared with the external record id)", V2F, [{ find: 'if (typeof ctx.expected?.mandateId !== "string" || !constantTimeEqual(doc.mandateId, ctx.expected.mandateId)) return fail("MANDATE_ID_MISMATCH");', replace: "" }]),
  d("P2-D06", "nonce mismatch accepted (the expected nonce is not compared)", V2F, [{ find: 'if (ctx.expected.nonce !== undefined && (typeof ctx.expected.nonce !== "string" || !constantTimeEqual(doc.nonce, ctx.expected.nonce))) return fail("NONCE_MISMATCH");', replace: "" }]),
  d("P2-D07", "unknown key accepted: the registry falls back to its first record for an unregistered version", KREG, [{ find: "(byVersion.get(keyVersion) ?? null)", replace: "(byVersion.get(keyVersion) ?? [...byVersion.values()][0] ?? null)" }]),
  d("P2-D07b", "unknown key accepted: the verifier no longer checks that the returned record is for the requested version", V2F, [{ find: 'if (rec.keyVersion !== env.keyVersion) return fail("KEY_VERSION_UNKNOWN");', replace: "" }]),
  d("P2-D08", "revoked key accepted", V2F, [{ find: 'if (rec.status === "REVOKED") return fail("KEY_REVOKED");', replace: "" }]),
  d("P2-D09", "disabled (and any non-ACTIVE) key accepted", V2F, [{ find: 'if (rec.status !== "ACTIVE") return fail("KEY_DISABLED");', replace: "" }]),
  d("P2-D10", "duplicate JSON keys accepted: the document is parsed with JSON.parse (last value wins)", V2F, [{ find: "const json = parseStrictJson(env.canonicalJson, { maxBytes: MAX_DOCUMENT_BYTES });\n  if (!json.ok) return fail(json.code);", replace: 'let jv: unknown;\n  try {\n    jv = JSON.parse(env.canonicalJson);\n  } catch {\n    return fail("MALFORMED_JSON");\n  }\n  const json = { ok: true as const, value: jv };' }]),
  d("P2-D11", "non-canonical (but correctly signed) payload accepted", V2F, [{ find: 'if (canonical !== env.canonicalJson) return fail("NON_CANONICAL_DOCUMENT");', replace: "" }]),
  d("P2-D12a", "authorization-field omission: expiresAt dropped from the signed authorization echo", V2F, [{ find: "      expiresAt: doc.expiresAt,\n    },\n    approvedBy", replace: "    },\n    approvedBy" }]),
  d("P2-D12b", "authorization-field omission: languagePolicyHash dropped from the signed payload", V2F, [{ find: "    languagePolicyHash: sha256Hex(canonicalJson(doc.languagePolicy)),\n", replace: "" }]),
  d("P2-D12c", "authorization-field omission: carryOverHash dropped from the signed payload", V2F, [{ find: "    carryOverHash: sha256Hex(canonicalJson(doc.carryOver)),\n", replace: "" }]),
  d("P2-D12d", "authorization-field omission: principalId dropped from the signed payload", V2F, [{ find: "    principalId: doc.principalId,\n    mandateDigest", replace: "    mandateDigest" }]),
  d("P2-D13", "V1/V2 downgrade accepted: an envelope without sealVersion is treated as V2", V2F, [
    { find: 'if (!Object.prototype.hasOwnProperty.call(raw, "sealVersion") || raw.sealVersion !== V2_SEAL_VERSION) return fail("UNSUPPORTED_SEAL_VERSION");', replace: "" },
    { find: "sealVersion: z.literal(V2_SEAL_VERSION),", replace: "sealVersion: z.literal(V2_SEAL_VERSION).optional()," },
  ]),
  d("P2-D14", "key-fingerprint check bypassed at verification time", V2F, [{ find: 'if (fp === null || !constantTimeEqual(fp, rec.fingerprint)) return fail("KEY_FINGERPRINT_MISMATCH");', replace: 'if (fp === null) return fail("KEY_FINGERPRINT_MISMATCH");' }]),
  d("P2-D15", "unsupported key algorithm accepted", V2F, [{ find: 'if (rec.algorithm !== "ed25519") return fail("KEY_ALGORITHM_UNSUPPORTED");', replace: "" }]),
  d("P2-D16", "digest comparison no longer constant-time", V2F, [{ find: "return timingSafeEqual(ha, hb);", replace: "return ha.equals(hb);" }]),
  d("P2-D17", "unknown envelope fields tolerated (a smuggled algorithm / key field is silently dropped)", V2F, [{ find: "const envelopeSchema = z.strictObject({", replace: "const envelopeSchema = z.object({" }]),
  d("P2-D18", "unknown document fields tolerated", V2F, [{ find: "export const mandateDocumentV2Schema = z\n  .strictObject({", replace: "export const mandateDocumentV2Schema = z\n  .object({" }]),
  d("P2-D19", "a non-null carryOver accepted", V2F, [{ find: "carryOver: z.null(),", replace: "carryOver: z.unknown()," }]),
  d("P2-D20", "the verifier propagates exceptions instead of failing closed", V2F, [{ find: '  } catch {\n    return fail("VERIFIER_ERROR");\n  }', replace: "  } catch (e) {\n    throw e;\n  }" }]),
  d("P2-D21", "registry construction no longer validates the fingerprint", KREG, [{ find: 'if (fp !== rec.fingerprint) throw new KeyRegistryError("FINGERPRINT_MISMATCH");', replace: "" }]),
  d("P2-D22", "registry accepts any algorithm string", KREG, [{ find: 'algorithm: z.literal("ed25519"),', replace: "algorithm: z.string()," }]),
  d("P2-D23", "NEW live module imports the V2 verifier (a bridge toward settlement)", "src/settlement/v2-bridge.ts", [], { create: { content: SHADOW_V2_BRIDGE } }),
  d("P2-D24", "(re-expressed after P3) the SETTLEMENT ENGINE imports the V2 key registry directly, bypassing the mandate opener", "src/settlement/engine.ts", [{ find: "const SYS = \"settlement-engine\";", replace: "import { createKeyRegistry as unusedRegistry } from \"../domain/key-registry\";\nvoid unusedRegistry;\nconst SYS = \"settlement-engine\";" }]),
  d("P2-D25", "a V2 signer/sealer is exported from the verifier module (a V2 writer)", V2F, [{ find: 'export const V2_SEAL_PURPOSE = "mandate-seal";', replace: 'export const V2_SEAL_PURPOSE = "mandate-seal";\nexport function sealV2Mandate(): string {\n  return "signed";\n}' }]),
  d("P2-D27", "signature base64 malleability accepted (non-canonical spellings of the same signature bytes)", V2F, [{ find: '.refine((s) => Buffer.from(s, "base64").toString("base64") === s, "canonical base64")', replace: "" }]),
  d("P2-D26", "the registry is loaded from an environment variable", KREG, [{ find: "export const EMPTY_KEY_REGISTRY: KeyRegistry = createKeyRegistry([]);", replace: "export const EMPTY_KEY_REGISTRY: KeyRegistry = createKeyRegistry(process.env.V2_KEYS ? JSON.parse(process.env.V2_KEYS) : []);" }]),
];

// ------------------------------------------------------------------------------------------------------------------------------------ plumbing
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const suiteArg = (arg("suite") ?? "all").toUpperCase();
const idsArg = arg("ids");
const wanted = idsArg ? new Set(idsArg.split(",").filter(Boolean)) : null;
const labelArg = arg("label");
const sfx = labelArg ? "." + labelArg : "";
if (labelArg && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(labelArg)) throw new Error("--label must be lowercase letters, digits and dashes");
const ALL: Mutant[] = [...LAYER_A, ...LAYER_B, ...LAYER_C, ...LAYER_D, ...LAYER_E, ...LAYER_F, ...LAYER_G];
if (wanted && ![...wanted].every((id) => ALL.some((m) => m.id === id))) throw new Error("--ids names an unknown mutant");
const SELECTED = ALL.filter((m) => (suiteArg === "ALL" || m.suite === suiteArg) && (!wanted || wanted.has(m.id)));

const REPORTS = join("attack-lab", "reports");
// never overwrite an existing report: a run may only create files that do not exist yet; pass --label to write a new labelled set
const OUTPUT_BASES = [["A", "mutation-layer-a-p0-boundary"], ["B", "mutation-layer-b-downstream"], ["C", "mutation-layer-c-p1-readers"], ["D", "mutation-layer-d-p2-verifier"], ["E", "mutation-layer-e-p3-p4-v2"], ["F", "mutation-layer-f-p5-enforcement"], ["G", "mutation-layer-g-p7-governance"]] as const;
{
  const clash = OUTPUT_BASES.filter(([k]) => suiteArg === "ALL" || suiteArg === k).flatMap(([, b]) => [b + sfx + ".json", b + sfx + ".md"]).filter((o) => existsSync(join("attack-lab", "reports", o)));
  if (clash.length) throw new Error("refusing to overwrite existing report(s): " + clash.join(", ") + ". Re-run with --label <new-label> to write a new labelled set.");
}
const RUNS = join(REPORTS, "mutation-layer-runs");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])).sort();
function srcManifest(): { files: number; digest: string; lines: string[] } {
  const lines = walk("src").map((f) => `${sha(readFileSync(f))}  ${f.replace(/\\/g, "/")}`);
  return { files: lines.length, digest: sha(lines.join("\n")), lines };
}

const touched = new Map<string, string | null>(); // path -> original content (null = file did not exist)
function restoreAll(): void {
  for (const [path, original] of touched) {
    if (original === null) {
      if (existsSync(path)) unlinkSync(path);
    } else writeFileSync(path, original);
  }
}
process.on("SIGINT", () => (restoreAll(), process.exit(130)));
process.on("SIGTERM", () => (restoreAll(), process.exit(130)));

const tsx = join("node_modules", "tsx", "dist", "cli.mjs");
const vitestCli = join("node_modules", "vitest", "vitest.mjs");
const tmp = mkdtempSync(join(tmpdir(), "mutlayers-"));
mkdirSync(RUNS, { recursive: true });

interface DetectorResult {
  name: string;
  /** killed = at least one test ASSERTION failed (or the Lab reported failures); crashed = nothing could be evaluated (not counted as a kill) */
  outcome: "PASSED" | "KILLED" | "CRASHED";
  failing: string[];
  detail: string;
}
let seq = 0;
function runDetector(d: Detector, label: string): DetectorResult {
  seq++;
  if (d.kind === "lab") {
    const lab = `ml-${label}-${seq}`;
    const r = spawnSync(process.execPath, [tsx, "--env-file=.env.local", "attack-lab/run.ts", "--runs", "1", "--only", d.cases!, "--no-probes", "--label", lab], { encoding: "utf8", timeout: 280_000 });
    const reportJson = join(REPORTS, `${lab}.json`);
    if (r.status !== 0 || !existsSync(reportJson)) return { name: d.name, outcome: "CRASHED", failing: [], detail: `exit ${r.status}: ${(r.stderr || r.stdout).slice(-200)}` };
    const rep = JSON.parse(readFileSync(reportJson, "utf8")) as { failures: { caseId: string; kind: string }[]; meta: { runsExecuted: number } };
    for (const ext of ["json", "md"]) if (existsSync(join(REPORTS, `${lab}.${ext}`))) writeFileSync(join(RUNS, `${lab}.${ext}`), readFileSync(join(REPORTS, `${lab}.${ext}`))), unlinkSync(join(REPORTS, `${lab}.${ext}`));
    if (rep.meta.runsExecuted === 0) return { name: d.name, outcome: "CRASHED", failing: [], detail: "no Lab run executed" };
    const ids = [...new Set(rep.failures.map((f) => f.caseId))].sort();
    return { name: d.name, outcome: ids.length ? "KILLED" : "PASSED", failing: ids, detail: `${rep.meta.runsExecuted} Lab runs` };
  }
  const out = join(tmp, `v-${seq}.json`);
  const base = d.kind === "db" ? ["--env-file=.env.local", vitestCli, "run", "-c", "vitest.db.config.mts"] : [vitestCli, "run"];
  const r = spawnSync(process.execPath, [...base, ...d.files!, "--reporter=json", `--outputFile=${out}`], { encoding: "utf8", timeout: 280_000 });
  if (!existsSync(out)) return { name: d.name, outcome: "CRASHED", failing: [], detail: `no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-200)}` };
  const j = JSON.parse(readFileSync(out, "utf8")) as { numFailedTests: number; numTotalTests: number; numFailedTestSuites: number; testResults: { assertionResults: { fullName: string; status: string }[] }[] };
  const failing = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName)).slice(0, 8);
  if (j.numFailedTests > 0) return { name: d.name, outcome: "KILLED", failing, detail: `${j.numFailedTests}/${j.numTotalTests} tests failed` };
  if (j.numFailedTestSuites > 0 || r.status !== 0) return { name: d.name, outcome: "CRASHED", failing: [], detail: `suite-level failure without a failing assertion (exit ${r.status}); not counted as a kill` };
  return { name: d.name, outcome: "PASSED", failing: [], detail: `${j.numTotalTests} tests passed` };
}

// controls are run once per detector (unmutated code) and reused
const controls = new Map<string, DetectorResult>();
const controlKey = (d: Detector) => `${d.kind}|${(d.files ?? []).join(",")}|${d.cases ?? ""}`;
function control(d: Detector): DetectorResult {
  const k = controlKey(d);
  if (!controls.has(k)) controls.set(k, runDetector(d, "control"));
  return controls.get(k)!;
}

interface Row {
  id: string;
  suite: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  defence: string;
  historical?: string;
  file: string;
  mutation: string;
  verdict: "KILLED" | "SURVIVED" | "INVALID" | "UNREACHED" | "NOT EVALUATED";
  killedBy: string[];
  detectors: { name: string; control: string; mutant: string; failing: string[]; detail: string }[];
  note: string;
}

// --check: validate that every selected mutant's search strings occur exactly once (and that created files do not exist), run nothing, change nothing
if (argv.includes("--check")) {
  let bad = 0;
  for (const m of SELECTED) {
    if (m.create) {
      if (existsSync(m.file)) (bad++, console.log(`${m.id}: file to create already exists: ${m.file}`));
      continue;
    }
    const text = readFileSync(m.file, "utf8");
    for (const e of m.edits) {
      const n = text.split(e.find).length - 1;
      if (n !== 1) (bad++, console.log(`${m.id}: search string found ${n} times in ${m.file}: ${JSON.stringify(e.find).slice(0, 90)}`));
    }
  }
  console.log(`checked ${SELECTED.length} mutants: ${bad === 0 ? "all valid" : `${bad} problem(s)`}`);
  process.exit(bad === 0 ? 0 : 1);
}

const before = srcManifest();
const rows: Row[] = [];
for (const m of SELECTED) {
  const mutation = m.create ? `create ${m.file}` : m.edits.map((e) => `${JSON.stringify(e.find).slice(0, 110)} -> ${JSON.stringify(e.replace).slice(0, 110)}`).join(" ;; ");
  const base = { id: m.id, suite: m.suite, defence: m.defence, historical: m.historical, file: m.file, mutation };
  let original: string | null = null;
  if (m.create) {
    if (existsSync(m.file)) {
      rows.push({ ...base, verdict: "INVALID", killedBy: [], detectors: [], note: "the file to create already exists" });
      continue;
    }
  } else {
    original = readFileSync(m.file, "utf8");
    const bad = m.edits.find((e) => original!.split(e.find).length - 1 !== 1);
    if (bad) {
      rows.push({ ...base, verdict: "INVALID", killedBy: [], detectors: [], note: `INVALID MUTANT: a search string was found ${original.split(bad.find).length - 1} times (need exactly 1); nothing was mutated` });
      continue;
    }
  }
  // 1. controls on unmutated code (REACH for Layer B lives inside the control: its tests assert the defence is reached)
  const ctl = m.detectors.map((d) => ({ d, c: control(d) }));
  const decidingCtl = m.deciding ? ctl.find((x) => x.d.name === m.deciding)!.c : null;
  if (decidingCtl && decidingCtl.outcome !== "PASSED") {
    rows.push({ ...base, verdict: "UNREACHED", killedBy: [], detectors: ctl.map((x) => ({ name: x.d.name, control: x.c.outcome, mutant: "not run", failing: x.c.failing, detail: x.c.detail })), note: "the isolated harness did not reach the defence on unmutated code (its control failed); not counted as killed" });
    continue;
  }
  const badCtl = ctl.filter((x) => x.c.outcome !== "PASSED" && x.d.name !== m.deciding && m.suite === "A");
  if (badCtl.length) {
    rows.push({ ...base, verdict: "NOT EVALUATED", killedBy: [], detectors: ctl.map((x) => ({ name: x.d.name, control: x.c.outcome, mutant: "not run", failing: x.c.failing, detail: x.c.detail })), note: "a control run on unmutated code did not pass" });
    continue;
  }
  // 2. apply, run every detector, restore
  const results: { d: Detector; c: DetectorResult; r: DetectorResult }[] = [];
  try {
    touched.set(m.file, original);
    if (m.create) writeFileSync(m.file, m.create.content);
    else {
      let text = original!;
      for (const e of m.edits) text = text.replace(e.find, () => e.replace);
      writeFileSync(m.file, text);
    }
    let killedAlready = false;
    for (const x of ctl) {
      if (m.stopAtFirstKill && killedAlready) {
        results.push({ d: x.d, c: x.c, r: { name: x.d.name, outcome: "PASSED", failing: [], detail: "not run (an earlier detector already killed this mutant)" } });
        continue;
      }
      const r: DetectorResult = x.c.outcome === "PASSED" ? runDetector(x.d, m.id) : { name: x.d.name, outcome: "CRASHED", failing: [], detail: "control did not pass; not run" };
      if (r.outcome === "KILLED") killedAlready = true;
      results.push({ d: x.d, c: x.c, r });
    }
  } finally {
    restoreAll();
    touched.clear();
    if (m.create ? existsSync(m.file) : sha(readFileSync(m.file, "utf8")) !== sha(original!)) throw new Error(`FAILED TO RESTORE ${m.file}`);
  }
  const killers = results.filter((x) => x.r.outcome === "KILLED");
  const deciding = m.deciding ? results.find((x) => x.d.name === m.deciding)! : null;
  const verdict: Row["verdict"] = deciding ? (deciding.r.outcome === "KILLED" ? "KILLED" : "SURVIVED") : killers.length ? "KILLED" : "SURVIVED";
  rows.push({
    ...base,
    verdict,
    killedBy: killers.map((x) => x.d.name),
    detectors: results.map((x) => ({ name: x.d.name, control: x.c.outcome, mutant: x.r.outcome, failing: x.r.failing, detail: x.r.detail })),
    note: m.suite === "B" ? `verdict decided by "${m.deciding}" (its control passed, i.e. the defence was reached)` : "verdict: killed if any Layer A detector failed an assertion",
  });
  console.log(`${m.id.padEnd(7)} ${verdict.padEnd(10)} killedBy=[${killers.map((x) => x.d.name).join("; ")}]`);
}

const after = srcManifest();
const restored = before.digest === after.digest && before.files === after.files;
rmSync(tmp, { recursive: true, force: true });
if (!restored) {
  console.error("SRC TREE DIFFERS AFTER THE RUN");
  const b = new Set(before.lines);
  for (const l of after.lines) if (!b.has(l)) console.error("  changed/new:", l);
}

// ---------------------------------------------------------------------------------------------------------------------------- reports (never the historical files)
const count = (rs: Row[]) => ({ defined: rs.length, killed: rs.filter((r) => r.verdict === "KILLED").length, survived: rs.filter((r) => r.verdict === "SURVIVED").length, invalid: rs.filter((r) => r.verdict === "INVALID").length, unreached: rs.filter((r) => r.verdict === "UNREACHED").length, notEvaluated: rs.filter((r) => r.verdict === "NOT EVALUATED").length });
const stamp = new Date().toISOString();
for (const [suite, file0, title] of [["A", "mutation-layer-a-p0-boundary", "Layer A - P0 security boundary"], ["B", "mutation-layer-b-downstream", "Layer B - dormant downstream AI defences (isolated test-only harness)"], ["C", "mutation-layer-c-p1-readers", "Layer C - P1 forward-compatibility reader guards"], ["D", "mutation-layer-d-p2-verifier", "Layer D - P2 V2 seal verifier and key registry"], ["E", "mutation-layer-e-p3-p4-v2", "Layer E - P3/P4 V2 terms, attestation, approval, restricted model input, language assessment, evidence scoping, intake binding"], ["F", "mutation-layer-f-p5-enforcement", "Layer F - P5 authorization re-derivation, settlement gates, reservation cleanup, HTTP hardening"], ["G", "mutation-layer-g-p7-governance", "Layer G - P7 detector registry, governance workflow, evaluation core, detector identity"]] as const) {
  const file = file0 + sfx;
  const rs = rows.filter((r) => r.suite === suite);
  if (!rs.length) continue;
  const c = count(rs);
  const json = { generatedAt: stamp, suite: title, counts: c, srcRestoredByteForByte: restored, srcDigestBefore: before.digest, srcDigestAfter: after.digest, srcFiles: before.files, rows: rs };
  writeFileSync(join(REPORTS, `${file}.json`), JSON.stringify(json, null, 2) + "\n");
  const md = [
    `# ${title}`,
    "",
    `Generated ${stamp}. Scored separately from every other suite; denominators are NOT combined with the historical 29-mutant Lab suite. No real LLM, no PayPal call; mock PayPal, scripted providers, database mandate_test.`,
    "",
    `**Defined ${c.defined}, killed ${c.killed}, survived ${c.survived}, invalid ${c.invalid}, unreached ${c.unreached}, not evaluated ${c.notEvaluated}.**  src/ restored byte-for-byte: ${restored ? "YES" : "NO"} (${before.files} files, digest ${before.digest}).`,
    "",
    "| Mutant | Defence weakened | Verdict | Detectors (control -> mutant) |",
    "|---|---|---|---|",
    ...rs.map((r) => `| ${r.id}${r.historical ? ` (hist. ${r.historical})` : ""} | ${r.defence} | **${r.verdict}** | ${r.detectors.map((d) => `${d.name}: ${d.control} -> ${d.mutant}${d.failing.length ? ` [${d.failing.slice(0, 3).join("; ").slice(0, 160)}]` : ""}`).join("<br>") || r.note} |`),
    "",
  ];
  writeFileSync(join(REPORTS, `${file}.md`), md.join("\n"));
}
console.log(`\nsuite A: ${JSON.stringify(count(rows.filter((r) => r.suite === "A")))}\nsuite B: ${JSON.stringify(count(rows.filter((r) => r.suite === "B")))}\nsuite C: ${JSON.stringify(count(rows.filter((r) => r.suite === "C")))}\nsuite D: ${JSON.stringify(count(rows.filter((r) => r.suite === "D")))}\nsrc restored byte-for-byte: ${restored} (${before.files} files) digest before ${before.digest} after ${after.digest}`);
if (!restored) process.exit(2);

// ---------------------------------------------------------------------------------------------------------------------------- combined PRESENTATION (not a combined score)
type Stored = { counts: ReturnType<typeof count>; rows: Row[]; generatedAt: string; srcRestoredByteForByte: boolean };
const readJson = (f: string): Stored | null => (existsSync(join(REPORTS, f)) ? (JSON.parse(readFileSync(join(REPORTS, f), "utf8")) as Stored) : null);
const a = readJson(`mutation-layer-a-p0-boundary${sfx}.json`);
const b = readJson(`mutation-layer-b-downstream${sfx}.json`);
const cc = readJson(`mutation-layer-c-p1-readers${sfx}.json`);
const dd = readJson(`mutation-layer-d-p2-verifier${sfx}.json`);
const hist = (f: string) => {
  const j = JSON.parse(readFileSync(join(REPORTS, f), "utf8")) as { generatedAt: string; rows: { result: string }[] };
  const t: Record<string, number> = {};
  for (const r of j.rows) t[r.result.split(" (")[0]!.split(":")[0]!] = (t[r.result.split(" (")[0]!.split(":")[0]!] ?? 0) + 1;
  return `${j.rows.length} defined, ${JSON.stringify(t)} (generated ${j.generatedAt})`;
};
const summaryName = `mutation-baseline${labelArg ? `-${labelArg}` : "-p0-repair"}.md`;
if (a && b && !existsSync(join(REPORTS, summaryName))) {
  const line = (n: string, x: Stored) => `| ${n} | ${x.counts.defined} | ${x.counts.killed} | ${x.counts.survived} | ${x.counts.invalid} | ${x.counts.unreached} | ${x.counts.notEvaluated} | ${x.generatedAt} |`;
  const suites = [a, b, ...(cc ? [cc] : []), ...(dd ? [dd] : [])];
  const md = [
    `# Mutation baseline${labelArg ? ` (${labelArg})` : " after P0 (repair task)"} - separate suites, no combined score`,
    "",
    "The suites measure different things. Their denominators are NOT added and their rates are NOT compared as if the architecture were unchanged.",
    "",
    "| Suite | Defined | Killed | Survived | Invalid | Unreached | Not evaluated | Generated |",
    "|---|---|---|---|---|---|---|---|",
    line("**Layer A - P0 security boundary**", a),
    line("**Layer B - dormant downstream AI defences (isolated harness)**", b),
    ...(cc ? [line("**Layer C - P1 forward-compatibility reader guards**", cc)] : []),
    ...(dd ? [line("**Layer D - P2 V2 seal verifier and key registry**", dd)] : []),
    "",
    "Historical reference only (earlier architectures; different mutants, different reach; kept unchanged):",
    "",
    `* Historical combined Lab suite (reports/mutation.json): ${hist("mutation.json")}`,
    `* Post-P0 run of that same historical suite (reports/mutation-post-p0.json): ${hist("mutation-post-p0.json")}`,
    ...(labelArg ? ["* Layer A / Layer B as first established after P0: reports/mutation-layer-a-p0-boundary.json (17/17), reports/mutation-layer-b-downstream.json (7/7), unchanged"] : []),
    "",
    `Layer A surviving mutants (each is a finding): ${a.rows.filter((r) => r.verdict === "SURVIVED").map((r) => r.id).join(", ") || "none"}`,
    `Layer B surviving / unreached / invalid mutants: ${b.rows.filter((r) => r.verdict !== "KILLED").map((r) => `${r.id}=${r.verdict}`).join(", ") || "none"}`,
    ...(cc ? [`Layer C surviving / unreached / invalid mutants: ${cc.rows.filter((r) => r.verdict !== "KILLED").map((r) => `${r.id}=${r.verdict}`).join(", ") || "none"}`] : []),
    ...(dd ? [`Layer D surviving / unreached / invalid mutants: ${dd.rows.filter((r) => r.verdict !== "KILLED").map((r) => `${r.id}=${r.verdict}`).join(", ") || "none"}`] : []),
    `src/ restored byte-for-byte after the runs: ${suites.every((x) => x.srcRestoredByteForByte) ? "YES" : "NO"}`,
    "",
    `Details: mutation-layer-a-p0-boundary${sfx}.md, mutation-layer-b-downstream${sfx}.md${cc ? `, mutation-layer-c-p1-readers${sfx}.md` : ""}${dd ? `, mutation-layer-d-p2-verifier${sfx}.md` : ""}.`,
    "",
  ];
  writeFileSync(join(REPORTS, summaryName), md.join("\n"));
}
