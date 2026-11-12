/**
 * Evidence references: the ONLY way a verification claim may point at data. A reference is valid only if it addresses something
 * that really exists in THIS artifact, so a model cannot cite evidence it made up.
 *
 *   csv:<sha12>#header          the header row
 *   csv:<sha12>#col:<name>      a column
 *   csv:<sha12>#row:<n>         data row n (1-based, header excluded)
 *   csv:<sha12>#row:<n>,col:<name>   one cell
 *   csv:<sha12>#rows:<a>-<b>    an inclusive row range
 *   manifest:<field>            a field of the (untrusted) delivery manifest
 *   ledger:<seq> | delivery:<id>   as used by challenges (resolved elsewhere)
 * <sha12> = first 12 hex characters of the artifact SHA-256.
 */
import type { ParsedCsv } from "./csv";

export interface EvidenceContext {
  sha12: string;
  csv: ParsedCsv;
  manifestFields: readonly string[];
}

export const ev = {
  header: (sha12: string) => `csv:${sha12}#header`,
  col: (sha12: string, name: string) => `csv:${sha12}#col:${name}`,
  row: (sha12: string, n: number) => `csv:${sha12}#row:${n}`,
  cell: (sha12: string, n: number, name: string) => `csv:${sha12}#row:${n},col:${name}`,
  rows: (sha12: string, a: number, b: number) => `csv:${sha12}#rows:${a}-${b}`,
  manifest: (field: string) => `manifest:${field}`,
};

export type EvidenceCheck = { ok: true; text: string } | { ok: false; reason: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Validates that `ref` addresses real content in this artifact and returns the addressed text (for quote validation). */
export function resolveEvidence(ref: string, ctx: EvidenceContext): EvidenceCheck {
  if (typeof ref !== "string" || ref.length > 300) return { ok: false, reason: "MALFORMED" };
  const m = /^csv:([0-9a-f]{12})#(.+)$/.exec(ref);
  if (ref.startsWith("manifest:")) {
    const f = ref.slice(9);
    return ctx.manifestFields.includes(f) ? { ok: true, text: "" } : { ok: false, reason: "UNKNOWN_MANIFEST_FIELD" };
  }
  if (!m) return { ok: false, reason: "UNSUPPORTED_SCHEME" };
  if (m[1] !== ctx.sha12) return { ok: false, reason: "WRONG_ARTIFACT" }; // evidence about a different file
  const loc = m[2]!;
  const { headers, rows } = ctx.csv;
  if (loc === "header") return { ok: true, text: headers.join(" ") };
  let mm = /^col:(.+)$/.exec(loc);
  if (mm) return headers.includes(mm[1]!) ? { ok: true, text: mm[1]! } : { ok: false, reason: "UNKNOWN_COLUMN" };
  mm = /^row:(\d{1,6})$/.exec(loc);
  if (mm) {
    const n = Number(mm[1]);
    return n >= 1 && n <= rows.length ? { ok: true, text: rows[n - 1]!.join(" ") } : { ok: false, reason: "ROW_OUT_OF_RANGE" };
  }
  mm = /^row:(\d{1,6}),col:(.+)$/.exec(loc);
  if (mm) {
    const n = Number(mm[1]);
    const c = headers.indexOf(mm[2]!);
    return n >= 1 && n <= rows.length && c >= 0 ? { ok: true, text: rows[n - 1]![c]! } : { ok: false, reason: "CELL_OUT_OF_RANGE" };
  }
  mm = /^rows:(\d{1,6})-(\d{1,6})$/.exec(loc);
  if (mm) {
    const a = Number(mm[1]);
    const b = Number(mm[2]);
    return a >= 1 && b >= a && b <= rows.length && b - a < 200 ? { ok: true, text: rows.slice(a - 1, b).map((r) => r.join(" ")).join(" ") } : { ok: false, reason: "RANGE_OUT_OF_RANGE" };
  }
  return { ok: false, reason: "MALFORMED" };
}

/** AGENTS.md invariant 14: a quoted claim must appear verbatim (whitespace/case-normalised) in the cited source, length >= 4. */
export function quoteFoundIn(quote: string, sourceText: string): boolean {
  const q = norm(quote);
  return q.length >= 4 && norm(sourceText).includes(q);
}

/** Every reference must resolve, and (if given) the quote must appear in at least one of the cited sources. */
export function validateEvidence(refs: readonly string[], quote: string | undefined, ctx: EvidenceContext): { ok: true } | { ok: false; reason: string } {
  if (refs.length === 0) return { ok: false, reason: "NO_EVIDENCE" };
  let combined = "";
  for (const r of refs) {
    const c = resolveEvidence(r, ctx);
    if (!c.ok) return { ok: false, reason: `${c.reason}:${r.slice(0, 60)}` };
    combined += ` ${c.text}`;
  }
  if (quote !== undefined && !quoteFoundIn(quote, combined)) return { ok: false, reason: "QUOTE_NOT_IN_SOURCE" };
  return { ok: true };
}
