/**
 * Deterministic validators for `data_cleaning`. Pure functions of (parsed CSV, locked params): no I/O, no clock, no randomness, no LLM.
 * PASS / FAIL / UNVERIFIABLE only; UNVERIFIABLE means the CONTRACT's params were unusable (never "the seller did badly").
 * `actual` is built from counts, positions and contract values; it never embeds raw seller text, because these summaries are
 * later shown to the AI verifier as trusted context.
 */
import { z } from "zod";
import type { Criterion } from "../domain/terms";
import type { ParsedCsv } from "./csv";
import { ev } from "./evidence";

export type CheckStatus = "PASS" | "FAIL" | "UNVERIFIABLE";
export interface DeterministicCheck {
  criterionId: string;
  validator: string;
  status: CheckStatus;
  expected: string;
  actual: string;
  reason: string;
  evidenceRefs: string[];
}

const MAX_REFS = 20;
const cols = z.array(z.string().min(1).max(100)).min(1).max(100);
const col = z.string().min(1).max(100);
const pct = z.number().int().min(0).max(100);
const vals = z.array(z.string().max(200)).min(1).max(200);

const PARAMS = {
  csv_schema_matches: z.object({ columns: cols }).strict(),
  required_columns_present: z.object({ columns: cols }).strict(),
  column_order_matches: z.object({ columns: cols }).strict(),
  row_count_range: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).strict().refine((p) => p.min !== undefined || p.max !== undefined, "min or max required"),
  no_duplicate_rows: z.object({ columns: cols.optional() }).strict(),
  unique_column_values: z.object({ column: col, ignoreEmpty: z.boolean().optional() }).strict(),
  null_rate_below: z.object({ column: col.optional(), maxMissingPercent: pct }).strict(),
  no_forbidden_values: z.object({ column: col, values: vals }).strict(),
  column_values_in_set: z.object({ column: col, values: vals, allowEmpty: z.boolean().optional() }).strict(),
  date_format_valid: z.object({ column: col, format: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]), allowEmpty: z.boolean().optional() }).strict(),
  column_type_valid: z.object({ column: col, type: z.enum(["integer", "decimal", "boolean", "email", "string"]), allowEmpty: z.boolean().optional() }).strict(),
  source_records_preserved: z.object({ column: col, requiredValues: vals }).strict(),
} as const;
type ValidatorName = keyof typeof PARAMS;

interface Ctx {
  csv: ParsedCsv;
  sha12: string;
}
type Outcome = { status: CheckStatus; expected: string; actual: string; reason: string; evidenceRefs: string[] };
const out = (status: CheckStatus, expected: string, actual: string, reason: string, evidenceRefs: string[] = []): Outcome => ({ status, expected, actual, reason, evidenceRefs: evidenceRefs.slice(0, MAX_REFS) });
const pass = (expected: string, actual: string, refs: string[] = []) => out("PASS", expected, actual, "OK", refs);

const isMissing = (v: string) => v.trim() === "";
const colIndex = (c: Ctx, name: string) => c.csv.headers.indexOf(name);

function daysIn(m: number, y: number) {
  return m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}
export function validDate(v: string, format: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY"): boolean {
  const m = (format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{2})\/(\d{2})\/(\d{4})$/).exec(v);
  if (!m) return false;
  const [y, mo, d] = format === "YYYY-MM-DD" ? [+m[1]!, +m[2]!, +m[3]!] : format === "DD/MM/YYYY" ? [+m[3]!, +m[2]!, +m[1]!] : [+m[3]!, +m[1]!, +m[2]!];
  return y >= 1000 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(mo, y);
}
const TYPE_RE: Record<string, (v: string) => boolean> = {
  integer: (v) => /^-?\d{1,18}$/.test(v),
  decimal: (v) => /^-?\d{1,18}(\.\d{1,10})?$/.test(v),
  boolean: (v) => v === "true" || v === "false",
  email: (v) => v.length <= 254 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v),
  string: () => true,
};

