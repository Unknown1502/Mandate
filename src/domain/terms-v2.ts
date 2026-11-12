/**
 * V2 locked terms (P3; docs/15 sections 15.3.1, 15.3.2, 15.7, 15.8). PURE: no I/O.
 *
 * What V2 adds over V1: every model-readable thing is declared and hash-locked. `artifactSchema` is the closed list of artifact fields with a classification
 * (CRITERION_INPUT for named criteria, or OPAQUE: never model-readable), each LLM-judged criterion names its `inputFields` and `inputMaxRows`, and `languagePolicy`
 * (at least as strict as the signed mandate floor) is part of the hashed terms. Nothing that influences model exposure or language handling is outside the hash.
 *
 * STRICT everywhere: an unknown key is an error, never dropped. A criterion with deterministic type cannot carry inputFields. Unclassified is not a declarable value:
 * a field absent from artifactSchema is "UNCLASSIFIED" at runtime and fails closed.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { languagePolicyV1Schema, MANDATE_ID_PATTERN } from "./mandate-v2";
import { TASK_TYPES } from "./mandate";
import { CURRENCY, parsePositiveMoney } from "./money";
import { criterionBase, DATA_CLEANING_VALIDATORS, paramValue, readTerms, termsHash, type TermsV1 } from "./terms";
import type { LanguagePolicy } from "./language-policy";

export const TERMS_V2_VERSION = 2 as const;
/** absolute upper bound of distinct model "groups" per deal (docs/15 Q5 recommendation); the DEFAULT effective cap is 1 until the owner decides Q5 */
export const MAX_MODEL_GROUPS_ABSOLUTE = 5;
export const DEFAULT_MODEL_GROUP_CAP = 1;
export const MODEL_ROWS_MAX = 15;
/** field ids that always exist and may never be model-readable in this release (strictest reading of docs/15 15.7) */
export const RESERVED_OPAQUE_FIELDS = ["csv:header", "manifest:artifactReference", "manifest:mediaType", "manifest:metadata"] as const;

// -------------------------------------------------------------------------------------------------------------------------------- schemas
const FIELD_ID = /^(csv:header|manifest:(artifactReference|mediaType|metadata)|col:[^\u0000-\u001f\u007f]{1,200})$/u;
export const fieldIdSchema = z
  .string()
  .max(210)
  .regex(FIELD_ID)
  .refine((s) => s.normalize("NFC") === s, "field ids are NFC and never normalised");
const criterionId = criterionBase.id;

export const artifactFieldSchema = z.discriminatedUnion("classification", [
  z.strictObject({ id: fieldIdSchema, classification: z.literal("CRITERION_INPUT"), criteria: z.array(criterionId).min(1).max(20) }),
  z.strictObject({ id: fieldIdSchema, classification: z.literal("OPAQUE") }),
]);
export type ArtifactField = z.infer<typeof artifactFieldSchema>;

export const artifactSchemaSchema = z.strictObject({ format: z.literal("csv"), fields: z.array(artifactFieldSchema).min(1).max(200) });
export type ArtifactSchema = z.infer<typeof artifactSchemaSchema>;

export const criterionV2Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...criterionBase, type: z.literal("deterministic"), validator: z.enum(DATA_CLEANING_VALIDATORS), params: z.record(z.string(), paramValue) }),
  z.strictObject({
    ...criterionBase,
    type: z.literal("llm_judged"),
    inputFields: z.array(fieldIdSchema).min(1).max(50),
    inputMaxRows: z.number().int().min(1).max(MODEL_ROWS_MAX),
  }),
]);
export type CriterionV2 = z.infer<typeof criterionV2Schema>;

export const termsV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  taskType: z.enum(TASK_TYPES),
  description: z.string().min(1).max(2000),
  criteria: z.array(criterionV2Schema).min(1).max(20),
  price: z.string().refine((s) => {
    try {
      parsePositiveMoney(s);
      return true;
    } catch {
      return false;
    }
  }),
  currency: z.literal(CURRENCY),
  deadline: z.iso.datetime(),
  sellerId: z.string().min(1).max(64),
  mandateId: z.string().regex(MANDATE_ID_PATTERN),
  artifactSchema: artifactSchemaSchema.optional(),
  languagePolicy: languagePolicyV1Schema.optional(),
});
export type TermsV2 = z.infer<typeof termsV2Schema>;

// -------------------------------------------------------------------------------------------------------------------------------- normalisation, hashes
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical form: criteria, fields and every id list sorted, so ordering can never change a hash. Duplicates are NOT removed (they are rejected by validateTermsV2). */
export function normalizeTermsV2(t: TermsV2): TermsV2 {
  const out: TermsV2 = {
    ...t,
    deadline: new Date(t.deadline).toISOString(),
    criteria: [...t.criteria]
      .map((c): CriterionV2 => (c.type === "llm_judged" ? { ...c, inputFields: [...c.inputFields].sort(asc) } : c))
      .sort((a, b) => asc(a.id, b.id)),
  };
  if (t.artifactSchema)
    out.artifactSchema = {
      format: t.artifactSchema.format,
      fields: [...t.artifactSchema.fields]
        .map((f): ArtifactField => (f.classification === "CRITERION_INPUT" ? { ...f, criteria: [...f.criteria].sort(asc) } : f))
        .sort((a, b) => asc(a.id, b.id)),
    };
  return out;
}
export const termsHashV2 = (t: TermsV2): string => sha256Hex(canonicalJson(normalizeTermsV2(t)));

