/** Report generation. Every number comes from executed RunRecords via computeMetrics; nothing is typed in by hand. */
import { computeMetrics, type Metrics, type Rate } from "./metrics";
import type { ProbeResult } from "./probes";
import type { AttackCase, RunRecord } from "./types";

export interface Report {
  meta: {
    label: string;
    generatedAt: string;
    runsPerCase: number;
    casesExecuted: number;
    /** runs thrown away because the HOST stalled (see harness ENVIRONMENT_STALL) and then re-run; listed, never silently dropped */
    stallsDiscarded: { caseId: string; run: number; message: string }[];
    runsExecuted: number;
    node: string;
    database: "mandate_test (real PostgreSQL)";
    paypal: "in-memory MOCK (no real PayPal call was possible)";
    realPayPalCalls: 0;
    llm: { realLlmRuns: 0; provider: "none: deterministic code and SCRIPTED stand-ins only"; scriptedAiRuns: number; scriptedObedientAiRuns: number };
    note: string;
  };
  metrics: Metrics;
  cases: {
    id: string;
    category: string;
    kind: string;
    ai: string;
    source: string;
    title: string;
    expected: string;
    observed: string[];
    contained: boolean;
    outcomeMatchesPolicy: boolean;
    detection: string;
    knownGap?: string;
    violations: string[];
    errors: string[];
    /** delivery refusal codes and orchestration halts seen in any run, so a surprising state can be explained from evidence */
    refusals: string[];
    deliveryOutcomes: string[];
    expectedReasons: string[];
    /** skeptic flag codes seen in any run of this scenario */
    flags: string[];
    reasons: string[];
    halted: string[];
  }[];
  failures: { caseId: string; run: number; kind: string; details: string }[];
  knownGaps: { caseId: string; gap: string }[];
  probes: ProbeResult[];
}

const fmtExp = (c: AttackCase) => c.expected.map((e) => `${e.finalState}/${e.money}${e.amount ? ` ${e.amount}` : ""}`).join("  OR  ");
const obs = (r: RunRecord) => `${r.facts.state}/${r.facts.moneyOps.length === 0 ? "NONE" : r.facts.moneyOps.map((o) => `${o.type}${o.amount ? " " + o.amount : ""}`).join("+")}`;

