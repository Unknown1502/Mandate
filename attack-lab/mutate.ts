/**
 * Mutation testing OF THE ATTACK LAB: weaken one product defence at a time and check that the Lab reports a failure.
 * A mutant the Lab does not catch means either (a) the Lab has a blind spot, or (b) another defence masks it (redundant guard).
 * Each mutant is only meaningful if the SAME cases pass on the unmutated code (the control), so that is checked first.
 * Product files are restored in a finally block and verified byte-for-byte. Run:  npm run attack:mutate
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Mutant {
  id: string;
  defence: string;
  file: string;
  find: string;
  replace: string;
  /** regex of case ids that should expose the weakened defence */
  only: string;
  /** also run these unit/DB test files against the mutant, to report WHICH layer notices it */
  tests?: string[];
}

const ALL_MUTANTS: Mutant[] = [
  { id: "M01", defence: "outbound leak guard (nothing a buyer says may contain mandate limits or secrets)", file: "src/agents/sanitize.ts", find: "  if (!text) return { ok: true, violations: [] };", replace: "  return { ok: true, violations: [] };", only: "^E[1-4]$" },
  { id: "M02", defence: "per-deal maximum in the policy check", file: "src/domain/policy.ts", find: 'if (price.gt(parseMoney(m.perDealMax))) reasons.push("PRICE_OVER_PER_DEAL_MAX");', replace: "", only: "^(T3|M3)$" },
  { id: "M03", defence: "total-budget check in the policy check", file: "src/domain/policy.ts", find: 'if (i.committed.add(price).gt(parseMoney(m.budgetTotal))) reasons.push("BUDGET_EXCEEDED");', replace: "", only: "^(T4|B4)$" },
  { id: "M04", defence: "counterparty allow-list in the policy check", file: "src/domain/policy.ts", find: 'if (!m.counterparties.includes(t.sellerId)) reasons.push("COUNTERPARTY_NOT_ALLOWED");', replace: "", only: "^B5$" },
  { id: "M05", defence: "mandate seal verification (accept any stored mandate bytes)", file: "src/domain/mandates.ts", find: "  return doc && doc.principalId === row.principalId ? doc : null;", replace: "  return doc && doc.principalId === row.principalId ? doc : (JSON.parse(row.canonicalJson) as MandateDocument);", only: "^(M1|M4)$" },
  { id: "M06", defence: "artifact hash check at delivery intake", file: "src/verification/delivery.ts", find: '!== m.artifactSha256) return reject("ARTIFACT_HASH_MISMATCH");', replace: '=== "never") return reject("ARTIFACT_HASH_MISMATCH");', only: "^(V3|V5)$" },
  { id: "M07", defence: "step 4 only: deterministic severe-flag escalation (step 5 HIGH-flag escalation still present)", file: "src/domain/settlement.ts", find: 'if (i.flags.some((f) => f.source === "deterministic" && f.severe === true)) {', replace: "if (false) {", only: "^(I2|I3b|I5|I6|X1|X2|X3)$", tests: ["tests/unit/settlement-pure.test.ts"] },
  { id: "M08", defence: "step 5 only: HIGH-severity-flag escalation (step 4 severe-flag escalation still present)", file: "src/domain/settlement.ts", find: 'if (i.flags.some((f) => f.severity === "HIGH")) return human(earned, ["HIGH_SEVERITY_FLAG"]);', replace: "", only: "^(P2|E1|C1|X1|X2|X3)$" },
  { id: "M09", defence: "steps 4 AND 5 together: every flag-based escalation", file: "src/domain/settlement.ts", find: 'if (i.flags.some((f) => f.severity === "HIGH")) return human(earned, ["HIGH_SEVERITY_FLAG"]);', replace: 'if (i.flags.some((f) => f.severity === "HIGH") && false) return human(earned, ["HIGH_SEVERITY_FLAG"]);', only: "^(I1|I2|I4|P2|C1|X1|X2|X3)$" },
  { id: "M10", defence: "an LLM-only required failure must go to a human (mutant: it voids instead)", file: "src/domain/settlement.ts", find: "if (llmFailed.length > 0) return human(earned, llmFailed.map((c) => `LLM_REQUIRED_NOT_MET:${c.id}`));", replace: 'if (llmFailed.length > 0) return { decision: "VOID", earned, amount: zero(), reasons: llmFailed.map((c) => `LLM_REQUIRED_NOT_MET:${c.id}`) };', only: "^A[1-4]$" },
  { id: "M12", defence: "French and Chinese override patterns (language.ts) wired into the skeptic", file: "src/verification/prescan.ts", find: "overrideInCoveredLanguages(c) // French and Chinese (language.ts); English above", replace: "false", only: "^(I5|I5b|I5c|I5d|I5f)$", tests: ["tests/unit/language-coverage.test.ts"] },
  { id: "M13", defence: "UNSCANNED_LANGUAGE escalates (mutant: severity LOW, so it no longer reaches a human)", file: "src/verification/prescan.ts", find: 'code: "UNSCANNED_LANGUAGE", severity: "HIGH"', replace: 'code: "UNSCANNED_LANGUAGE", severity: "LOW"', only: "^(G35|I5g|I5h|I5i|I5j|I5k)$", tests: ["tests/unit/language-coverage.test.ts"] },
  { id: "M14", defence: "language-coverage guard (unreadable prose is no longer detected)", file: "src/verification/prescan.ts", find: "test: (_r, c) => assessCoverage(c) ?? false,", replace: "test: () => false,", only: "^(G22|G35|G36|I5g|I5h|I5i|I5j|I5k)$", tests: ["tests/unit/language-coverage.test.ts"] },
  { id: "M15", defence: "instructions split across consecutive rows of one column", file: "src/verification/prescan.ts", find: "      if (!wholeWhy) continue;", replace: "      continue;", only: "^(I5e|I5f)$", tests: ["tests/unit/language-coverage.test.ts"] },
  { id: "M16", defence: "instructions split across the fields of one row (row-joined scan)", file: "src/verification/prescan.ts", find: "        if (hitInRow.has(rule.code)) continue;", replace: "        continue;", only: "^(I5d|I5k|I6)$", tests: ["tests/unit/language-coverage.test.ts"] },
  { id: "M17", defence: "unreadable prose split across short fields of one row (joined language guard)", file: "src/verification/prescan.ts", find: 'assessCoverage(strip(visible.join(" ")), { joined: true })', replace: "false", only: "^G35$", tests: ["tests/unit/language-coverage.test.ts"] },
  // ---- criterion-scoped language policy and processing limits (docs/14 §14.20-14.22)
  { id: "M18", defence: "short-string screening (restores the minimum-word bypass: strings under 4 words skip the override vocabulary)", file: "src/verification/language.ts", find: 'if (vocab) return { kind: "UNSUPPORTED"', replace: 'if (vocab && t.split(" ").length >= 4) return { kind: "UNSUPPORTED"', only: "^(G0[1-9]|G10|G12|G13|G14|G33|G34|I5l|I5m)$", tests: ["tests/unit/language-scope.test.ts"] },
  { id: "M19", defence: "scope findings (short strings, uncertain text, split instructions) raise UNSCANNED_LANGUAGE", file: "src/verification/pipeline.ts", find: "if (langScope.findings.length > 0 || langScope.incomplete) {", replace: "if (false as boolean) {", only: "^(G0[1-9]|G10|G15|G16|G17|G25|I5l|I5m)$" },
  { id: "M20", defence: "UNSCANNED_LANGUAGE blocks the AI: the model is no longer kept away from unreadable text", file: "src/verification/pipeline.ts", find: 'const languageBlocked = langScope.incomplete || flags.some((f) => f.code === "UNSCANNED_LANGUAGE" && f.severity === "HIGH");', replace: "const languageBlocked = false;", only: "^(G01|G11|G15|G24|I5g|I5j|I5l)$" },
  { id: "M21", defence: "uncertain semantic content is allowed to pass (only UNSUPPORTED is a finding)", file: "src/verification/scope.ts", find: 'if (c.kind !== "UNSUPPORTED" && c.kind !== "UNCERTAIN") continue;', replace: 'if (c.kind !== "UNSUPPORTED") continue;', only: "^G25$", tests: ["tests/unit/language-scope.test.ts"] },
  { id: "M22", defence: "criterion-to-text mapping bypassed: an LLM-judged criterion no longer makes model-readable text language-relevant", file: "src/verification/scope.ts", find: 'const relevant = policy.scope === "all" || criteria.some((c) => c.type === "llm_judged");', replace: 'const relevant = policy.scope === "all";', only: "^(G0[1-9]|G10|G11|G12|G15|G17|G24|G25|I5g|I5l)$", tests: ["tests/unit/language-scope.test.ts"] },
  { id: "M23", defence: "withheld (opaque) columns are not withheld from the prompt", file: "src/verification/ai.ts", find: 'const withheld = (j: number) => ctx.language?.opaqueColumns.includes(ctx.csv.headers[j] ?? "") === true;', replace: "const withheld = (_j: number) => false;", only: "^(G18|G32)$", tests: ["tests/unit/language-scope.test.ts"] },
  { id: "M24", defence: "withheld (opaque) columns are not exempt from the pipeline's language guard", file: "src/verification/pipeline.ts", find: 'const opaque = (col: number) => language.opaqueColumns.includes(csv.headers[col] ?? "");', replace: "const opaque = (_col: number) => false;", only: "^G32$" },
  { id: "M25", defence: "the AI verifier is called on text the policy blocked", file: "src/verification/pipeline.ts", find: "if (d.ai && !blockedReason) {", replace: "if (d.ai) {", only: "^(G01|G11|G30|I5g|I5j)$" },
  { id: "M26", defence: "the timeout/limit safety outcome is removed (no SCAN_INCOMPLETE flag when a limit is hit)", file: "src/verification/prescan.ts", find: "  if (stopped) {", replace: "  if (false as boolean) {", only: "^(G28|G30|G31)$", tests: ["tests/unit/prescan-budget.test.ts"] },
  { id: "M27", defence: "an incomplete prescan is treated as complete by the pipeline", file: "src/verification/pipeline.ts", find: 'const scanIncomplete = flags.some((f) => f.code === "SCAN_INCOMPLETE");', replace: "const scanIncomplete = false;", only: "^G30$" },
  { id: "M28", defence: "the deterministic work budget is not enforced", file: "src/verification/prescan.ts", find: 'if (used > maxUnits) return (stopped = "work budget"), false;', replace: 'if (false as boolean) return (stopped = "work budget"), false;', only: "^(G28|G30)$", tests: ["tests/unit/prescan-budget.test.ts"] },
  { id: "M29", defence: "the wall-clock deadline is not enforced", file: "src/verification/prescan.ts", find: 'if (clock() - t0 > deadlineMs) return (stopped = "deadline"), false;', replace: 'if (false as boolean) return (stopped = "deadline"), false;', only: "^G31$", tests: ["tests/unit/prescan-budget.test.ts"] },
  { id: "M11", defence: "required deterministic failure must void (mutant: ignore it)", file: "src/domain/settlement.ts", find: "if (detFailed.length > 0) {", replace: "if (false) {", only: "^(L3|F1|F2|F3)$" },
];

