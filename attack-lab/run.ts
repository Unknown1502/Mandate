/**
 * Attack Lab CLI.   npm run attack -- [--runs 3] [--label name] [--only <regex on case ids>] [--no-probes] [--list]
 * Writes attack-lab/reports/<label>.json and .md. Requires PostgreSQL (mandate_test). Never calls PayPal or an LLM.
 */
import "./env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, LAB_CRITERIA } from "./cases";
import { runCase, startLab } from "./harness";
import { runProbes, type ProbeResult } from "./probes";
import { buildReport, renderMarkdown } from "./report";
import type { RunRecord } from "./types";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const runs = Number(arg("runs", "3"));
const label = arg("label", "latest")!;
const only = arg("only");
const cases = only ? CASES.filter((c) => new RegExp(only).test(c.id)) : CASES;

if (argv.includes("--list")) {
  for (const c of CASES) console.log(`${c.id.padEnd(5)} ${c.kind.padEnd(7)} ${c.category.padEnd(17)} ${c.title}`);
  process.exit(0);
}
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be an integer 1..10");

const lab = await startLab();
const records: RunRecord[] = [];
const stalls: { caseId: string; run: number; message: string }[] = [];
try {
  for (const c of cases) {
    for (let i = 1; i <= runs; i++) {
      let r = await runCase(lab, c, i, LAB_CRITERIA);
      // A host stall (laptop sleep, paused VM) says nothing about the product: discard the run, record that, and run it again (at most twice).
      for (let retry = 0; retry < 2 && r.error?.startsWith("ENVIRONMENT_STALL"); retry++) {
        stalls.push({ caseId: c.id, run: i, message: r.error.slice(0, 160) });
        console.log(`STALL  ${c.id.padEnd(5)} run ${i}/${runs}  discarded and re-run: ${r.error.slice(0, 100)}`);
        r = await runCase(lab, c, i, LAB_CRITERIA);
      }
      records.push(r);
      const tag = r.error ? "ERROR " : r.kind === "attack" ? (r.verdict.contained ? "held  " : "BREACH") : r.verdict.outcomeCorrect ? "ok    " : "DIFFER";
      console.log(`${tag} ${c.id.padEnd(5)} run ${i}/${runs}  ${r.facts.state}${r.facts.moneyOps.length ? " " + r.facts.moneyOps.map((o) => o.type + (o.amount ? " " + o.amount : "")).join("+") : ""}${r.error ? "  " + r.error : ""}`);
    }
  }
  const probes: ProbeResult[] = argv.includes("--no-probes") ? [] : await runProbes(lab);
  const report = buildReport({ label, runsPerCase: runs, records, cases, probes, stallsDiscarded: stalls });
  const dir = join(process.cwd(), "attack-lab", "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(dir, `${label}.md`), renderMarkdown(report));
  const m = report.metrics;
  const p = (r: { numerator: number; denominator: number; rate: number | null }) => (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`);
  console.log(`\nreport: attack-lab/reports/${label}.{json,md}`);
  console.log(`runs ${m.runs.total} (errored ${m.runs.errored}) | containment ${p(m.attackContainment)} | honest completion ${p(m.honestCompletion)} | false positives ${p(m.falsePositive)} | incorrect settlement ${p(m.incorrectSettlement)} | NEEDS_HUMAN ${p(m.needsHuman.overall)} | outcome matches policy ${p(m.outcomeMatchesPolicy)}`);
  console.log(`failures: ${report.failures.length} | probes: ${probes.map((x) => `${x.id}=${x.status}`).join(" ")} | real LLM runs: 0 | real PayPal calls: 0`);
} finally {
  await lab.close();
  process.exit(0);
}
