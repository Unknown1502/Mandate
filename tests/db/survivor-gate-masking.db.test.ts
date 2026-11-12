/**
 * Evidence for the classification of the six survivors of the post-P0 mutation run (docs/14 s14.27): under the REAL P0 gate (no mock in this file) the Lab cases
 * that the historical mutants targeted never reach the weakened defence, because the gate decides their LLM criterion first.
 *
 * For every targeted case that carries an llm_judged criterion this asserts, from the recorded VerificationResult: no model request was made, the LLM criterion is
 * UNVERIFIABLE with the P0 reason (not a language / scan / verdict reason), and provenance.isolation says the gate did not permit a model. That is the executed
 * proof that "the P0 gate prevents reaching the defence" for those cases. Cases without an LLM criterion (G28, G31) are NOT claimed to be masked: they are
 * deterministic-only and are covered by tests/db/p0-reachable-scan-defences.db.test.ts instead.
 * Real PostgreSQL (mandate_test), MOCK PayPal, scripted models that would answer if called. No real LLM, no PayPal call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CASES, LAB_CRITERIA } from "../../attack-lab/cases";
import { runCase, startLab, type Lab } from "../../attack-lab/harness";
import type { AttackCase } from "../../attack-lab/types";
import { MODEL_BLOCKED_REASON } from "@/verification/model-gate";

/** the cases each historical survivor targeted (attack-lab/reports/preserved-pre-repair/mutate.ts.pre-repair.txt) */
const TARGETS: Record<string, string[]> = {
  M10: ["A1", "A2", "A3", "A4"],
  M13: ["G35", "I5g", "I5h", "I5i", "I5j", "I5k"],
  M20: ["G01", "G11", "G15", "G24", "I5g", "I5j", "I5l"],
  M23: ["G18", "G32"],
  M24: ["G32"],
  M27: ["G30"],
  M25: ["G01", "G11", "G30", "I5g", "I5j"],
};
const UNIQUE = [...new Set(Object.values(TARGETS).flat())].sort();

type Res = { criteriaResults: { criterionId: string; type: string; status: string; reason: string }[]; provenance: { isolation?: { modelCallsPermitted: boolean; modelCallsMade: number; reason: string } } };
const seen: Record<string, { modelRequests: number; llmReasons: string[]; permitted: boolean | null }> = {};

let lab: Lab;
beforeAll(async () => {
  lab = await startLab();
});
afterAll(async () => {
  await lab.close();
});

describe("under the real P0 gate the survivors' targeted cases never reach the weakened defence", () => {
  it("the target table matches the preserved historical mutant definitions", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("attack-lab/reports/preserved-pre-repair/mutate.ts.pre-repair.txt", "utf8");
    for (const [id, cases] of Object.entries(TARGETS)) {
      const line = src.split("\n").find((l) => l.includes(`id: "${id}"`));
      expect(line, id).toBeTruthy();
      const only = /only: "([^"]+)"/.exec(line!)?.[1] ?? "";
      const matched = CASES.filter((c) => new RegExp(only).test(c.id)).map((c) => c.id).sort();
      expect(matched, id).toEqual([...cases].sort());
    }
  });

  it.each(UNIQUE)("%s: no model call, the LLM criterion is decided by the P0 gate", async (id) => {
    const base = CASES.find((c) => c.id === id) as AttackCase;
    const c: AttackCase = {
      ...base,
      check: async (env, facts) => {
        const run = await env.db.verificationRun.findFirst({ where: { dealId: env.dealId! }, orderBy: { sequence: "desc" } });
        const r = run!.resultJson as unknown as Res;
        const llm = r.criteriaResults.filter((x) => x.type === "llm_judged");
        seen[id] = { modelRequests: env.w.modelPrompts().length, llmReasons: llm.map((x) => x.reason), permitted: r.provenance.isolation?.modelCallsPermitted ?? null };
        const out = base.check ? await base.check(env, facts) : [];
        if (llm.length === 0) out.push("the case has no llm_judged criterion, so the P0 gate does not mask it");
        return out;
      },
    };
    const r = await runCase(lab, c, 1, LAB_CRITERIA);
    expect(r.error).toBeUndefined();
    // A1 is the one case whose terms were changed by P0 to carry an LLM criterion; all others are the historical definitions
    expect(seen[id]!.modelRequests).toBe(0);
    expect(seen[id]!.permitted).toBe(false);
    expect(seen[id]!.llmReasons.length).toBeGreaterThan(0);
    for (const reason of seen[id]!.llmReasons) expect(reason).toBe(MODEL_BLOCKED_REASON);
  }, 90_000);
});