const idArg = process.argv.indexOf("--ids");
const wanted = idArg >= 0 ? new Set((process.argv[idArg + 1] ?? "").split(",").filter(Boolean)) : null;
if (wanted && ![...wanted].every((id) => ALL_MUTANTS.some((x) => x.id === id))) throw new Error("--ids names an unknown mutant");
const MUTANTS = ALL_MUTANTS.filter((x) => !wanted || wanted.has(x.id));

// If this process is interrupted gracefully while a mutant is in place, put the original file back first.
let mutated: { file: string; original: string } | null = null;
const restoreOnSignal = () => {
  if (mutated) writeFileSync(mutated.file, mutated.original);
  process.exit(130);
};
process.on("SIGINT", restoreOnSignal);
process.on("SIGTERM", restoreOnSignal);

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const tsx = join("node_modules", "tsx", "dist", "cli.mjs");
function lab(only: string, label: string) {
  const r = spawnSync(process.execPath, [tsx, "--env-file=.env.local", "attack-lab/run.ts", "--runs", "1", "--only", only, "--no-probes", "--label", label], { encoding: "utf8", timeout: 280_000 });
  if (r.status !== 0) return { ok: false as const, error: `exit ${r.status}: ${(r.stderr || r.stdout).slice(-300)}` };
  const rep = JSON.parse(readFileSync(join("attack-lab", "reports", `${label}.json`), "utf8")) as { failures: { caseId: string; kind: string; details: string }[]; meta: { runsExecuted: number } };
  return { ok: true as const, failures: rep.failures, runs: rep.meta.runsExecuted };
}