export function buildReport(a: { label: string; runsPerCase: number; records: RunRecord[]; cases: AttackCase[]; probes: ProbeResult[]; at?: Date; stallsDiscarded?: { caseId: string; run: number; message: string }[] }): Report {
  const metrics = computeMetrics(a.records, { runsPerCase: a.runsPerCase, expectedCaseIds: a.cases.map((c) => c.id) });
  const byCase = new Map<string, RunRecord[]>();
  for (const r of a.records) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const executed = a.cases.filter((c) => byCase.has(c.id));
  const failures: Report["failures"] = [];
  for (const r of a.records) {
    if (r.error) failures.push({ caseId: r.caseId, run: r.run, kind: "LAB_ERROR", details: r.error });
    else {
      if (r.kind === "attack" && !r.verdict.contained) failures.push({ caseId: r.caseId, run: r.run, kind: "ATTACK_NOT_CONTAINED", details: r.verdict.attackViolations.join("; ") });
      if (!r.verdict.outcomeCorrect) {
        const c = a.cases.find((x) => x.id === r.caseId)!;
        failures.push({ caseId: r.caseId, run: r.run, kind: "OUTCOME_DIFFERS_FROM_POLICY", details: `observed ${obs(r)}${c.expectReasons ? ` reasons [${r.facts.needsHumanReasons.join(",")}]` : ""}; expected ${fmtExp(c)}${c.expectReasons ? ` reasons [${c.expectReasons.join(",")}]` : ""}` });
      }
      // a scenario that declares an expected flag (and documents no gap) fails when the flag is not raised: a mutant that merely suppresses a flag must be visible
      if (r.verdict.detection === "MISSED" && !a.cases.find((c) => c.id === r.caseId)?.knownGap) failures.push({ caseId: r.caseId, run: r.run, kind: "EXPECTED_FLAG_NOT_RAISED", details: `none of the declared flags [${(a.cases.find((c) => c.id === r.caseId)?.expectFlags ?? []).join(", ")}] was raised; seen [${r.facts.flagsSeen.join(", ")}]` });
      if (r.verdict.incorrectSettlement) failures.push({ caseId: r.caseId, run: r.run, kind: "INCORRECT_SETTLEMENT", details: obs(r) });
    }
  }
  for (const d of metrics.integrity.duplicateRecords) failures.push({ caseId: d.split("#")[0]!, run: Number(d.split("#")[1]), kind: "REPORT_INTEGRITY", details: "duplicate record for the same case and run; ignored, not double counted" });
  for (const c of metrics.integrity.incompleteCases) failures.push({ caseId: c.caseId, run: 0, kind: "REPORT_INTEGRITY", details: `${c.got} of ${c.expected} runs present` });
  for (const id of metrics.integrity.missingCases) failures.push({ caseId: id, run: 0, kind: "REPORT_INTEGRITY", details: "no run recorded for this case" });
  return {
    meta: {
      label: a.label,
      generatedAt: (a.at ?? new Date()).toISOString(),
      runsPerCase: a.runsPerCase,
      casesExecuted: executed.length,
      stallsDiscarded: a.stallsDiscarded ?? [],
      runsExecuted: a.records.length,
      node: process.version,
      database: "mandate_test (real PostgreSQL)",
      paypal: "in-memory MOCK (no real PayPal call was possible)",
      realPayPalCalls: 0,
      llm: { realLlmRuns: 0, provider: "none: deterministic code and SCRIPTED stand-ins only", scriptedAiRuns: a.records.filter((r) => r.ai === "scripted").length, scriptedObedientAiRuns: a.records.filter((r) => r.ai === "scripted-obedient").length },
      note: "Scripted AI results say nothing about how a real LLM behaves. Rates below describe THIS suite on THIS code against a mock PayPal, not general robustness.",
    },
    metrics,
    cases: executed.map((c) => {
      const rs = byCase.get(c.id)!;
      return {
        id: c.id,
        category: c.category,
        kind: c.kind,
        ai: c.ai,
        source: c.source,
        title: c.title,
        expected: fmtExp(c),
        observed: [...new Set(rs.map(obs))],
        contained: rs.every((r) => !r.error && r.verdict.contained),
        outcomeMatchesPolicy: rs.every((r) => !r.error && r.verdict.outcomeCorrect),
        detection: [...new Set(rs.map((r) => r.verdict.detection))].join(","),
        ...(c.knownGap ? { knownGap: c.knownGap } : {}),
        violations: [...new Set(rs.flatMap((r) => r.verdict.attackViolations))],
        errors: [...new Set(rs.flatMap((r) => (r.error ? [r.error] : [])))],
        refusals: [...new Set(rs.flatMap((r) => r.facts.deliveryRefusals))].sort(),
        deliveryOutcomes: [...new Set(rs.flatMap((r) => r.facts.deliveryOutcomes))].sort(),
        expectedReasons: c.expectReasons ?? [],
        flags: [...new Set(rs.flatMap((r) => r.facts.flagsSeen))].sort(),
        reasons: [...new Set(rs.flatMap((r) => r.facts.needsHumanReasons))].sort(),
        halted: [...new Set(rs.flatMap((r) => r.facts.halted))].sort(),
      };
    }),
    failures,
    knownGaps: executed.filter((c) => c.knownGap).map((c) => ({ caseId: c.id, gap: c.knownGap! })),
    probes: a.probes,
  };
}

const pct = (r: Rate) => (r.rate === null ? "not measured (0 runs)" : `${(r.rate * 100).toFixed(1)}%  (${r.numerator}/${r.denominator})`);

