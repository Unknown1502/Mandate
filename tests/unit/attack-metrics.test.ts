import { describe, expect, it } from "vitest";
import { computeMetrics } from "../../attack-lab/metrics";
import { buildReport, renderMarkdown } from "../../attack-lab/report";
import type { AttackCase, Facts, RunRecord, Verdict } from "../../attack-lab/types";

// SYNTHETIC records: these tests check the arithmetic and the "never invent a number" rules of the metrics code only.
// They say nothing about the system under test; real figures come from `npm run attack`.
const facts = (o: Partial<Facts> = {}): Facts => ({
  dealId: "d", state: "CAPTURED", capturedAmount: null, lockedPrice: null, lockedTermsHash: null, currentTermsHash: null, moneyOps: [], paypalWriteTypes: [],
  ledgerViolations: [], disclosures: [], flagsSeen: [], humanActions: 0, needsHumanEver: false, halted: [], deliveryRefusals: [], deliveryOutcomes: [], needsHumanReasons: [], latencyMs: null, caseViolations: [], ...o,
});
const verdict = (o: Partial<Verdict> = {}): Verdict => ({
  contained: true, attackViolations: [], outcomeCorrect: true, matchedExpectation: 0, incorrectSettlement: false, needsHuman: false, completedHonestly: false, falsePositive: false, detection: "NOT_EXPECTED", ...o,
});
const rec = (id: string, kind: RunRecord["kind"], v: Partial<Verdict> = {}, f: Partial<Facts> = {}, extra: Partial<RunRecord> = {}): RunRecord => ({
  caseId: id, category: kind === "honest" ? "HONEST" : kind === "lazy" ? "LAZY" : "INJECTION", kind, ai: "none", run: 1, facts: facts(f), verdict: verdict(v), ...extra,
});

describe("attack-lab metrics", () => {
  it("reports null (not measured), never 0 or 1, when a denominator is empty", () => {
    const m = computeMetrics([]);
    for (const r of [m.attackContainment, m.honestCompletion, m.falsePositive, m.falsePositiveFlags, m.attackRunsFlagged, m.attackEscalationsWithoutFlag, m.incorrectSettlement, m.incorrectSettlementAmongMoneyMoved, m.needsHuman.overall, m.needsHuman.honest, m.needsHuman.attack, m.needsHuman.lazy, m.outcomeMatchesPolicy, m.flagDetection]) {
      expect(r.denominator).toBe(0);
      expect(r.rate).toBeNull();
    }
    expect(m.verificationLatencyMs).toEqual({ median: null, p95: null, samples: 0 });
    expect(m.nondeterministicCases).toEqual([]);
    expect(m.payPalApiFailureRate).toMatch(/^NOT MEASURED/);
  });

  it("keeps the five requested metrics separate, each over its own denominator", () => {
    const recs = [
      rec("H1", "honest", { completedHonestly: true }),
      rec("H2", "honest", { falsePositive: true, needsHuman: true, outcomeCorrect: false, matchedExpectation: null }),
      rec("A1", "attack", { contained: true, needsHuman: true }),
      rec("A2", "attack", { contained: false, attackViolations: ["captured more than agreed"], incorrectSettlement: true, outcomeCorrect: false, matchedExpectation: null }, { moneyOps: [{ type: "CAPTURE", requestId: "r", amount: "30.00" }] }),
      rec("A3", "attack", { contained: true }),
      rec("L1", "lazy", { needsHuman: true }),
    ];
    const m = computeMetrics(recs);
    expect(m.attackContainment).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
    expect(m.honestCompletion).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.falsePositive).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.incorrectSettlement).toEqual({ numerator: 1, denominator: 6, rate: 1 / 6 });
    expect(m.incorrectSettlementAmongMoneyMoved).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(m.needsHuman.overall).toEqual({ numerator: 3, denominator: 6, rate: 0.5 });
    expect(m.needsHuman.honest).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.needsHuman.attack).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
    expect(m.needsHuman.lazy).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(m.outcomeMatchesPolicy).toEqual({ numerator: 4, denominator: 6, rate: 4 / 6 });
    expect(m.runs).toEqual({ total: 6, uniqueCases: 6, honest: 2, lazy: 1, attack: 3, errored: 0 });
  });

  it("never counts an errored run as contained, completed or correct", () => {
    const m = computeMetrics([rec("A1", "attack", {}, {}, { error: "boom" }), rec("H1", "honest", { completedHonestly: true }, {}, { error: "boom" })]);
    expect(m.runs).toMatchObject({ total: 2, errored: 2, attack: 0, honest: 0 });
    expect(m.attackContainment.rate).toBeNull();
    expect(m.honestCompletion.rate).toBeNull();
    expect(m.outcomeMatchesPolicy.rate).toBeNull();
  });

  it("measures flag detection only over cases that declared an expected flag", () => {
    const m = computeMetrics([rec("I3", "attack", { detection: "DETECTED" }), rec("I5", "attack", { detection: "MISSED" }), rec("X", "attack")]);
    expect(m.flagDetection).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("computes median and p95 only from runs that have a latency", () => {
    const m = computeMetrics([10, 20, 30, 40, 100].map((ms, i) => rec(`H${i}`, "honest", {}, { latencyMs: ms })).concat(rec("H9", "honest")));
    expect(m.verificationLatencyMs).toEqual({ median: 30, p95: 100, samples: 5 });
  });

  it("flags a case whose repeated runs disagree", () => {
    const a = rec("S1", "attack", {}, { state: "CAPTURED" });
    const b = rec("S1", "attack", {}, { state: "NEEDS_HUMAN" }, { run: 2 });
    const c = rec("S2", "attack");
    expect(computeMetrics([a, b, c, { ...c, run: 2 }]).nondeterministicCases).toEqual(["S1"]);
  });

  it("report: labels real-LLM runs as 0, counts scripted runs, and lists failures from the records", () => {
    const cases = [{ id: "A2", category: "INJECTION", kind: "attack", ai: "scripted", source: "invented", title: "t", expected: [{ finalState: "NEEDS_HUMAN", money: "NONE" }] } as unknown as AttackCase];
    const bad = rec("A2", "attack", { contained: false, attackViolations: ["captured more than agreed"], outcomeCorrect: false, matchedExpectation: null }, { state: "CAPTURED", moneyOps: [{ type: "CAPTURE", requestId: "r", amount: "30.00" }] }, { ai: "scripted" });
    const rep = buildReport({ label: "t", runsPerCase: 1, records: [bad], cases, probes: [], at: new Date("2026-01-01T00:00:00Z") });
    expect(rep.meta.llm).toMatchObject({ realLlmRuns: 0, scriptedAiRuns: 1, scriptedObedientAiRuns: 0 });
    expect(rep.meta.realPayPalCalls).toBe(0);
    expect(rep.failures.map((f) => f.kind).sort()).toEqual(["ATTACK_NOT_CONTAINED", "OUTCOME_DIFFERS_FROM_POLICY"]);
    const md = renderMarkdown(rep);
    expect(md).toContain("Real LLM runs: 0");
    expect(md).toContain("0.0%  (0/1)");
    expect(md).toContain("**NO**");
  });
});