const rows: { id: string; defence: string; file: string; cases: string; control: string; result: string; caughtBy: string[]; kinds: string[]; unitLayer: string }[] = [];
const vitestCli = join("node_modules", "vitest", "vitest.mjs");
function unitLayer(files: string[] | undefined): string {
  if (!files?.length) return "not run";
  const r = spawnSync(process.execPath, [vitestCli, "run", ...files], { encoding: "utf8", timeout: 250_000 });
  return r.status === 0 ? "SURVIVED (tests passed)" : "KILLED (tests failed)";
}
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  const count = original.split(m.find).length - 1;
  const base = { id: m.id, defence: m.defence, file: m.file, cases: m.only, caughtBy: [] as string[], kinds: [] as string[], unitLayer: "not run" };
  if (count !== 1) {
    rows.push({ ...base, control: "n/a", result: `INVALID MUTANT: pattern found ${count} times (need exactly 1); nothing was mutated` });
    continue;
  }
  const control = lab(m.only, `mut-control-${m.id}`);
  if (!control.ok || control.failures.length > 0 || control.runs === 0) {
    rows.push({ ...base, control: control.ok ? `FAILED (${control.failures.length} failures, ${control.runs} runs)` : control.error, result: "NOT EVALUATED: the control run on unmutated code did not pass" });
    continue;
  }
  const controlText = `passed (${control.runs} runs)`;
  try {
    mutated = { file: m.file, original };
    writeFileSync(m.file, original.replace(m.find, () => m.replace));
    const mut = lab(m.only, `mut-${m.id}`);
    const layer = unitLayer(m.tests); // run while the mutant is in place
    if (!mut.ok) rows.push({ ...base, control: controlText, unitLayer: layer, result: `LAB CRASHED under mutation: ${mut.error}` });
    else {
      const ids = [...new Set(mut.failures.map((f) => f.caseId))].sort();
      rows.push({ ...base, control: controlText, unitLayer: layer, result: ids.length ? "KILLED (Lab reported failures)" : "SURVIVED (Lab reported nothing)", caughtBy: ids, kinds: [...new Set(mut.failures.map((f) => f.kind))].sort() });
    }
  } finally {
    writeFileSync(m.file, original);
    mutated = null;
    if (sha(readFileSync(m.file, "utf8")) !== sha(original)) throw new Error(`FAILED TO RESTORE ${m.file}`);
  }
}

