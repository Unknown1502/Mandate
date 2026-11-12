/**
 * Deterministic Skeptic: pattern checks over the delivered cells, headers and manifest metadata. No LLM, no I/O.
 * It never decides money. Severe findings (hidden text, encoded payloads, instructions aimed at the verifier) are marked
 * `severe`, which Gate 2 turns into NEEDS_HUMAN for a valid delivery, or leaves irrelevant when a required deterministic
 * criterion already failed (the contract failed, so the engine voids on that basis alone).
 */
import type { SkepticFlag } from "./contracts";
import type { ParsedCsv } from "./csv";
import { ev } from "./evidence";
import { confusableFindings, hasLookalikeRun, skeleton } from "./confusables";
import { assessCoverage, overrideInCoveredLanguages, withoutFiller } from "./language";

const ZERO_WIDTH = /[​-‏⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u;
const BIDI = /[‪-‮⁦-⁩]/;
const strip = (s: string) => s.normalize("NFKC").replace(/[​-‏⁠-⁤﻿‪-‮⁦-⁩]/g, "").replace(/[\u{E0000}-\u{E007F}]/gu, "");

type Rule = { code: SkepticFlag["code"]; severity: SkepticFlag["severity"]; severe: boolean; test: (raw: string, clean: string) => boolean | string; detail: string };

const RULES: Rule[] = [
  { code: "HIDDEN_TEXT", severity: "HIGH", severe: true, test: (raw) => ZERO_WIDTH.test(raw), detail: "zero-width or Unicode tag characters" },
  { code: "BIDI_CONTROL", severity: "HIGH", severe: true, test: (raw) => BIDI.test(raw), detail: "bidirectional control characters" },
  { code: "ENCODED_PAYLOAD", severity: "HIGH", severe: true, test: (_r, c) => /^[A-Za-z0-9+/_-]{60,}={0,2}$/.test(c.trim()) || /data:[\w/+.-]+;base64,/i.test(c) || /base64,[A-Za-z0-9+/=]{20,}/i.test(c), detail: "base64-like blob or data URI" },
  {
    code: "INSTR_OVERRIDE",
    severity: "HIGH",
    severe: true,
    test: (_r, c) => {
      const u = withoutFiller(c); // "ignore... all *previous* instructions": filler between the words must not evade the word-gap patterns
      return (
        /\b(ignore|disregard|override|bypass|forget)\b[\s\w,]{0,30}\b(instructions?|rules?|criteria|checks?|validations?|requirements?)\b/i.test(u) ||
        /\b(mark|set|rate|score|treat|consider|count)\b[\s\w]{0,15}\b(all|every|each)\b[\s\w]{0,15}\b(criteria|checks?|requirements?)\b[\s\w]{0,15}\b(met|passed?|satisf\w*|ok)\b/i.test(u) ||
        /(^|[\n.]\s*)(system|assistant|developer)\s*:/i.test(c) ||
        /\b(dear|attention|note to|message for|instructions? for)\s+(the\s+)?(verifier|reviewer|judge|evaluator|grader|ai|assistant)\b/i.test(u) ||
        /\byou (are|must|should|will)\b[\s\w]{0,40}\b(verifier|judge|reviewer|evaluator|assistant)\b/i.test(u) ||
        overrideInCoveredLanguages(c) // French and Chinese (language.ts); English above
      );
    },
    detail: "instructions addressed to the verifier / attempts to change verification",
  },
  { code: "PRICE_CHANGE_ATTEMPT", severity: "HIGH", severe: false, test: (_r, c) => /\b(increase|raise|change|update|revise|set)\b[\s\w]{0,30}\b(price|fee|amount|payment|invoice)\b/i.test(c) || /\bnew price\b/i.test(c) || /\b(capture|charge|release)\b[\s\w]{0,20}\$\s?\d/i.test(c), detail: "attempt to change the price or the amount" },
  { code: "AUTHORITY_SPOOF", severity: "HIGH", severe: false, test: (_r, c) => /\b(already|has been|was|pre-?)\s*(approved|authori[sz]ed|signed off)\b/i.test(c) || /\bpaypal\b[\s\w]{0,15}\b(notice|notification|alert)\b/i.test(c) || /\b(human|owner|principal|buyer)\b[\s\w]{0,25}\b(approved|authori[sz]ed)\b/i.test(c), detail: "claims of approval or authority" },
  { code: "EXFIL_REQUEST", severity: "HIGH", severe: false, test: (_r, c) => /\b(api[_ -]?keys?|secrets?|passwords?|tokens?|credentials?)\b[\s\w]{0,30}\b(paste|send|reply|reveal|share|include|provide)\b/i.test(c) || /\b(paste|send|reply with|reveal|share|include|provide|give|tell)\b[\s\w]{0,30}\b(api[_ -]?keys?|secrets?|passwords?|tokens?|credentials?)\b/i.test(c) || /\b(reveal|print|show|share|paste)\b[\s\w]{0,30}\b(system prompt|budget|credentials?|api[_ -]?key|secret)/i.test(c), detail: "request for secrets or private limits" },
  { code: "URGENCY_PRESSURE", severity: "MED", severe: false, test: (_r, c) => /\b(urgent|immediately|expires? in|last chance|right now|act now)\b/i.test(c), detail: "urgency or pressure language" },
  { code: "HTML_COMMENT", severity: "MED", severe: false, test: (_r, c) => /<!--|-->|<script\b|\[\/\/\]:\s*#/i.test(c), detail: "HTML/markdown comment or script markup" },
  // Fail closed: prose this scanner cannot read cannot be verified automatically. HIGH escalates to a human; it is not "severe" and never decides money.
  { code: "UNSCANNED_LANGUAGE", severity: "HIGH", severe: false, test: (_r, c) => assessCoverage(c) ?? false, detail: "free text in a language or script this scanner cannot read (covered: English, French, Chinese)" },
  // Visual spoofing is flagged structurally (it does not depend on which words the attacker chose). HIGH, not severe: a human decides.
  { code: "CONFUSABLE_SCRIPT_MIX", severity: "HIGH", severe: false, test: (_r, c) => confusableFindings(c).map((f) => f.kind).filter((k, i, a) => a.indexOf(k) === i).join(",") || false, detail: "mixed-script word or look-alike letters inside Latin text (visual spoofing)" },
  { code: "CSV_FORMULA_CELL", severity: "LOW", severe: false, test: (_r, c) => /^[=@]/.test(c) || /^[+-](?![\d.])/.test(c), detail: "cell starts with a spreadsheet formula character" },
];

/** Rules whose pattern is natural-language text that an attacker can split across adjacent fields of a row. */
const JOINED_RULES: ReadonlySet<SkepticFlag["code"]> = new Set(["INSTR_OVERRIDE", "PRICE_CHANGE_ATTEMPT", "AUTHORITY_SPOOF", "EXFIL_REQUEST", "URGENCY_PRESSURE", "HTML_COMMENT"]);
const JOINED_RULE_COUNT = JOINED_RULES.size;

const ASCII_WORD = /[A-Za-z]{4}/;
// Final QA B1: every natural-language pattern rule is ALSO evaluated on the text's confusable skeleton (combining marks removed, look-alikes mapped), so a spoofed spelling
// of an instruction matches the same pattern. The original text is untouched and remains the evidence; ASCII text skips the extra work entirely.
for (const r of RULES) {
  if (!JOINED_RULES.has(r.code)) continue;
  const base = r.test;
  r.test = (raw, clean) => {
    const direct = base(raw, clean);
    if (direct) return direct;
    // re-screen only when the text can spell Latin WORDS after skeletonisation (a run of 4+ ASCII-or-look-alike characters): ordinary Cyrillic / Greek / CJK prose cannot
    if (!hasLookalikeRun(clean)) return false;
    const sk = skeleton(clean);
    return sk !== clean && ASCII_WORD.test(sk) ? base(raw, sk) : false;
  };
}

/** Hard cap on the slow-path window evaluations in one prescan (an attacker controls the file, so the work must be bounded). */
const MAX_WINDOW_EVALS = 100_000;

/**
 * Processing limits. Work is counted in UNITS so the cut-off is the same on every machine: one unit per non-empty cell/header/metadata string
 * plus one per 16 characters; joining a row costs its characters/16; joining a column once per joined-text rule costs 6 x its characters/16.
 * The wall-clock deadline is only a backstop (it is checked every 256 units) for an unexpectedly slow machine. Hitting either limit STOPS the
 * scan and yields a HIGH SCAN_INCOMPLETE flag (never an empty result), which Gate 2 turns into NEEDS_HUMAN.
 * The default covers the largest file the delivery intake admits (200,000 bytes) with a wide margin (tests/unit/prescan-budget.test.ts).
 */
export interface PrescanBudget {
  maxUnits: number;
  deadlineMs: number;
  /** injectable monotonic clock in milliseconds (tests); defaults to performance.now */
  clock?: () => number;
}
export const DEFAULT_PRESCAN_BUDGET = { maxUnits: 600_000, deadlineMs: 5_000 } as const;

const UNIT_CHARS = 16;
const unitsOf = (s: string) => (s === "" ? 0 : 1 + Math.ceil(s.length / UNIT_CHARS));

/** The work a complete, hit-free scan of this input costs. Pure; used by tests and by callers that want to size a budget. */
export function scanUnits(csv: ParsedCsv, metadata?: Record<string, string | number | boolean>): number {
  let u = 0;
  for (const h of csv.headers) u += unitsOf(h);
  for (const v of Object.values(metadata ?? {})) if (typeof v === "string") u += unitsOf(v);
  const colChars = new Array<number>(csv.headers.length).fill(0);
  const colCells = new Array<number>(csv.headers.length).fill(0);
  for (const r of csv.rows) {
    let chars = 0;
    let filled = 0;
    r.forEach((c, j) => {
      if (c === "") return;
      u += unitsOf(c);
      chars += c.length;
      filled++;
      if (j < colChars.length) {
        colChars[j]! += c.length;
        colCells[j]!++;
      }
    });
    if (filled > 1) u += Math.ceil(chars / UNIT_CHARS);
  }
  for (let j = 0; j < colChars.length; j++) if (colCells[j]! >= 2) u += JOINED_RULE_COUNT * Math.ceil(colChars[j]! / UNIT_CHARS);
  return u;
}

export interface PrescanInput {
  csv: ParsedCsv;
  sha12: string;
  metadata?: Record<string, string | number | boolean>;
  budget?: Partial<PrescanBudget>;
  /**
   * How the unreadable-language guard behaves (language policy, docs/14):
   *   HIGH (default) escalates; LOW records an informational flag when no model reads the text; OFF disables it.
   *   `skip(row, col)` excludes cells the guard must not evaluate (columns withheld from the model, rows the model never sees).
   */
  language?: { mode?: "HIGH" | "LOW" | "OFF"; skip?: (row: number, col: number) => boolean };
}

export function prescan(input: PrescanInput): SkepticFlag[] {
  const maxUnits = input.budget?.maxUnits ?? DEFAULT_PRESCAN_BUDGET.maxUnits;
  const deadlineMs = input.budget?.deadlineMs ?? DEFAULT_PRESCAN_BUDGET.deadlineMs;
  const clock = input.budget?.clock ?? (() => performance.now());
  const t0 = clock();
  let used = 0;
  let ticks = 0;
  let stopped: "work budget" | "deadline" | null = null;
  /** Charge `n` units; false means a limit was hit and the caller must stop. */
  const charge = (n: number): boolean => {
    if (stopped) return false;
    used += n;
    if (used > maxUnits) return (stopped = "work budget"), false;
    ticks += n;
    if (ticks >= 256) {
      ticks = 0;
      if (clock() - t0 > deadlineMs) return (stopped = "deadline"), false;
    }
    return true;
  };

  const langMode = input.language?.mode ?? "HIGH";
  const skipCell = input.language?.skip;
  const hits = new Map<string, { rule: Rule; refs: string[]; count: number; reasons: Set<string>; lastWhy: string }>();
  const note = (rule: Rule, ref: string, why: boolean | string) => {
    const h = hits.get(rule.code) ?? { rule, refs: [], count: 0, reasons: new Set<string>(), lastWhy: "" };
    h.count++;
    if (h.refs.length < 10) h.refs.push(ref);
    if (typeof why === "string" && why !== h.lastWhy) {
      h.lastWhy = why;
      for (const r of why.split(",")) h.reasons.add(r);
    }
    hits.set(rule.code, h);
  };
  const rules = langMode === "OFF" ? RULES.filter((r) => r.code !== "UNSCANNED_LANGUAGE") : RULES;
  const scan = (raw: string, ref: string) => {
    if (raw === "" || !charge(unitsOf(raw))) return;
    const clean = strip(raw);
    for (const rule of rules) {
      const why = rule.test(raw, clean);
      if (why) note(rule, ref, why);
    }
  };

  // Headers and manifest metadata first: small, always read by a reviewer or a model, and they must be covered even when a limit is hit later.
  input.csv.headers.forEach((h) => scan(h, ev.header(input.sha12)));
  for (const [k, v] of Object.entries(input.metadata ?? {})) if (typeof v === "string") scan(v, ev.manifest(k));

  const rows = input.csv.rows;
  const stride = Math.max(input.csv.headers.length, ...rows.map((r) => r.length), 1);
  const cellHit = new Map<string, Set<number>>(); // rule code -> row*stride+col of cells that tripped the rule alone (never re-counted by a joined scan)
  const markHit = (code: string, i: number, j: number) => (cellHit.get(code) ?? cellHit.set(code, new Set()).get(code)!).add(i * stride + j);
  const wasHit = (code: string, i: number, j: number) => cellHit.get(code)?.has(i * stride + j) === true;

  let rowsScanned = 0;
  for (let i = 0; i < rows.length && !stopped; i++) {
    const r = rows[i]!;
    const hitInRow = new Set<string>();
    let rowComplete = true;
    for (let j = 0; j < r.length; j++) {
      const cellText = r[j]!;
      if (cellText === "") continue;
      if (!charge(unitsOf(cellText))) {
        rowComplete = false;
        break;
      }
      const clean = strip(cellText);
      for (const rule of rules) {
        if (rule.code === "UNSCANNED_LANGUAGE" && skipCell?.(i, j)) continue;
        const why = rule.test(cellText, clean);
        if (!why) continue;
        note(rule, ev.cell(input.sha12, i + 1, input.csv.headers[j]!), why);
        hitInRow.add(rule.code);
        markHit(rule.code, i, j);
      }
    }
    if (!rowComplete) break;
    // An instruction can be split across the fields of one row ("please ignore all" | "previous instructions"), so no single cell matches.
    // Scan the row joined by single spaces: the text-pattern rules, and the language-coverage guard (with its stricter word threshold).
    const filled = r.filter((c) => c !== "");
    if (filled.length > 1) {
      if (!charge(Math.ceil(filled.reduce((n, c) => n + c.length, 0) / UNIT_CHARS))) break;
      const joinedRaw = filled.join(" ");
      const joined = strip(joinedRaw);
      for (const rule of rules) {
        if (hitInRow.has(rule.code)) continue;
        let why: boolean | string | null = false;
        if (JOINED_RULES.has(rule.code)) why = rule.test(joinedRaw, joined);
        else if (rule.code === "UNSCANNED_LANGUAGE") {
          const visible = r.filter((c, j) => c !== "" && !skipCell?.(i, j));
          if (visible.length > 1) why = assessCoverage(strip(visible.join(" ")), { joined: true });
        }
        if (why) note(rule, ev.row(input.sha12, i + 1), why);
      }
    }
    rowsScanned++;
  }

  // ... or across 2-3 consecutive rows of one column (row 1 "please ignore all", row 2 "previous instructions").
  // Fast path (sound): any phrase across adjacent rows is also a substring of the whole column joined by spaces, so if the joined column does
  // not trip the rule, no window can. Cells that tripped the rule on their own are left out (never re-counted). Only a column that does trip
  // the rule goes to the slow path, which locates the hit in windows under a hard work budget; an unlocated hit is still reported (column header).
  let windowBudget = MAX_WINDOW_EVALS;
  for (let j = 0; j < input.csv.headers.length && !stopped; j++) {
    const colParts: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i]![j] ?? "";
      if (c !== "") colParts.push(c);
    }
    if (colParts.length < 2) continue;
    if (!charge(JOINED_RULE_COUNT * Math.ceil(colParts.reduce((n, c) => n + c.length, 0) / UNIT_CHARS))) break;
    for (const rule of rules) {
      if (!JOINED_RULES.has(rule.code)) continue;
      const parts: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const c = rows[i]![j] ?? "";
        if (c !== "" && !wasHit(rule.code, i, j)) parts.push(c);
      }
      if (parts.length < 2) continue;
      const whole = parts.join(" ");
      const wholeWhy = rule.test(whole, strip(whole));
      if (!wholeWhy) continue;
      const seen = new Set<number>();
      let located = 0;
      for (let i = 0; i + 1 < rows.length && windowBudget > 0; i++) {
        for (const size of [2, 3]) {
          if (i + size > rows.length || seen.has(i)) break;
          const cells = rows.slice(i, i + size).map((r) => r[j] ?? "");
          if (cells.some((c) => c === "" || !/\p{L}/u.test(c))) break;
          if (Array.from({ length: size }, (_, k) => wasHit(rule.code, i + k, j)).some(Boolean)) break;
          const text = cells.join(" ");
          if (text.length > 600) break;
          windowBudget--;
          const why = rule.test(text, strip(text));
          if (!why) continue;
          note(rule, ev.row(input.sha12, i + 1), why);
          located++;
          for (let k = 0; k < size; k++) seen.add(i + k);
        }
      }
      if (located === 0) note(rule, ev.header(input.sha12), wholeWhy);
    }
  }

  const flags: SkepticFlag[] = [...hits.values()].map(({ rule, refs, count, reasons }) => ({
    code: rule.code,
    severity: rule.code === "UNSCANNED_LANGUAGE" && langMode === "LOW" ? ("LOW" as const) : rule.severity,
    source: "deterministic" as const,
    severe: rule.severe,
    evidenceRefs: refs,
    detail: `${rule.detail}${rule.code === "UNSCANNED_LANGUAGE" && langMode === "LOW" ? " (informational: no model reads this text)" : ""}: ${count} occurrence(s)${reasons.size ? ` [${[...reasons].sort().join(", ")}]` : ""}`.slice(0, 300),
  }));
  if (stopped) {
    // An incomplete scan must never look like "nothing found": say so, with a flag that escalates.
    flags.push({
      code: "SCAN_INCOMPLETE",
      severity: "HIGH",
      severe: false,
      source: "deterministic",
      evidenceRefs: [ev.header(input.sha12)],
      detail: `prescan stopped (${stopped}): ${rowsScanned} of ${rows.length} rows scanned, ${Math.min(used, maxUnits)} of ${maxUnits} work units; the rest of the file was NOT checked`.slice(0, 300),
    });
  }
  if (input.csv.rows.length === 0) {
    flags.push({ code: "EMPTY_OR_PLACEHOLDER", severity: "MED", severe: false, source: "deterministic", evidenceRefs: [ev.header(input.sha12)], detail: "no data rows delivered" });
  }
  return flags.sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** Claims in the manifest checked against what was actually measured (needs the deterministic outcome, so it runs after the checks). */
export function metadataContradictions(
  metadata: Record<string, string | number | boolean> | undefined,
  facts: { rowCount: number; anyRequiredFailed: boolean },
): SkepticFlag[] {
  const flags: SkepticFlag[] = [];
  const claimed = metadata?.claimedRowCount;
  if (typeof claimed === "number" && claimed !== facts.rowCount) {
    flags.push({ code: "CONTRADICTORY_METADATA", severity: "MED", severe: false, source: "deterministic", evidenceRefs: [ev.manifest("claimedRowCount")], detail: `manifest claims ${claimed} rows; ${facts.rowCount} delivered` });
  }
  if (metadata?.claimsComplete === true && facts.anyRequiredFailed) {
    flags.push({ code: "UNSUPPORTED_COMPLETION_CLAIM", severity: "MED", severe: false, source: "deterministic", evidenceRefs: [ev.manifest("claimsComplete")], detail: "manifest claims completion but a required check failed" });
  }
  return flags;
}