/** The criterion-to-field mapping, stated explicitly (docs/15 15.5.4). Redundant with termsHash by design: the attestation names the mapping it covered. */
export function mappingHashV2(t: TermsV2): string {
  const n = normalizeTermsV2(t);
  return sha256Hex(
    canonicalJson({
      artifactSchema: n.artifactSchema ?? null,
      criteria: n.criteria.map((c) => ({ id: c.id, type: c.type, inputFields: c.type === "llm_judged" ? c.inputFields : null, inputMaxRows: c.type === "llm_judged" ? c.inputMaxRows : null })),
    }),
  );
}

export const hasLlmCriteria = (t: Pick<TermsV2, "criteria">): boolean => t.criteria.some((c) => c.type === "llm_judged");
export const languagePolicyHashOf = (t: TermsV2): string | null => (t.languagePolicy ? sha256Hex(canonicalJson(t.languagePolicy)) : null);

export interface ModelGroup {
  key: string;
  criterionIds: string[];
  inputFields: string[];
  inputMaxRows: number;
}
/** Criteria with an IDENTICAL (sorted inputFields, inputMaxRows) share one call set; a group's view is exactly that. Deterministic order. */
export function modelGroups(t: TermsV2): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const c of normalizeTermsV2(t).criteria) {
    if (c.type !== "llm_judged") continue;
    const key = sha256Hex(canonicalJson({ f: c.inputFields, r: c.inputMaxRows }));
    const g = groups.get(key);
    if (g) g.criterionIds.push(c.id);
    else groups.set(key, { key, criterionIds: [c.id], inputFields: c.inputFields, inputMaxRows: c.inputMaxRows });
  }
  return [...groups.values()].sort((a, b) => asc(a.key, b.key));
}

// -------------------------------------------------------------------------------------------------------------------------------- semantic validation
export const TERMS_V2_ISSUES = [
  "ARTIFACT_SCHEMA_REQUIRED",
  "LANGUAGE_POLICY_REQUIRED",
  "MODEL_CONFIG_NOT_ALLOWED",
  "FIELD_DUPLICATE",
  "CRITERION_DUPLICATE",
  "CRITERION_UNKNOWN",
  "FIELD_UNKNOWN_IN_CRITERION",
  "CLASSIFICATION_CONFLICT",
  "RESERVED_FIELD_MISSING",
  "RESERVED_FIELD_NOT_OPAQUE",
  "MODEL_GROUP_CAP_EXCEEDED",
  "LANGUAGE_SCOPE_MISMATCH",
] as const;
export type TermsV2Issue = (typeof TERMS_V2_ISSUES)[number];

/** Pure semantic validation of PARSED V2 terms. [] means valid. Operates on the raw (non-normalised) value so duplicates are visible. */
export function validateTermsV2(t: TermsV2, opts: { modelGroupCap?: number } = {}): TermsV2Issue[] {
  const issues = new Set<TermsV2Issue>();
  const llm = t.criteria.filter((c): c is Extract<CriterionV2, { type: "llm_judged" }> => c.type === "llm_judged");
  const cap = Math.min(opts.modelGroupCap ?? DEFAULT_MODEL_GROUP_CAP, MAX_MODEL_GROUPS_ABSOLUTE);

  if (new Set(t.criteria.map((c) => c.id)).size !== t.criteria.length) issues.add("CRITERION_DUPLICATE");

  if (llm.length === 0) {
    // deterministic-only: no model configuration may ride along (it could never enable a model, and carrying it would only create ambiguity)
    if (t.artifactSchema || t.languagePolicy) issues.add("MODEL_CONFIG_NOT_ALLOWED");
    return [...issues];
  }
  if (!t.artifactSchema) issues.add("ARTIFACT_SCHEMA_REQUIRED");
  if (!t.languagePolicy) issues.add("LANGUAGE_POLICY_REQUIRED");
  if (!t.artifactSchema) return [...issues];

  const fields = t.artifactSchema.fields;
  const byId = new Map<string, ArtifactField>();
  for (const f of fields) {
    if (byId.has(f.id)) issues.add("FIELD_DUPLICATE");
    byId.set(f.id, f);
  }
  for (const r of RESERVED_OPAQUE_FIELDS) {
    const f = byId.get(r);
    if (!f) issues.add("RESERVED_FIELD_MISSING");
    else if (f.classification !== "OPAQUE") issues.add("RESERVED_FIELD_NOT_OPAQUE");
  }

  const llmById = new Map(llm.map((c) => [c.id, c] as const));
  // field -> criteria direction
  for (const f of fields) {
    if (f.classification !== "CRITERION_INPUT") continue;
    if (new Set(f.criteria).size !== f.criteria.length) issues.add("CLASSIFICATION_CONFLICT");
    for (const cid of f.criteria) {
      const c = llmById.get(cid);
      if (!c) issues.add("CRITERION_UNKNOWN");
      else if (!c.inputFields.includes(f.id)) issues.add("CLASSIFICATION_CONFLICT");
    }
  }
  // criterion -> field direction
  for (const c of llm) {
    if (new Set(c.inputFields).size !== c.inputFields.length) issues.add("CLASSIFICATION_CONFLICT");
    for (const fid of c.inputFields) {
      const f = byId.get(fid);
      if (!f) issues.add("FIELD_UNKNOWN_IN_CRITERION");
      else if (f.classification !== "CRITERION_INPUT") issues.add("CLASSIFICATION_CONFLICT");
      else if (!f.criteria.includes(c.id)) issues.add("CLASSIFICATION_CONFLICT");
    }
  }

  if (modelGroups(t).length > cap) issues.add("MODEL_GROUP_CAP_EXCEEDED");

  if (t.languagePolicy) {
    const scope = t.languagePolicy.criterionScope.map((s) => s.criterionId);
    const want = llm.map((c) => c.id).sort(asc);
    if (scope.length !== want.length || scope.some((s, i) => s !== want[i])) issues.add("LANGUAGE_SCOPE_MISMATCH");
  }
  return [...issues];
}

