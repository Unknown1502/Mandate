/**
 * What can a model read? One definition, used twice: to BUILD the verifier/skeptic prompt (ai.ts) and to decide which text the language policy applies to.
 *
 * Facts about the current design (docs/14 §14.20):
 *   - An `llm_judged` criterion carries only free text; there is no per-criterion field list. One prompt serves every criterion, so every fragment
 *     in it is potentially relevant to every LLM-judged criterion ("whole-prompt fallback"). This module is where a per-criterion field list would narrow that.
 *   - The prompt contains: the header, every non-withheld column of the first MODEL_SAMPLE_ROWS rows, and the manifest metadata strings. Nothing else.
 *   - AI verdicts only count for `llm_judged` criteria and AI flags/observations can only escalate. A deal whose terms contain NO LLM-judged criterion
 *     therefore cannot be steered by any text: language rules do not apply to it (scope "criterion"; scope "all" applies them to every cell regardless).
 *   - Columns the deployment declares `opaqueColumns` are withheld from the prompt entirely, so they are not semantically interpreted and are exempt.
 */
import type { Criterion } from "../domain/terms";
import type { ParsedCsv } from "./csv";
import { ev } from "./evidence";
import { classifyString, lexiconLanguage, stripInvisible, type LanguagePolicy } from "./language";

/** How many data rows the verifier and skeptic prompts include. Shared with ai.ts so the prompt and the policy cannot drift apart. */
export const MODEL_SAMPLE_ROWS = 15;
export const WITHHELD = "[withheld]";

export interface Fragment {
  text: string;
  ref: string;
  kind: "header" | "cell" | "metadata";
  row?: number;
  col?: number;
}
export interface ScopeInput {
  csv: ParsedCsv;
  sha12: string;
  metadata: Record<string, string | number | boolean>;
}

const isOpaque = (policy: LanguagePolicy, header: string | undefined) => header !== undefined && policy.opaqueColumns.includes(header);

/** The strings a model can read (scope "criterion"), or every non-withheld string in the file (scope "all"). */
export function modelVisibleFragments(input: ScopeInput, policy: LanguagePolicy): Fragment[] {
  const out: Fragment[] = [];
  const { csv, sha12 } = input;
  csv.headers.forEach((h, col) => {
    if (h !== "") out.push({ text: h, ref: ev.header(sha12), kind: "header", col });
  });
  const last = policy.scope === "all" ? csv.rows.length : Math.min(csv.rows.length, MODEL_SAMPLE_ROWS);
  for (let row = 0; row < last; row++) {
    const r = csv.rows[row]!;
    for (let col = 0; col < r.length; col++) {
      const text = r[col]!;
      if (text === "" || isOpaque(policy, csv.headers[col])) continue;
      out.push({ text, ref: ev.cell(sha12, row + 1, csv.headers[col]!), kind: "cell", row, col });
    }
  }
  for (const [k, v] of Object.entries(input.metadata)) if (typeof v === "string" && v !== "") out.push({ text: v, ref: ev.manifest(k), kind: "metadata" });
  return out;
}

export interface LanguageFinding {
  ref: string;
  kind: "UNSUPPORTED" | "UNCERTAIN";
  reason: string;
}
export interface LanguageAssessment {
  /** whether language rules applied to this delivery at all */
  relevant: boolean;
  /** at most 10 findings, in file order */
  findings: LanguageFinding[];
  /** how many there were before the cap */
  total: number;
  /** fragments examined, for the audit record */
  examined: number;
}

/** Hard cap on fragments examined in scope "all" (a file can hold 1M cells); beyond it the caller must treat the assessment as incomplete. */
export const MAX_SCOPE_FRAGMENTS = 50_000;

/**
 * Apply the language policy. Returns relevant=false (and no findings) when no model can be influenced: scope "criterion" and no LLM-judged criterion.
 * Otherwise every model-visible string is classified (short or long); UNSUPPORTED and UNCERTAIN ones are findings. Instructions split across the fields of one row
 * or across 2-3 consecutive rows of one column are caught by screening the joined text against the override vocabulary; a row or window whose own cells
 * already produced a finding is not counted again.
 */
export function assessLanguageScope(criteria: readonly Criterion[], input: ScopeInput, policy: LanguagePolicy): LanguageAssessment & { incomplete: boolean } {
  const relevant = policy.scope === "all" || criteria.some((c) => c.type === "llm_judged");
  if (!relevant) return { relevant: false, findings: [], total: 0, examined: 0, incomplete: false };

  const fragments = modelVisibleFragments(input, policy);
  const incomplete = fragments.length > MAX_SCOPE_FRAGMENTS;
  const examine = incomplete ? fragments.slice(0, MAX_SCOPE_FRAGMENTS) : fragments;
  const found: LanguageFinding[] = [];
  const flaggedCells = new Set<string>(); // "row:col" cells that are findings on their own
  const flaggedRows = new Set<number>();
  for (const f of examine) {
    const c = classifyString(f.text, policy);
    if (c.kind !== "UNSUPPORTED" && c.kind !== "UNCERTAIN") continue;
    found.push({ ref: f.ref, kind: c.kind, reason: c.reason ?? c.kind.toLowerCase() });
    if (f.row !== undefined && f.col !== undefined) {
      flaggedCells.add(`${f.row}:${f.col}`);
      flaggedRows.add(f.row);
    }
  }

  // Split instructions: join the visible cells of a row, and 2-3 consecutive rows of a column, and screen the joined text for override vocabulary.
  const cells = examine.filter((f) => f.kind === "cell");
  const byRow = new Map<number, Fragment[]>();
  const byCol = new Map<number, Fragment[]>();
  for (const f of cells) {
    (byRow.get(f.row!) ?? byRow.set(f.row!, []).get(f.row!)!).push(f);
    (byCol.get(f.col!) ?? byCol.set(f.col!, []).get(f.col!)!).push(f);
  }
  for (const [row, fs] of byRow) {
    if (fs.length < 2 || flaggedRows.has(row)) continue;
    const vocab = lexiconLanguage(fs.map((f) => f.text).join(" "));
    if (vocab) found.push({ ref: ev.row(input.sha12, row + 1), kind: "UNSUPPORTED", reason: `vocabulary:${vocab}` });
  }
  for (const [, fs] of byCol) {
    const claimed = new Set<number>();
    for (let i = 0; i + 1 < fs.length; i++) {
      for (const size of [2, 3]) {
        const win = fs.slice(i, i + size);
        if (win.length < size || claimed.has(i)) break;
        if (win.some((f, k) => k > 0 && f.row! !== win[k - 1]!.row! + 1)) break; // consecutive rows only
        if (win.some((f) => flaggedCells.has(`${f.row}:${f.col}`))) break;
        const join = (w: Fragment[]) => w.map((f) => stripInvisible(f.text)).join(" ");
        const vocab = lexiconLanguage(join(win));
        if (!vocab) continue;
        // Report the MINIMAL window, so the evidence reference points at the row where the instruction starts: a 3-row window whose last two rows
        // already match is skipped here and reported when the scan reaches that shorter window.
        if (size === 3 && lexiconLanguage(join(win.slice(1)))) continue;
        found.push({ ref: win[0]!.ref, kind: "UNSUPPORTED", reason: `vocabulary:${vocab}` });
        for (let k = 0; k < size; k++) claimed.add(i + k);
      }
    }
  }
  return { relevant: true, findings: found.slice(0, 10), total: found.length, examined: examine.length, incomplete };
}
