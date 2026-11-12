/**
 * Reproducible detector evaluation. Offline: no model, no network, no database.
 *
 *   npm run detector:eval                          measure only: print the per-fixture failures and counts
 *   npm run detector:eval -- --report out.json     also write the EvaluationReport the release registry validates
 *   options: --mutation <file.json>   a mutation-layer summary file (killed/survived/invalid/unreached); defaults to a clean 0/0/0/0 NOT-RUN marker
 *            --known-gaps a,b,c       fixture ids to disclose as known misses (defaults to every measured miss, so a release lists them honestly)
 *            --previous <report.json> compare with the previous release's report (permissiveness delta)
 *
 * The tuning and held-out sets are separate files under eval/detector. Counts only: these samples are far too small for an accuracy claim.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shippedDetector } from "../src/verification/language";
import { buildReport, failureIds, runFixtures, type FixtureSet } from "./lib/detector-eval-core";
import type { EvaluationReport } from "../src/domain/detector-registry";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const load = (p: string): FixtureSet => JSON.parse(readFileSync(resolve(p), "utf8")) as FixtureSet;

/** base set + optional additions (the additions are separate files so that a set that was held out stays byte-identical) */
const merged = (base: FixtureSet, extra: FixtureSet | null): FixtureSet => (extra ? { version: `${base.version}+${extra.version}`, cases: [...base.cases, ...extra.cases] } : base);
const extraArg = (name: string): FixtureSet | null => (arg(name) ? load(arg(name)!) : null);
const tuning = merged(load("eval/detector/tuning.v1.json"), extraArg("--tuning-extra"));
const heldOut = merged(load("eval/detector/heldout.v1.json"), extraArg("--heldout-extra"));
const results = runFixtures({ tuning, heldOut });
const measured = failureIds(results);

console.log(`detector ${JSON.stringify(shippedDetector())}`);
console.log(`tuning ${tuning.version}: ${tuning.cases.length} cases; held-out ${heldOut.version}: ${heldOut.cases.length} cases (counts only, not accuracy)`);
for (const r of results.filter((x) => x.failure)) console.log(`  MISS ${r.set}/${r.id}: expected ${r.expect}, got ${r.outcome} -> ${r.failure}`);
console.log(`unsafe passes: ${results.filter((r) => r.failure === "UNSAFE_PASS").length}; false blocks: ${results.filter((r) => r.failure === "FALSE_BLOCK").length}`);

const mutationFile = arg("--mutation");
const mutation = mutationFile
  ? (() => {
      const raw = readFileSync(resolve(mutationFile), "utf8");
      const j = JSON.parse(raw) as { killed: number; survived: number; invalid: number; unreached: number };
      return { killed: j.killed, survived: j.survived, invalid: j.invalid, unreached: j.unreached, reportSha256: createHash("sha256").update(raw).digest("hex") };
    })()
  : { killed: 0, survived: 0, invalid: 0, unreached: 0, reportSha256: "0".repeat(64) };
const previousFile = arg("--previous");
const gaps = arg("--known-gaps");
const report = buildReport({
  tuning,
  heldOut,
  mutation,
  previous: previousFile ? (JSON.parse(readFileSync(resolve(previousFile), "utf8")) as EvaluationReport) : null,
  previousReleaseLabel: previousFile ? previousFile : null,
  knownGaps: gaps !== undefined ? gaps.split(",").filter(Boolean) : measured,
  languageCoverage: ["en", "fr", "zh"],
});
for (const s of report.suites) console.log(`  ${s.passed ? "PASS" : "FAIL"} ${s.name}: ${s.failures}/${s.total} failures, ${s.undisclosedFailures} undisclosed${s.note ? ` (${s.note})` : ""}`);
if (!mutationFile) console.log("  NOTE: no --mutation file given: MUTATION_TESTING is a NOT-RUN marker (killed 0) and the registry will refuse this report");
const out = arg("--report");
if (out) {
  writeFileSync(resolve(out), JSON.stringify(report, null, 2));
  console.log(`report written to ${out}`);
}