// -------------------------------------------------------------------------------------------------------------------------------- dispatching reader
export type TermsAnyCode = "TERMS_NOT_OBJECT" | "TERMS_VERSION_UNSUPPORTED" | "CRITERION_VERSION_UNSUPPORTED" | "TERMS_INVALID";
export type TermsAny =
  | { ok: true; version: 1; terms: TermsV1 }
  | { ok: true; version: 2; terms: TermsV2; issues: TermsV2Issue[] }
  | { ok: false; code: TermsAnyCode };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * THE version-dispatching reader (P3). No schemaVersion -> the V1 reader (unchanged, strict). schemaVersion === 2 -> the strict V2 schema; any other value, or a
 * V2-looking object that fails the schema, is refused. V2 terms with semantic issues are returned with `issues` (callers must treat a non-empty list as invalid;
 * `readTermsV2Valid` does that in one call).
 */
export function readAnyTerms(raw: unknown, opts: { modelGroupCap?: number } = {}): TermsAny {
  if (!isObj(raw)) return { ok: false, code: "TERMS_NOT_OBJECT" };
  if (!Object.prototype.hasOwnProperty.call(raw, "schemaVersion")) {
    const r = readTerms(raw);
    return r.ok ? { ok: true, version: 1, terms: r.terms } : { ok: false, code: r.code };
  }
  if (raw.schemaVersion !== 2) return { ok: false, code: "TERMS_VERSION_UNSUPPORTED" };
  const parsed = termsV2Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "TERMS_INVALID" };
  return { ok: true, version: 2, terms: parsed.data, issues: validateTermsV2(parsed.data, opts) };
}

/** V2 terms that are structurally AND semantically valid, or null. */
export function readTermsV2Valid(raw: unknown, opts: { modelGroupCap?: number } = {}): TermsV2 | null {
  const r = readAnyTerms(raw, opts);
  return r.ok && r.version === 2 && r.issues.length === 0 ? r.terms : null;
}

/** version-aware hash of already-parsed terms */
export const hashAny = (r: Extract<TermsAny, { ok: true }>): string => (r.version === 1 ? termsHash(r.terms) : termsHashV2(r.terms));

/** True only if the stored terms are supported (V1, or valid V2) AND still hash to the locked hash. */
export function termsMatchLockAny(storedTermsJson: unknown, lockedHash: string): boolean {
  const r = readAnyTerms(storedTermsJson, { modelGroupCap: MAX_MODEL_GROUPS_ABSOLUTE });
  if (!r.ok) return false;
  if (r.version === 2 && r.issues.length > 0) return false;
  return hashAny(r) === lockedHash;
}

export type { LanguagePolicy };

// -------------------------------------------------------------------------------------------------------------------------------- locked-terms readers for the settlement layers
export type LockedTerms = { ok: true; version: 1; terms: TermsV1 } | { ok: true; version: 2; terms: TermsV2 } | { ok: false; code: TermsAnyCode };

/** Stored locked terms, V1 or fully valid V2 (a V2 value with semantic issues is refused as TERMS_INVALID). Never casts. */
export function readLockedTerms(raw: unknown): LockedTerms {
  const r = readAnyTerms(raw, { modelGroupCap: MAX_MODEL_GROUPS_ABSOLUTE });
  if (!r.ok) return r;
  if (r.version === 2) return r.issues.length > 0 ? { ok: false, code: "TERMS_INVALID" } : { ok: true, version: 2, terms: r.terms };
  return { ok: true, version: 1, terms: r.terms };
}

export class LockedTermsError extends Error {
  constructor(readonly code: TermsAnyCode) {
    super(code);
    this.name = "LockedTermsError";
  }
}
export function readLockedTermsOrThrow(raw: unknown): TermsV1 | TermsV2 {
  const r = readLockedTerms(raw);
  if (!r.ok) throw new LockedTermsError(r.code);
  return r.terms;
}
