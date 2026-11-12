/**
 * Language assessment of a restricted model input (P4; docs/15 sections 15.6, 15.9.1, 15.9.2).
 *
 * The assessment reads `ModelInput.fragments`: the SAME strings the prompt was rendered from, so what is scanned can never differ from what a model would read.
 * Rules (the effective policy is the signed floor tightened by the terms policy and the deployment; nothing here can loosen it):
 *   NOT_LANGUAGE                      ok
 *   SUPPORTED (a supported language)  ok
 *   NAME_LIKE                         UNCERTAIN (docs/15 Q6: a name/address/identifier-shaped string in a model-visible field is never auto-passed)
 *   UNSUPPORTED                       blocked per unsupportedBehavior
 *   UNCERTAIN                         blocked per uncertainBehavior
 *   joined row / consecutive-row windows containing override vocabulary of an uncovered language: UNSUPPORTED (split instructions)
 *   too many fragments, deadline exceeded, detector exception, or a detector that is not the pinned one: blocked (incomplete scan / detector error)
 * "Blocked" means: the group's criteria are UNVERIFIABLE and NO model call is made for the group. Human review is never skipped: both behaviours route to a human.
 * (REJECT_DELIVERY is the stricter label; it does not void or pay anything on its own either, because a language heuristic must never decide money.)
 */
import type { Behaviour, EffectiveLanguagePolicy } from "../domain/language-policy";
import { markLanguageCleared, type ModelInput } from "./model-input";
import { classifyString, lexiconLanguage, stripInvisible, type LanguagePolicy as V1LanguagePolicy } from "./language";

export type LanguageBlockReason = "LANGUAGE_UNSUPPORTED" | "LANGUAGE_UNCERTAIN" | "SCAN_INCOMPLETE" | "DETECTOR_ERROR" | "LANGUAGE_DETECTOR_MISMATCH";

export interface InputLanguageAssessment {
  blocked: boolean;
  reason: LanguageBlockReason | null;
  /** the (effective) behaviour that applies to the dominant reason */
  behaviour: Behaviour | null;
  examined: number;
  total: number;
  /** at most 10, in order of discovery; refs only (no text) */
  findings: Array<{ ref: string; kind: "UNSUPPORTED" | "UNCERTAIN"; reason: string }>;
}

export const LANGUAGE_LIMITS = Object.freeze({ maxFragments: 5_000, deadlineMs: 2_000 });

export interface AssessOptions {
  now?: () => number;
  budget?: Partial<typeof LANGUAGE_LIMITS>;
  /** test seam: replaces the classifier (to prove a detector failure fails closed) */
  classify?: typeof classifyString;
  /** the detector actually shipped; when it differs from the pinned one the group is blocked */
  runtimeDetector?: { id: string; version: string; vocabularyHash: string };
}

const v1 = (p: EffectiveLanguagePolicy): V1LanguagePolicy => ({ supported: p.supportedLanguages, scope: "criterion", opaqueColumns: [] }) as V1LanguagePolicy;
const worse = (a: Behaviour, b: Behaviour): Behaviour => (a === "REJECT_DELIVERY" || b === "REJECT_DELIVERY" ? "REJECT_DELIVERY" : "UNVERIFIABLE_HUMAN_REVIEW");

