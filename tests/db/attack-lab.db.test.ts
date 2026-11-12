/**
 * Attack Lab as a regression suite: every case executes once against real PostgreSQL with a MOCK PayPal and SCRIPTED AI only.
 * `npm run attack` is the reporting entry point (3 runs per case); this file makes any regression fail CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASES, LAB_CRITERIA } from "../../attack-lab/cases";
import { runCase, startLab, type Lab } from "../../attack-lab/harness";
import { computeMetrics } from "../../attack-lab/metrics";
import { runProbes } from "../../attack-lab/probes";
import { buildReport, renderMarkdown } from "../../attack-lab/report";
import type { RunRecord } from "../../attack-lab/types";

let lab: Lab;
const records: RunRecord[] = [];
beforeAll(async () => {
  lab = await startLab();
});
afterAll(async () => {
  await lab.close();
});

describe("catalogue", () => {
  it("has unique ids, covers every required category, and contains both honest and adversarial cases", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    const cats = new Set(CASES.map((c) => c.category));
    for (const need of ["INJECTION", "PRESSURE", "TERMS_DRIFT", "EXFIL", "MANDATE_TAMPER", "EVIDENCE_FORGERY", "STATE_REPLAY", "POLICY_BYPASS", "AI_ONLY_SIGNAL", "HONEST"]) expect(cats.has(need as never), need).toBe(true);
    expect(CASES.some((c) => c.kind === "honest")).toBe(true);
    expect(CASES.some((c) => c.kind === "attack")).toBe(true);
    expect(CASES.every((c) => c.expected.length > 0)).toBe(true);
  });
  it("never uses a real LLM: every case declares none, scripted or scripted-obedient", () => {
    expect(new Set(CASES.map((c) => c.ai))).toEqual(new Set(["none", "scripted", "scripted-obedient"].filter((m) => CASES.some((c) => c.ai === m))));
    expect(CASES.every((c) => ["none", "scripted", "scripted-obedient"].includes(c.ai))).toBe(true);
  });
});

describe("cases", () => {
  it.each(CASES.map((c) => [c.id, c.title, c] as const))("%s: %s", async (_id, _title, c) => {
    const r = await runCase(lab, c, 1, LAB_CRITERIA);
    records.push(r);
    expect(r.error, "a scenario that throws is a lab error, never a pass").toBeUndefined();
    // 1. whatever the case, nothing the docs/05 attacker wants may have happened
    expect(r.verdict.attackViolations, "attacker achieved a goal").toEqual([]);
    expect(r.facts.ledgerViolations, "independent ledger audit").toEqual([]);
    expect(r.facts.disclosures, "secret / mandate detail visible to the seller").toEqual([]);
    // 2. money moved only as policy allows
    expect(r.verdict.incorrectSettlement, `money moved wrongly: ${JSON.stringify(r.facts.moneyOps)}`).toBe(false);
    expect(r.facts.moneyOps.length).toBeLessThanOrEqual(1);
    // 3. the settlement outcome is the policy-defined one (documented gaps concern detection, not money)
    expect(r.verdict.outcomeCorrect, `observed ${r.facts.state} ${JSON.stringify(r.facts.moneyOps)}`).toBe(true);
    // 4. honest cases are not penalised
    if (c.kind === "honest") expect(r.verdict.falsePositive).toBe(false);
    // 5. AI-only signals can never directly capture or void
    if (c.category === "AI_ONLY_SIGNAL") expect(r.facts.moneyOps).toEqual([]);
    // 6. a declared expected flag must have been detected unless the gap is documented
    if (c.expectFlags?.length && !c.knownGap) expect(r.verdict.detection).toBe("DETECTED");
  }, 90_000);
});

describe("deterministic acceptance failures follow the policy-defined outcome", () => {
  it("every required-criterion failure ends VOID with a VOID money operation, and no AI-only case ends VOID or CAPTURED", () => {
    const voids = records.filter((r) => ["L3", "L4", "F1", "F2", "F3"].includes(r.caseId));
    expect(voids.length).toBeGreaterThan(0);
    for (const r of voids) expect(r.facts.moneyOps.map((o) => o.type), r.caseId).toEqual(["VOID"]);
    for (const r of records.filter((x) => x.category === "AI_ONLY_SIGNAL")) {
      expect(r.facts.state, r.caseId).toBe("NEEDS_HUMAN");
      expect(r.facts.paypalWriteTypes.filter((t) => /CAPTURE|VOID/i.test(t)), r.caseId).toEqual([]);
    }
  });
});

describe("isolation probes", () => {
  it("execute, pass, and state plainly that the seller process is not an OS sandbox", async () => {
    const probes = await runProbes(lab);
    for (const p of probes.filter((x) => x.id !== "ISO-LIMIT")) expect(p.status, `${p.id}: ${p.evidence}`).toBe("PASS");
    const limit = probes.find((p) => p.id === "ISO-LIMIT")!;
    expect(limit.status).toBe("NOT_PROVIDED");
    expect(limit.evidence).toMatch(/NOT a secure OS sandbox/);
  }, 90_000);
});

describe("report integrity", () => {
  it("reports exactly what was executed: real LLM runs 0, real PayPal calls 0, errored runs counted, nothing invented", () => {
    const rep = buildReport({ label: "test", runsPerCase: 1, records, cases: CASES, probes: [] });
    expect(rep.meta.casesExecuted).toBe(records.length);
    expect(rep.meta.runsExecuted).toBe(records.length);
    expect(rep.meta.llm.realLlmRuns).toBe(0);
    expect(rep.meta.realPayPalCalls).toBe(0);
    const m = computeMetrics(records);
    expect(m.runs.total).toBe(records.length);
    expect(m.payPalApiFailureRate).toMatch(/NOT MEASURED/);
    expect(renderMarkdown(rep)).toContain("Real LLM runs: 0");
  });
});
