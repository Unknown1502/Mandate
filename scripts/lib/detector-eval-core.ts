/**
 * Reproducible detector evaluation (P7). PURE apart from the clock used for the performance measurement: takes fixture objects, returns an EvaluationReport
 * (the shape the release registry validates). The CLI (scripts/detector-eval.ts) reads the fixture files and the optional mutation summary and prints the report.
 *
 * What is measured (and what is NOT claimed):
 *   - each fixture is run through the pre-model defence the V2 pipeline applies to model-visible text: the language classifier under the policy being evaluated
 *     (English, French, Chinese supported) AND the deterministic prescan override screens. A fixture expecting BLOCK that the defence lets through is an UNSAFE PASS;
 *     a fixture expecting OK that is blocked is a FALSE BLOCK (a usability cost, not a safety failure);
 *   - the TUNING set and the HELD-OUT set are separate files with separate versions, hashes and ids; the report refuses to be built if they overlap;
 *   - these are small hand-written samples. The report gives counts, never a percentage presented as accuracy, and it lists every miss by id.
 */
import { canonicalJson, sha256Hex } from "../../src/domain/canonical";
import type { EvaluationReport } from "../../src/domain/detector-registry";
import { shippedDetector, classifyString, overrideInCoveredLanguages, withoutFiller, fold, type LanguagePolicy } from "../../src/verification/language";
import { prescan } from "../../src/verification/prescan";
import type { ParsedCsv } from "../../src/verification/csv";

export interface FixtureCase {
  id: string;
  suite: "LANGUAGE_FIXTURES" | "UNICODE_MIXED_SCRIPT" | "SHORT_INSTRUCTION" | "PROMPT_INJECTION_REGRESSION" | "FALSE_POSITIVE_NEGATIVE";
  expect: "OK" | "BLOCK";
  text: string;
}
export interface FixtureSet {
  version: string;
  cases: FixtureCase[];
}

export const EVAL_POLICY: LanguagePolicy = { supported: ["en", "fr", "zh"], scope: "criterion", opaqueColumns: [] } as LanguagePolicy;
/** class order used for the permissiveness delta: a larger number means the text is passed to the model with less scrutiny */
const RANK: Record<string, number> = { UNSUPPORTED: 0, UNCERTAIN: 1, NAME_LIKE: 2, SCREENED: 2, SUPPORTED: 3, NOT_LANGUAGE: 3 };

export type Outcome = "UNSUPPORTED" | "UNCERTAIN" | "NAME_LIKE" | "SUPPORTED" | "NOT_LANGUAGE" | "SCREENED";

const ATTACK_FLAGS = new Set(["INSTR_OVERRIDE", "VERIFIER_TAMPER", "EXFIL_REQUEST", "AUTHORITY_SPOOF", "PRICE_CHANGE_ATTEMPT", "URGENCY_PRESSURE", "UNSCANNED_LANGUAGE"]);

/** the class of one text under the evaluated policy, and whether the pre-model defence lets it through */
export function screen(text: string): { outcome: Outcome; passes: boolean } {
  const c = classifyString(text, EVAL_POLICY);
  const csv: ParsedCsv = { headers: ["v"], rows: [[text]] };
  const flags = prescan({ csv, sha12: "0".repeat(12), language: { mode: "HIGH" } });
  const screened = flags.some((f) => ATTACK_FLAGS.has(f.code)) || overrideInCoveredLanguages(fold(withoutFiller(text)));
  const classAllows = c.kind === "NOT_LANGUAGE" || c.kind === "SUPPORTED";
  if (classAllows && screened) return { outcome: "SCREENED", passes: false };
  return { outcome: c.kind, passes: classAllows };
}

const datasetSha = (s: FixtureSet): string => sha256Hex(canonicalJson({ version: s.version, cases: s.cases.map((c) => ({ id: c.id, suite: c.suite, expect: c.expect, text: c.text })) }));

export interface EvalInputs {
  tuning: FixtureSet;
  heldOut: FixtureSet;
  /** summary of the mutation run for this detector (the registry refuses anything but a clean one) */
  mutation: { killed: number; survived: number; invalid: number; unreached: number; reportSha256: string };
  /** the previous release's report, for the permissiveness comparison; null for a first release */
  previous: EvaluationReport | null;
  previousReleaseLabel: string | null;
  /** fixture ids the release discloses as known misses */
  knownGaps: string[];
  languageCoverage: Array<"en" | "fr" | "zh">;
  previousCoverage?: Array<"en" | "fr" | "zh">;
  /** performance budget in ms for the benchmark fragments */
  perfBudgetMs?: number;
  now?: () => Date;
  clock?: () => number;
}

export interface FixtureResult {
  id: string;
  suite: FixtureCase["suite"];
  set: "tuning" | "heldOut";
  expect: "OK" | "BLOCK";
  outcome: Outcome;
  failure: "UNSAFE_PASS" | "FALSE_BLOCK" | null;
}

export function runFixtures(inputs: Pick<EvalInputs, "tuning" | "heldOut">): FixtureResult[] {
  const out: FixtureResult[] = [];
  for (const [set, fs] of [["tuning", inputs.tuning], ["heldOut", inputs.heldOut]] as const) {
    for (const c of fs.cases) {
      const s = screen(c.text);
      const failure = c.expect === "BLOCK" && s.passes ? "UNSAFE_PASS" : c.expect === "OK" && !s.passes ? "FALSE_BLOCK" : null;
      out.push({ id: c.id, suite: c.suite, set, expect: c.expect, outcome: s.outcome, failure });
    }
  }
  return out;
}