mkdirSync(join("attack-lab", "reports"), { recursive: true });
let earlier: typeof rows = [];
try {
  earlier = (JSON.parse(readFileSync(join("attack-lab", "reports", "mutation.json"), "utf8")) as { rows: typeof rows }).rows;
} catch {
  /* first batch */
}
if (wanted) {
  const byId = new Map([...earlier, ...rows].map((r) => [r.id, r] as const));
  rows.length = 0;
  for (const x of ALL_MUTANTS) if (byId.has(x.id)) rows.push(byId.get(x.id)!);
}
const out = { generatedAt: new Date().toISOString(), note: "Each row: the same cases were run unmutated (control, must pass) and then with ONE defence weakened. SURVIVED means the Lab did not notice: a Lab blind spot or a redundant guard. 'Unit/DB layer' reports whether the named unit/DB test files notice the same mutant (a mutant the Lab misses but those tests kill is masked end to end, not untested).", rows };
writeFileSync(join("attack-lab", "reports", "mutation.json"), JSON.stringify(out, null, 2) + "\n");
const md = ["# Attack Lab mutation results", "", `Generated ${out.generatedAt}. ${out.note}`, "", "| Mutant | Defence weakened | Target cases | Control (unmutated) | Lab result | Failing cases | Failure kinds | Unit/DB layer |", "|---|---|---|---|---|---|---|---|"];
for (const r of rows) md.push(`| ${r.id} | ${r.defence} | \`${r.cases}\` | ${r.control} | **${r.result}** | ${r.caughtBy.join(", ") || "-"} | ${r.kinds.join(", ") || "-"} | ${r.unitLayer} |`);
writeFileSync(join("attack-lab", "reports", "mutation.md"), md.join("\n") + "\n");
for (const r of rows) console.log(`${r.id} ${(r.result.split(":")[0] ?? "").padEnd(34)} ${r.caughtBy.join(",").padEnd(22)} unit/DB: ${r.unitLayer.padEnd(24)} | ${r.defence}`);