export function assessModelInputLanguage(input: ModelInput, opts: AssessOptions = {}): InputLanguageAssessment {
  const policy = input.authorization.effectivePolicy;
  const now = opts.now ?? Date.now;
  const lim = { ...LANGUAGE_LIMITS, ...opts.budget };
  const empty = { examined: 0, total: 0, findings: [] as InputLanguageAssessment["findings"] };

  if (opts.runtimeDetector) {
    const d = input.authorization.detector;
    if (opts.runtimeDetector.id !== d.id || opts.runtimeDetector.version !== d.version || opts.runtimeDetector.vocabularyHash !== d.vocabularyHash)
      return { blocked: true, reason: "LANGUAGE_DETECTOR_MISMATCH", behaviour: policy.uncertainBehavior, ...empty };
  }
  const frags = input.fragments;
  if (frags.length > lim.maxFragments) return { blocked: true, reason: "SCAN_INCOMPLETE", behaviour: policy.incompleteScanBehavior, ...empty, total: frags.length };

  const classify = opts.classify ?? classifyString;
  const p1 = v1(policy);
  const started = now();
  const findings: InputLanguageAssessment["findings"] = [];
  let total = 0;
  let behaviour: Behaviour | null = null;
  let reason: LanguageBlockReason | null = null;
  const note = (r: LanguageBlockReason, b: Behaviour) => {
    behaviour = behaviour ? worse(behaviour, b) : b;
    reason ??= r;
  };
  const flaggedCells = new Set<string>();
  let examined = 0;
  try {
    for (const f of frags) {
      // A header fragment is the NAME of an approved field: it equals, character for character, an identifier the human saw and approved in the preview (field ids are
      // fixed by the signed terms and matched exactly), so it carries no seller-chosen text. Seller-controlled text is the CELLS.
      if (f.kind === "header") {
        examined++;
        continue;
      }
      if (now() - started > lim.deadlineMs) return { blocked: true, reason: "SCAN_INCOMPLETE", behaviour: policy.incompleteScanBehavior, examined, total, findings };
      examined++;
      const c = classify(f.text, p1);
      if (c.kind === "NOT_LANGUAGE" || c.kind === "SUPPORTED") continue;
      total++;
      const kind: "UNSUPPORTED" | "UNCERTAIN" = c.kind === "UNSUPPORTED" ? "UNSUPPORTED" : "UNCERTAIN"; // NAME_LIKE and UNCERTAIN are both uncertain (Q6)
      if (findings.length < 10) findings.push({ ref: f.ref, kind, reason: c.kind === "NAME_LIKE" ? "name-like" : (c.reason ?? c.kind.toLowerCase()) });
      if (f.row !== undefined) flaggedCells.add(`${f.row}:${f.fieldId}`);
      if (kind === "UNSUPPORTED") note("LANGUAGE_UNSUPPORTED", policy.unsupportedBehavior);
      else note("LANGUAGE_UNCERTAIN", policy.uncertainBehavior);
    }

    // split instructions: the cells of one row joined, and 2-3 consecutive rows of one column joined, screened against the override vocabulary
    const cells = frags.filter((f) => f.kind === "cell");
    const byRow = new Map<number, typeof cells>();
    const byCol = new Map<string, typeof cells>();
    for (const f of cells) {
      (byRow.get(f.row!) ?? byRow.set(f.row!, []).get(f.row!)!).push(f);
      (byCol.get(f.fieldId) ?? byCol.set(f.fieldId, []).get(f.fieldId)!).push(f);
    }
    for (const [row, fs] of byRow) {
      if (fs.length < 2 || fs.some((f) => flaggedCells.has(`${f.row}:${f.fieldId}`))) continue;
      const v = lexiconLanguage(fs.map((f) => stripInvisible(f.text)).join(" "));
      if (v) {
        total++;
        if (findings.length < 10) findings.push({ ref: fs[0]!.ref, kind: "UNSUPPORTED", reason: `vocabulary:${v}` });
        note("LANGUAGE_UNSUPPORTED", policy.unsupportedBehavior);
        void row;
      }
    }
    for (const fs of byCol.values()) {
      const claimed = new Set<number>();
      for (let i = 0; i + 1 < fs.length; i++) {
        for (const size of [2, 3]) {
          const win = fs.slice(i, i + size);
          if (win.length < size || claimed.has(i)) break;
          if (win.some((f, k) => k > 0 && f.row! !== win[k - 1]!.row! + 1)) break;
          if (win.some((f) => flaggedCells.has(`${f.row}:${f.fieldId}`))) break;
          const v = lexiconLanguage(win.map((f) => stripInvisible(f.text)).join(" "));
          if (!v) continue;
          total++;
          if (findings.length < 10) findings.push({ ref: win[0]!.ref, kind: "UNSUPPORTED", reason: `vocabulary:${v}` });
          note("LANGUAGE_UNSUPPORTED", policy.unsupportedBehavior);
          for (let k = 0; k < size; k++) claimed.add(i + k);
        }
      }
    }
  } catch {
    // a detector that throws is a detector that cannot be trusted: fail closed
    return { blocked: true, reason: "DETECTOR_ERROR", behaviour: policy.uncertainBehavior, examined, total, findings };
  }
  return { blocked: reason !== null, reason, behaviour, examined, total, findings };
}

/**
 * Assess the input's language and, only if nothing blocks it, register the input as language-cleared (the ModelRunner refuses an input that is not). There is no classifier
 * override here: a cleared input was cleared by the real detector under the effective policy.
 */
export function assessAndClear(input: ModelInput, opts: Pick<AssessOptions, "runtimeDetector" | "budget" | "now"> = {}): InputLanguageAssessment {
  const a = assessModelInputLanguage(input, opts);
  if (!a.blocked) markLanguageCleared(input);
  return a;
}
