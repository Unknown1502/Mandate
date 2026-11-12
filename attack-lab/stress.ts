/**
 * Contention probe for ONE case: runs it many times IN PARALLEL in one process against the shared test database, with delivery outcomes
 * recorded. Used to investigate intermittent outcomes (B2). Usage:  npm run attack:stress -- --case B2 --parallel 16 --rounds 5
 * Test database only, mock PayPal only; never calls PayPal or an LLM.
 */
import "./env";
import { CASES, LAB_CRITERIA } from "./cases";
import { runCase, startLab } from "./harness";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const id = arg("case", "B2");
const parallel = Number(arg("parallel", "16"));
const rounds = Number(arg("rounds", "5"));
const c = CASES.find((x) => x.id === id);
if (!c) throw new Error(`unknown case ${id}`);
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64 || !Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("--parallel 1..64, --rounds 1..50");

const lab = await startLab();
const tally = new Map<string, number>();
try {
  for (let r = 0; r < rounds; r++) {
    const recs = await Promise.all(Array.from({ length: parallel }, (_, i) => runCase(lab, c, r * parallel + i + 1, LAB_CRITERIA)));
    for (const x of recs) {
      const key = x.error ? `LAB_ERROR ${x.error.slice(0, 120)}` : `${x.facts.state} | delivery=${x.facts.deliveryOutcomes.join(",") || "-"} | refusals=${x.facts.deliveryRefusals.join(",") || "-"} | halted=${x.facts.halted.join(",") || "-"} | contained=${x.verdict.contained} | outcomeOk=${x.verdict.outcomeCorrect}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  console.log(`case ${id}: ${parallel} parallel x ${rounds} rounds = ${parallel * rounds} runs`);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
} finally {
  await lab.close();
  process.exit(0);
}