const RUN: { [K in ValidatorName]: (p: z.infer<(typeof PARAMS)[K]>, c: Ctx) => Outcome } = {
  csv_schema_matches(p, c) {
    const exp = `header is exactly [${p.columns.join(", ")}] in that order`;
    const same = p.columns.length === c.csv.headers.length && p.columns.every((x, i) => x === c.csv.headers[i]);
    if (same) return pass(exp, "header matches exactly", [ev.header(c.sha12)]);
    const missing = p.columns.filter((x) => !c.csv.headers.includes(x));
    const extra = c.csv.headers.filter((h) => !p.columns.includes(h)).length;
    const firstDiff = p.columns.findIndex((x, i) => x !== c.csv.headers[i]);
    return out("FAIL", exp, `${c.csv.headers.length} columns delivered; missing from contract: [${missing.join(", ")}]; ${extra} unexpected column(s); first difference at position ${firstDiff + 1}`, "SCHEMA_MISMATCH", [ev.header(c.sha12)]);
  },
  required_columns_present(p, c) {
    const missing = p.columns.filter((x) => !c.csv.headers.includes(x));
    const exp = `columns present: [${p.columns.join(", ")}]`;
    return missing.length === 0 ? pass(exp, "all present", [ev.header(c.sha12)]) : out("FAIL", exp, `missing: [${missing.join(", ")}]`, "COLUMN_MISSING", [ev.header(c.sha12)]);
  },
  column_order_matches(p, c) {
    const exp = `columns appear in this order: [${p.columns.join(", ")}]`;
    const idx = p.columns.map((x) => c.csv.headers.indexOf(x));
    if (idx.some((i) => i < 0)) return out("FAIL", exp, `missing: [${p.columns.filter((_, i) => idx[i]! < 0).join(", ")}]`, "COLUMN_MISSING", [ev.header(c.sha12)]);
    return idx.every((v, i) => i === 0 || v > idx[i - 1]!) ? pass(exp, "order respected", [ev.header(c.sha12)]) : out("FAIL", exp, "columns present but in a different order", "ORDER_MISMATCH", [ev.header(c.sha12)]);
  },
  row_count_range(p, c) {
    const n = c.csv.rows.length;
    const exp = `data rows between ${p.min ?? 0} and ${p.max ?? "unbounded"}`;
    if (p.min !== undefined && n < p.min) return out("FAIL", exp, `${n} data rows`, "TOO_FEW_ROWS", [ev.header(c.sha12)]);
    if (p.max !== undefined && n > p.max) return out("FAIL", exp, `${n} data rows (${n - p.max} extra)`, "TOO_MANY_ROWS", n > p.max ? [ev.rows(c.sha12, p.max + 1, Math.min(n, p.max + 100))] : []);
    return pass(exp, `${n} data rows`);
  },
  no_duplicate_rows(p, c) {
    const sel = p.columns?.map((x) => colIndex(c, x));
    const exp = `no duplicate rows${p.columns ? ` on [${p.columns.join(", ")}]` : ""}`;
    if (sel?.some((i) => i < 0)) return out("FAIL", exp, "key column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const seen = new Map<string, number>();
    const dups: number[] = [];
    c.csv.rows.forEach((r, i) => {
      const key = JSON.stringify(sel ? sel.map((j) => r[j]) : r);
      if (seen.has(key)) dups.push(i + 1);
      else seen.set(key, i + 1);
    });
    return dups.length === 0 ? pass(exp, `${c.csv.rows.length} rows, 0 duplicates`) : out("FAIL", exp, `${dups.length} duplicate row(s)`, "DUPLICATE_ROWS", dups.map((n) => ev.row(c.sha12, n)));
  },
  unique_column_values(p, c) {
    const j = colIndex(c, p.column);
    const exp = `column "${p.column}" has unique values`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const seen = new Set<string>();
    const dups: number[] = [];
    c.csv.rows.forEach((r, i) => {
      const v = r[j]!;
      if (p.ignoreEmpty && isMissing(v)) return;
      if (seen.has(v)) dups.push(i + 1);
      else seen.add(v);
    });
    return dups.length === 0 ? pass(exp, "all values unique", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${dups.length} repeated value(s)`, "NOT_UNIQUE", dups.map((n) => ev.cell(c.sha12, n, p.column)));
  },
  null_rate_below(p, c) {
    const targets = p.column ? [colIndex(c, p.column)] : c.csv.headers.map((_, i) => i);
    const exp = `missing values <= ${p.maxMissingPercent}% ${p.column ? `in "${p.column}"` : "across all cells"}`;
    if (targets.some((i) => i < 0)) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const total = c.csv.rows.length * targets.length;
    if (total === 0) return out("UNVERIFIABLE", exp, "no data rows to measure", "NO_DATA_ROWS", [ev.header(c.sha12)]);
    const missing: string[] = [];
    let n = 0;
    c.csv.rows.forEach((r, i) => targets.forEach((j) => {
      if (isMissing(r[j]!)) {
        n++;
        if (missing.length < MAX_REFS) missing.push(ev.cell(c.sha12, i + 1, c.csv.headers[j]!));
      }
    }));
    const ok = n * 100 <= p.maxMissingPercent * total; // exact integer arithmetic, no floats
    return ok ? pass(exp, `${n} of ${total} cells missing`) : out("FAIL", exp, `${n} of ${total} cells missing`, "TOO_MANY_MISSING", missing);
  },
  no_forbidden_values(p, c) {
    const j = colIndex(c, p.column);
    const exp = `column "${p.column}" contains none of [${p.values.join(", ")}]`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const bad = c.csv.rows.flatMap((r, i) => (p.values.includes(r[j]!.trim()) ? [i + 1] : []));
    return bad.length === 0 ? pass(exp, "none found", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${bad.length} forbidden value(s)`, "FORBIDDEN_VALUE", bad.map((n) => ev.cell(c.sha12, n, p.column)));
  },
  column_values_in_set(p, c) {
    const j = colIndex(c, p.column);
    const exp = `every "${p.column}" value is one of [${p.values.join(", ")}]`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const bad = c.csv.rows.flatMap((r, i) => {
      const v = r[j]!.trim();
      return (p.allowEmpty && v === "") || p.values.includes(v) ? [] : [i + 1];
    });
    return bad.length === 0 ? pass(exp, "all values allowed", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${bad.length} value(s) outside the allowed set`, "VALUE_NOT_ALLOWED", bad.map((n) => ev.cell(c.sha12, n, p.column)));
  },
  date_format_valid(p, c) {
    const j = colIndex(c, p.column);
    const exp = `every "${p.column}" value is a real calendar date in ${p.format}`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const bad = c.csv.rows.flatMap((r, i) => ((p.allowEmpty && isMissing(r[j]!)) || validDate(r[j]!, p.format) ? [] : [i + 1]));
    return bad.length === 0 ? pass(exp, "all dates valid", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${bad.length} invalid date(s)`, "INVALID_DATE", bad.map((n) => ev.cell(c.sha12, n, p.column)));
  },
  column_type_valid(p, c) {
    const j = colIndex(c, p.column);
    const exp = `every "${p.column}" value is a valid ${p.type}`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const test = TYPE_RE[p.type]!;
    const bad = c.csv.rows.flatMap((r, i) => ((p.allowEmpty && isMissing(r[j]!)) || (p.type === "string" ? !isMissing(r[j]!) : test(r[j]!)) ? [] : [i + 1]));
    return bad.length === 0 ? pass(exp, "all values conform", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${bad.length} value(s) not a valid ${p.type}`, "WRONG_TYPE", bad.map((n) => ev.cell(c.sha12, n, p.column)));
  },
  source_records_preserved(p, c) {
    const j = colIndex(c, p.column);
    const exp = `all ${p.requiredValues.length} required source records appear in "${p.column}"`;
    if (j < 0) return out("FAIL", exp, "column missing", "COLUMN_MISSING", [ev.header(c.sha12)]);
    const present = new Set(c.csv.rows.map((r) => r[j]!.trim()));
    const missing = p.requiredValues.filter((v) => !present.has(v));
    return missing.length === 0 ? pass(exp, "all present", [ev.col(c.sha12, p.column)]) : out("FAIL", exp, `${missing.length} of ${p.requiredValues.length} required record(s) missing`, "SOURCE_RECORDS_MISSING", [ev.col(c.sha12, p.column)]);
  },
};

export function runDeterministicChecks(criteria: readonly Criterion[], csv: ParsedCsv, artifactSha256: string): DeterministicCheck[] {
  const ctx: Ctx = { csv, sha12: artifactSha256.slice(0, 12) };
  const results: DeterministicCheck[] = [];
  for (const c of criteria) {
    if (c.type !== "deterministic") continue;
    const base = { criterionId: c.id, validator: c.validator };
    const schema = PARAMS[c.validator as ValidatorName];
    if (!schema) {
      results.push({ ...base, status: "UNVERIFIABLE", expected: `a known validator`, actual: "validator not implemented", reason: "UNKNOWN_VALIDATOR", evidenceRefs: [] });
      continue;
    }
    const parsed = schema.safeParse(c.params);
    if (!parsed.success) {
      results.push({ ...base, status: "UNVERIFIABLE", expected: "valid contract parameters", actual: `parameters rejected: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") || "(root)").join(", ")}`, reason: "PARAMS_INVALID", evidenceRefs: [] });
      continue;
    }
    try {
      results.push({ ...base, ...(RUN[c.validator as ValidatorName] as (p: unknown, c: Ctx) => Outcome)(parsed.data, ctx) });
    } catch {
      // A validator bug must never become a PASS.
      results.push({ ...base, status: "UNVERIFIABLE", expected: "validator completes", actual: "validator raised an internal error", reason: "VALIDATOR_ERROR", evidenceRefs: [] });
    }
  }
  return results;
}
