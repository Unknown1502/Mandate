import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { CURRENCY, parsePositiveMoney } from "./money";
import { TASK_TYPES } from "./mandate";

export const DATA_CLEANING_VALIDATORS = [
  "csv_schema_matches",
  "row_count_range",
  "no_duplicate_rows",
  "null_rate_below",
  "no_forbidden_values",
  "column_values_in_set",
  // Gate 4 additions (src/verification/validators.ts implements all of them)
  "required_columns_present",
  "column_order_matches",
  "unique_column_values",
  "date_format_valid",
  "column_type_valid",
  "source_records_preserved",
] as const;

export const criterionBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  text: z.string().min(1).max(300),
  required: z.boolean(),
  weight: z.number().int().min(1).max(100),
};

/** Params are restricted to JSON-safe integers/strings/booleans/arrays: canonical hashing must not be able to throw later. */
export const paramValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(200), z.number().int().min(-1_000_000_000).max(1_000_000_000), z.boolean(), z.array(paramValue).max(200)]),
);

/**
 * STRICT (P1): an unknown key is an error, never silently dropped. A criterion field this code does not know is authorization-bearing by assumption
 * (for example a future per-criterion input list); stripping it would change what the principal approved while the hash still "matched".
 */
export const criterionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...criterionBase,
    type: z.literal("deterministic"),
    validator: z.enum(DATA_CLEANING_VALIDATORS),
    params: z.record(z.string(), paramValue),
  }),
  z.strictObject({ ...criterionBase, type: z.literal("llm_judged") }),
]);
export type Criterion = z.infer<typeof criterionSchema>;

/** The V1 terms shape. STRICT. This is the WRITER schema (lockTerms, the negotiation draft); every READER goes through readTerms() below. */
export const termsSchema = z.strictObject({
  taskType: z.enum(TASK_TYPES),
  description: z.string().min(1).max(2000),
  criteria: z.array(criterionSchema).min(1).max(20),
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
  mandateId: z.string().min(1),
});
export type TermsV1 = z.infer<typeof termsSchema>;

export type CriteriaIssue = "WEIGHTS_NOT_100" | "NO_REQUIRED_CRITERION" | "DUPLICATE_CRITERION_ID";

/** Structural criteria checks from docs/04 §4.3 item 6. Returns [] when valid. */
export function criteriaIssues(criteria: ReadonlyArray<Pick<Criterion, "id" | "weight" | "required">>): CriteriaIssue[] {
  const issues: CriteriaIssue[] = [];
  if (criteria.reduce((s, c) => s + c.weight, 0) !== 100) issues.push("WEIGHTS_NOT_100");
  if (!criteria.some((c) => c.required)) issues.push("NO_REQUIRED_CRITERION");
  if (new Set(criteria.map((c) => c.id)).size !== criteria.length) issues.push("DUPLICATE_CRITERION_ID");
  return issues;
}

/** Canonical form: criteria sorted by id so ordering cannot change the hash. */
export function normalizeTerms(t: TermsV1): TermsV1 {
  return { ...t, deadline: new Date(t.deadline).toISOString(), criteria: [...t.criteria].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

export const termsHash = (t: TermsV1): string => sha256Hex(canonicalJson(normalizeTerms(t)));

/** Closed set of reasons a stored terms object is refused (P1). */
export type TermsReadCode = "TERMS_NOT_OBJECT" | "TERMS_VERSION_UNSUPPORTED" | "CRITERION_VERSION_UNSUPPORTED" | "TERMS_INVALID";
export type TermsRead = { ok: true; version: 1; terms: TermsV1 } | { ok: false; code: TermsReadCode };

export class TermsReadError extends Error {
  constructor(readonly code: TermsReadCode) {
    super(code);
    this.name = "TermsReadError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * THE reader for stored / received terms (P1 version dispatch). Supported: V1, which is the shape with NO version field and EXACTLY the keys of termsSchema.
 *  - an explicit `schemaVersion` (on the terms or on any criterion) is a version this code does not support -> refused, never read as V1 and never stripped;
 *  - any other unknown key, a missing key, a wrong type or a malformed criterion -> TERMS_INVALID. A few new properties never make a document "V2".
 * Nothing is cast: the returned terms are the output of the strict schema.
 */
export function readTerms(raw: unknown): TermsRead {
  if (!isPlainObject(raw)) return { ok: false, code: "TERMS_NOT_OBJECT" };
  if (has(raw, "schemaVersion")) return { ok: false, code: "TERMS_VERSION_UNSUPPORTED" };
  if (Array.isArray(raw.criteria) && raw.criteria.some((c) => isPlainObject(c) && has(c, "schemaVersion"))) return { ok: false, code: "CRITERION_VERSION_UNSUPPORTED" };
  const parsed = termsSchema.safeParse(raw);
  return parsed.success ? { ok: true, version: 1, terms: parsed.data } : { ok: false, code: "TERMS_INVALID" };
}

/** For call sites that already require valid, hash-locked terms: throws a typed error instead of returning a result. */
export function readTermsOrThrow(raw: unknown): TermsV1 {
  const r = readTerms(raw);
  if (!r.ok) throw new TermsReadError(r.code);
  return r.terms;
}

/** True only if the stored terms are supported V1 terms that still hash to the locked hash. */
export function termsMatchLock(storedTermsJson: unknown, lockedHash: string): boolean {
  const r = readTerms(storedTermsJson);
  return r.ok && termsHash(r.terms) === lockedHash;
}