/** deterministic benchmark text: a mix of supported prose, numbers, names and foreign text */
export function benchmarkFragments(n: number): string[] {
  const base = [
    "The customer record was cleaned and merged with the existing account",
    "Le client a été nettoyé et fusionné avec le compte existant dans la base",
    "客户记录已清理并与现有账户合并",
    "12345",
    "John Smith",
    "Los registros del cliente fueron limpiados y fusionados",
    "a@example.com",
    "Записи клиентов были очищены и объединены",
  ];
  return Array.from({ length: n }, (_v, i) => `${base[i % base.length]!} ${i}`);
}

export function buildReport(inputs: EvalInputs): EvaluationReport {
  const ids = (s: FixtureSet) => s.cases.map((c) => c.id);
  const tIds = new Set(ids(inputs.tuning));
  if (ids(inputs.heldOut).some((id) => tIds.has(id))) throw new Error("tuning and held-out fixture ids overlap");
  if (datasetSha(inputs.tuning) === datasetSha(inputs.heldOut)) throw new Error("tuning and held-out datasets are identical");

  const results = runFixtures(inputs);
  const gaps = new Set(inputs.knownGaps);
  const suiteOf = (name: FixtureCase["suite"]) => {
    const rs = results.filter((r) => r.suite === name);
    const failures = rs.filter((r) => r.failure);
    const undisclosed = failures.filter((r) => !gaps.has(r.id));
    return { name, passed: undisclosed.length === 0, total: rs.length, failures: failures.length, undisclosedFailures: undisclosed.length };
  };
  const held = results.filter((r) => r.set === "heldOut");
  const heldFail = held.filter((r) => r.failure);
  const heldUndisclosed = heldFail.filter((r) => !gaps.has(r.id));

  // performance: classify + prescan-screen N fragments
  const clock = inputs.clock ?? (() => performance.now());
  const frags = benchmarkFragments(2000);
  const t0 = clock();
  for (const f of frags) screen(f);
  const ms = Math.round(clock() - t0);
  const budgetMs = inputs.perfBudgetMs ?? 4000;

  // release comparison: any fixture whose class moved toward "readable" is a permissiveness delta
  const fixtureOutcomes: Record<string, string> = Object.fromEntries(results.map((r) => [r.id, r.outcome]));
  const delta: EvaluationReport["comparison"]["permissivenessDelta"] = [];
  if (inputs.previous) {
    for (const [id, now] of Object.entries(fixtureOutcomes)) {
      const before = inputs.previous.fixtureOutcomes[id];
      if (before !== undefined && (RANK[now] ?? 0) > (RANK[before] ?? 0)) delta.push({ fixtureId: id, from: before, to: now });
    }
  }
  const languagesAdded = inputs.languageCoverage.filter((l) => inputs.previousCoverage && !inputs.previousCoverage.includes(l));

  const m = inputs.mutation;
  const suites: EvaluationReport["suites"] = [
    suiteOf("LANGUAGE_FIXTURES"),
    suiteOf("UNICODE_MIXED_SCRIPT"),
    suiteOf("SHORT_INSTRUCTION"),
    suiteOf("PROMPT_INJECTION_REGRESSION"),
    suiteOf("FALSE_POSITIVE_NEGATIVE"),
    { name: "PRESCAN_PERFORMANCE", passed: ms <= budgetMs, total: frags.length, failures: ms <= budgetMs ? 0 : 1, undisclosedFailures: ms <= budgetMs ? 0 : 1, note: `${frags.length} fragments in ${ms} ms (budget ${budgetMs} ms)` },
    { name: "MUTATION_TESTING", passed: m.killed > 0 && m.survived === 0 && m.invalid === 0 && m.unreached === 0, total: m.killed + m.survived + m.invalid + m.unreached, failures: m.survived + m.invalid + m.unreached, undisclosedFailures: m.survived + m.invalid + m.unreached },
    { name: "HELD_OUT_EVALUATION", passed: heldUndisclosed.length === 0, total: held.length, failures: heldFail.length, undisclosedFailures: heldUndisclosed.length, note: "counts of a small hand-written held-out sample; not an accuracy estimate" },
    { name: "RELEASE_COMPARISON", passed: true, total: Object.keys(fixtureOutcomes).length, failures: 0, undisclosedFailures: 0, note: inputs.previous ? `${delta.length} fixture(s) more permissive than ${inputs.previousReleaseLabel ?? "the previous release"}` : "first release: nothing to compare" },
  ];
  const all = results.filter((r) => r.failure);
  return {
    schema: "detector.evaluation/1",
    detector: shippedDetector(),
    datasets: {
      tuning: { version: inputs.tuning.version, sha256: datasetSha(inputs.tuning), ids: ids(inputs.tuning) },
      heldOut: { version: inputs.heldOut.version, sha256: datasetSha(inputs.heldOut), ids: ids(inputs.heldOut) },
    },
    suites,
    knownGaps: [...new Set(inputs.knownGaps)].sort(),
    counts: { unsafePasses: all.filter((r) => r.failure === "UNSAFE_PASS").length, falseBlocks: all.filter((r) => r.failure === "FALSE_BLOCK").length, tuningSize: inputs.tuning.cases.length, heldOutSize: inputs.heldOut.cases.length },
    perf: { fragments: frags.length, ms, budgetMs },
    mutation: m,
    comparison: { previousRelease: inputs.previous ? (inputs.previousReleaseLabel ?? "previous") : null, permissivenessDelta: delta, languagesAdded },
    fixtureOutcomes,
    environment: { node: process.version, platform: process.platform },
    generatedAt: (inputs.now ?? (() => new Date()))().toISOString(),
  };
}

export const failureIds = (results: FixtureResult[]): string[] => results.filter((r) => r.failure).map((r) => r.id).sort();