describe("attack-lab metrics: scenarios vs executions, separation of measures, and record integrity (synthetic records)", () => {
  it("counts unique scenarios separately from executions", () => {
    const recs = [1, 2, 3].flatMap((run) => [rec("H1", "honest", { completedHonestly: true }, {}, { run }), rec("A1", "attack", {}, {}, { run })]);
    expect(computeMetrics(recs).runs).toMatchObject({ total: 6, uniqueCases: 2, honest: 3, attack: 3 });
  });

  it("keeps false-positive FLAGS, false-positive settlements and human-review rates as three different numbers", () => {
    const recs = [
      rec("H1", "honest", { completedHonestly: true }), // clean
      rec("H2", "honest", { completedHonestly: true }, { flagsSeen: ["URGENCY_PRESSURE"] }), // flagged, still paid in full
      rec("H3", "honest", { falsePositive: true, needsHuman: true, outcomeCorrect: false, matchedExpectation: null }, { flagsSeen: ["UNSCANNED_LANGUAGE"] }), // flagged AND escalated
      rec("H4", "honest", { falsePositive: true, needsHuman: true, outcomeCorrect: false, matchedExpectation: null }), // escalated, no flag
    ];
    const m = computeMetrics(recs);
    expect(m.falsePositiveFlags).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(m.falsePositive).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(m.needsHuman.honest).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(m.honestCompletion).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    // the same two runs are not the same two runs: H2 is a flag without escalation, H4 an escalation without a flag
    expect(recs.filter((r) => r.facts.flagsSeen.length > 0).map((r) => r.caseId)).toEqual(["H2", "H3"]);
  });

  it("never counts human escalation as detection: escalated attack runs without a flag are reported on their own", () => {
    const m = computeMetrics([
      rec("A1", "attack", { needsHuman: true }, { flagsSeen: ["INSTR_OVERRIDE"] }),
      rec("A2", "attack", { needsHuman: true }, {}), // escalated, nothing flagged
      rec("A3", "attack", {}, { flagsSeen: ["HTML_COMMENT"] }), // flagged, not escalated
      rec("A4", "attack", {}, {}),
    ]);
    expect(m.attackRunsFlagged).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(m.attackEscalationsWithoutFlag).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.flagDetection.denominator).toBe(0); // no scenario declared an expected flag: detection is NOT inferred from escalation
    expect(m.flagDetection.rate).toBeNull();
  });

  it("lists the scenarios that missed a declared flag, with how many of their runs missed", () => {
    const recs = [1, 2, 3].map((run) => rec("I5", "attack", { detection: "MISSED" }, {}, { run }));
    recs.push(rec("I6", "attack", { detection: "DETECTED" }, {}, { run: 1 }), rec("I6", "attack", { detection: "MISSED" }, {}, { run: 2 }));
    const m = computeMetrics(recs);
    expect(m.flagMisses).toEqual([{ caseId: "I5", missedRuns: 3, runs: 3 }, { caseId: "I6", missedRuns: 1, runs: 2 }]);
    expect(m.flagDetection).toEqual({ numerator: 1, denominator: 5, rate: 0.2 });
  });

  it("drops duplicate (case, run) records, reports them, and does not double count", () => {
    const a = rec("A1", "attack", { contained: false, attackViolations: ["x"] });
    const m = computeMetrics([a, { ...a }, rec("A1", "attack", {}, {}, { run: 2 })]);
    expect(m.runs.total).toBe(2);
    expect(m.attackContainment).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.integrity).toMatchObject({ ok: false, duplicateRecords: ["A1#1"] });
  });

  it("reports incomplete and missing scenarios against what was requested", () => {
    const m = computeMetrics([rec("A1", "attack", {}, {}, { run: 1 }), rec("A1", "attack", {}, {}, { run: 2 }), rec("A2", "attack", {}, {}, { run: 1 })], { runsPerCase: 2, expectedCaseIds: ["A1", "A2", "A3"] });
    expect(m.integrity.ok).toBe(false);
    expect(m.integrity.incompleteCases).toEqual([{ caseId: "A2", got: 1, expected: 2 }]);
    expect(m.integrity.missingCases).toEqual(["A3"]);
    expect(computeMetrics([rec("A1", "attack", {}, {}, { run: 1 }), rec("A1", "attack", {}, {}, { run: 2 })], { runsPerCase: 2, expectedCaseIds: ["A1"] }).integrity.ok).toBe(true);
  });

  it("counts an unexpected outcome against 'outcome matches policy' and, if money moved, against incorrect settlement", () => {
    const m = computeMetrics([
      rec("L1", "lazy", {}, {}),
      rec("L2", "lazy", { outcomeCorrect: false, matchedExpectation: null, incorrectSettlement: true }, { moneyOps: [{ type: "CAPTURE", requestId: "r", amount: "18.24" }] }),
    ]);
    expect(m.outcomeMatchesPolicy).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.incorrectSettlement).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(m.incorrectSettlementAmongMoneyMoved).toEqual({ numerator: 1, denominator: 1, rate: 1 });
  });

  it("report: a declared flag that is not raised is a FAILURE unless the scenario documents a known gap", () => {
    const base = { id: "I9", category: "INJECTION", kind: "attack", ai: "none", source: "invented", title: "t", expected: [{ finalState: "CAPTURED", money: "NONE" }], expectFlags: ["INSTR_OVERRIDE"] };
    const missed = rec("I9", "attack", { detection: "MISSED" }, { flagsSeen: ["HTML_COMMENT"] });
    const failing = buildReport({ label: "t", runsPerCase: 1, records: [missed], cases: [base as unknown as AttackCase], probes: [] });
    expect(failing.failures.filter((f) => f.kind === "EXPECTED_FLAG_NOT_RAISED")).toHaveLength(1);
    expect(failing.failures[0]!.details).toMatch(/INSTR_OVERRIDE/);
    const documented = buildReport({ label: "t", runsPerCase: 1, records: [missed], cases: [{ ...base, knownGap: "documented" } as unknown as AttackCase], probes: [] });
    expect(documented.failures.filter((f) => f.kind === "EXPECTED_FLAG_NOT_RAISED")).toHaveLength(0);
    expect(documented.metrics.flagMisses).toEqual([{ caseId: "I9", missedRuns: 1, runs: 1 }]); // still measured as a miss
  });

  it("report: lists integrity problems as failures and labels latency as local deterministic latency", () => {
    const cases = [{ id: "A1", category: "INJECTION", kind: "attack", ai: "none", source: "invented", title: "t", expected: [{ finalState: "CAPTURED", money: "NONE" }] } as unknown as AttackCase];
    const rep = buildReport({ label: "t", runsPerCase: 2, records: [rec("A1", "attack")], cases, probes: [], at: new Date("2026-01-01T00:00:00Z") });
    expect(rep.failures.some((f) => f.kind === "REPORT_INTEGRITY" && /1 of 2 runs/.test(f.details))).toBe(true);
    const md = renderMarkdown(rep);
    expect(md).toContain("unique scenarios");
    expect(md).toContain("EXCLUDES any LLM latency and any PayPal latency");
    expect(md).toContain("NOT MEASURED");
  });
});