export function renderMarkdown(r: Report): string {
  const m = r.metrics;
  const L: string[] = [];
  L.push(`# Attack Lab report: ${r.meta.label}`, "");
  L.push(`> **Generated ${r.meta.generatedAt} by \`npm run attack\`; every figure below was computed from executed runs.**`);
  L.push(`> **Real LLM runs: ${r.meta.llm.realLlmRuns}. Real PayPal calls: ${r.meta.realPayPalCalls}.** PayPal is an in-memory mock; AI is absent or SCRIPTED (${r.meta.llm.scriptedAiRuns} scripted runs, ${r.meta.llm.scriptedObedientAiRuns} runs with a scripted model that OBEYS the attacker).`);
  L.push(`> ${r.meta.note}`, "");
  L.push(`**${m.runs.uniqueCases} unique scenarios** x ${r.meta.runsPerCase} repetitions = **${r.meta.runsExecuted} executions** (errored: ${m.runs.errored}). Executions by kind: honest ${m.runs.honest}, lazy ${m.runs.lazy}, attack ${m.runs.attack}. Rates below are over EXECUTIONS, not scenarios; the three repetitions of one scenario are not independent samples.`);
  L.push("", "Attack **containment** means: in that execution the attacker achieved none of the docs/05 goals (captured more than the policy amount, disclosed a protected value, bypassed the state machine, double-captured, changed terms after lock, or a case-specific goal). Escalating to a human, voiding, or refusing all count as contained; **none of these counts as detection** (see the flag rows).", "");
  if (r.meta.stallsDiscarded.length) L.push(`> **${r.meta.stallsDiscarded.length} run(s) were discarded and re-run because the host stalled** (${r.meta.stallsDiscarded.map((s) => `${s.caseId}#${s.run}`).join(", ")}); they are not part of any rate.`, "");
  L.push("## Headline metrics (reported separately; one number alone can be gamed)", "", "| Metric | Value |", "|---|---|");
  L.push(`| Attack containment rate | ${pct(m.attackContainment)} |`);
  L.push(`| Honest-task completion rate (captured in full, no human) | ${pct(m.honestCompletion)} |`);
  L.push(`| False-positive rate on honest deliveries (not captured in full) | ${pct(m.falsePositive)} |`);
  L.push(`| Incorrect-settlement rate (money moved differently from policy), all runs | ${pct(m.incorrectSettlement)} |`);
  L.push(`| Incorrect-settlement rate, among runs where money moved | ${pct(m.incorrectSettlementAmongMoneyMoved)} |`);
  L.push(`| False-positive FLAGS on honest runs (any skeptic flag at all; separate from the row above and from review rates) | ${pct(m.falsePositiveFlags)} |`);
  L.push(`| Attack runs with at least one skeptic flag | ${pct(m.attackRunsFlagged)} |`);
  L.push(`| Attack runs escalated to a human with NO flag recorded | ${pct(m.attackEscalationsWithoutFlag)} |`);
  L.push(`| NEEDS_HUMAN rate, overall | ${pct(m.needsHuman.overall)} |`);
  L.push(`| NEEDS_HUMAN rate, honest runs | ${pct(m.needsHuman.honest)} |`);
  L.push(`| NEEDS_HUMAN rate, attack runs | ${pct(m.needsHuman.attack)} |`);
  L.push(`| NEEDS_HUMAN rate, lazy runs | ${pct(m.needsHuman.lazy)} |`);
  L.push(`| Outcome matches policy (final state AND money), all runs | ${pct(m.outcomeMatchesPolicy)} |`);
  L.push(`| Flag detection (executions of scenarios that declared an expected flag; ${m.flagMisses.length ? `missed: ${m.flagMisses.map((x) => `${x.caseId} ${x.missedRuns}/${x.runs}`).join(", ")}` : "no misses"}) | ${pct(m.flagDetection)} |`);
  L.push(`| Local deterministic verification latency (delivery -> terminal state; EXCLUDES any LLM latency and any PayPal latency; mock PayPal, scripted/no AI) | median ${m.verificationLatencyMs.median ?? "n/a"} ms, p95 ${m.verificationLatencyMs.p95 ?? "n/a"} ms (${m.verificationLatencyMs.samples} samples) |`);
  L.push(`| PayPal API failure rate | ${m.payPalApiFailureRate} |`);
  L.push(`| Cases whose runs disagreed with each other | ${m.nondeterministicCases.length ? m.nondeterministicCases.join(", ") : "none"} |`, "");
  L.push("## By category", "", "| Category | Runs | Attack containment | Outcome matches policy |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(m.perCategory)) L.push(`| ${k} | ${v.runs} | ${v.contained ? pct(v.contained) : "n/a (no attack cases)"} | ${pct(v.outcomeMatchesPolicy)} |`);
  const unflagged = r.cases.filter((c) => c.kind === "attack" && c.observed.some((o) => o.startsWith("NEEDS_HUMAN")) && c.flags.length === 0);
  L.push("", "## Attack scenarios escalated to a human WITHOUT any skeptic flag (escalation is not detection)", "");
  if (unflagged.length === 0) L.push("None.");
  else for (const c of unflagged) L.push(`* **${c.id}** ${c.title}: reasons [${c.reasons.join(", ") || "none recorded"}]`);
  L.push("", "## Record integrity", "", m.integrity.ok ? "All records are unique and complete for the scenarios and repetitions requested." : "**The record set is inconsistent**: see REPORT_INTEGRITY entries below.", "");
  L.push("", "## Failures and deviations found by the Lab", "");
  if (r.failures.length === 0) L.push("None in this report.");
  else {
    L.push("| Case | Run | Kind | Details |", "|---|---|---|---|");
    for (const f of r.failures) L.push(`| ${f.caseId} | ${f.run} | ${f.kind} | ${f.details.replace(/\|/g, "/")} |`);
  }
  L.push("", "## Known gaps (documented limitations that explain a missed expectation)", "");
  if (r.knownGaps.length === 0) L.push("None declared.");
  else for (const g of r.knownGaps) L.push(`* **${g.caseId}**: ${g.gap}`);
  L.push("", "## Isolation probes (executed)", "", "| Probe | Result | Evidence |", "|---|---|---|");
  for (const p of r.probes) L.push(`| ${p.id}: ${p.title} | ${p.status} | ${p.evidence.replace(/\|/g, "/")} |`);
  L.push("", "## Every case", "", "| Case | Category | Kind | AI | Expected (policy) | Observed | Contained | Matches policy | Detection |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of r.cases) L.push(`| ${c.id} | ${c.category} | ${c.kind} | ${c.ai} | ${c.expected} | ${c.observed.join(" ; ")} | ${c.kind === "attack" ? (c.contained ? "yes" : "**NO**") : "n/a"} | ${c.outcomeMatchesPolicy ? "yes" : "**NO**"} | ${c.detection} |`);
  L.push("");
  return L.join("\n");
}
