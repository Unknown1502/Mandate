/**
 * Attack Lab case B2 ended AWAITING_DELIVERY in 2 of 3 runs of one report. Investigation (docs/14 §14.13): the ledger shows two
 * TIMESTAMP_IN_FUTURE refusals whose deals were 88 and 304 MINUTES old when the delivery arrived, i.e. the host was suspended in the
 * middle of those runs. The Lab froze its mock clock at world creation but stamped manifests with wall-clock time, so after a stall the
 * product (correctly) refused a "future" delivery.
 *
 * What these tests establish, against real PostgreSQL and the mock PayPal:
 *   1. the mechanism reproduces on demand (clock discontinuity > 5 min -> TIMESTAMP_IN_FUTURE), and the refusal is SAFE:
 *      nothing is delivered, verified, reserved further or paid, and it is recorded in the ledger;
 *   2. it is RECOVERABLE, not stuck: the step stays OPEN and the same manifest succeeds once time catches up;
 *   3. concurrent and replayed deliveries create exactly one delivery and one verification, and move no money;
 *   4. the Lab itself no longer depends on wall-clock time for manifests, and refuses to report runs that straddle an environment stall.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../attack-lab/harness";
import { LAB_CRITERIA } from "../../attack-lab/cases";
import { MIN, runCase, startLab, type CaseEnv, type Lab } from "../../attack-lab/harness";
import type { AttackCase } from "../../attack-lab/types";
import { GOOD, manifestFor } from "./deliveryFixtures";

let lab: Lab;
beforeAll(async () => {
  lab = await startLab();
});
afterAll(async () => {
  await lab.close();
});

const HOUR = 60 * MIN;
const mk = (id: string, run: AttackCase["run"], extra: Partial<AttackCase> = {}): AttackCase => ({
  id,
  category: "STATE_REPLAY",
  kind: "attack",
  title: id,
  source: "invented",
  attackGoal: "test",
  ai: "none",
  expected: [{ finalState: "VERIFYING", money: "NONE" }],
  run,
  world: { window: 10 * MIN },
  ...extra,
});
const rowsFor = async (dealId: string) => ({
  deal: await prisma.deal.findUniqueOrThrow({ where: { id: dealId } }),
  deliveries: await prisma.delivery.count({ where: { dealId } }),
  runs: await prisma.verificationRun.count({ where: { dealId } }),
  rejected: await prisma.dealEvent.findMany({ where: { dealId, type: "DELIVERY_REJECTED" } }),
  deliverySteps: await prisma.orchestrationStep.findMany({ where: { dealId, step: "DELIVERY" } }),
});

describe("B2 mechanism: a clock discontinuity makes the product refuse the delivery, safely and recoverably", () => {
  it("reproduces the symptom: AWAITING_DELIVERY, a TIMESTAMP_IN_FUTURE rejection in the ledger, no money, step left OPEN", async () => {
    let env!: CaseEnv;
    const rec = await runCase(
      lab,
      mk("T-B2-repro", async (e) => {
        env = e;
        await e.journey();
        e.w.clock.t -= 3 * HOUR; // the host was suspended: this world's clock is now 3 hours behind real time
        const r = await e.w.orch.receiveDelivery({ dealId: e.dealId!, authenticatedSellerId: "seller-sim", manifest: manifestFor(await e.row(), GOOD(), { submittedAt: new Date().toISOString() }), artifact: GOOD() });
        expect(r.delivery).toMatchObject({ status: "REFUSED", reason: "TIMESTAMP_IN_FUTURE" });
      }, { expected: [{ finalState: "AWAITING_DELIVERY", money: "NONE" }] }),
      1,
      LAB_CRITERIA,
    );
    expect(rec.error).toBeUndefined();
    const s = await rowsFor(env.dealId!);
    expect(s.deal.state).toBe("AWAITING_DELIVERY");
    expect(s.deliveries).toBe(0);
    expect(s.runs).toBe(0);
    expect(s.rejected.map((e) => (e.payload as { code: string }).code)).toEqual(["TIMESTAMP_IN_FUTURE"]);
    expect(s.deliverySteps.map((x) => x.status)).toEqual(["OPEN"]); // a refusal is never final
    expect(rec.facts.moneyOps).toEqual([]);
    expect(rec.verdict.outcomeCorrect).toBe(true);
  });

  it("is NOT stuck: the same manifest succeeds once time catches up, giving exactly one delivery and one verification", async () => {
    let env!: CaseEnv;
    const rec = await runCase(
      lab,
      mk("T-B2-recover", async (e) => {
        env = e;
        await e.journey();
        const manifest = manifestFor(await e.row(), GOOD(), { submittedAt: new Date(e.w.clock.t + HOUR).toISOString() });
        const send = () => e.w.orch.receiveDelivery({ dealId: e.dealId!, authenticatedSellerId: "seller-sim", manifest, artifact: GOOD() });
        expect((await send()).delivery).toMatchObject({ status: "REFUSED", reason: "TIMESTAMP_IN_FUTURE" });
        e.w.tick(HOUR); // time catches up
        expect((await send()).delivery).toMatchObject({ status: "DONE" });
        expect((await send()).delivery).toMatchObject({ status: "DONE" }); // replay is idempotent
      }),
      1,
      LAB_CRITERIA,
    );
    expect(rec.error).toBeUndefined();
    const s = await rowsFor(env.dealId!);
    expect(s.deal.state).toBe("VERIFYING");
    expect(s.deliveries).toBe(1);
    expect(s.runs).toBe(1);
    expect(s.deliverySteps.map((x) => x.status)).toEqual(["COMPLETED"]);
    expect(rec.facts.moneyOps).toEqual([]);
  });

  it("recovers with a freshly stamped manifest too (the seller corrects its clock)", async () => {
    let env!: CaseEnv;
    const rec = await runCase(
      lab,
      mk("T-B2-fresh", async (e) => {
        env = e;
        await e.journey();
        const stale = manifestFor(await e.row(), GOOD(), { submittedAt: new Date(e.w.clock.t + HOUR).toISOString() });
        expect((await e.w.orch.receiveDelivery({ dealId: e.dealId!, authenticatedSellerId: "seller-sim", manifest: stale, artifact: GOOD() })).delivery).toMatchObject({ reason: "TIMESTAMP_IN_FUTURE" });
        expect((await e.deliver(GOOD())).delivery).toMatchObject({ status: "DONE" });
      }),
      1,
      LAB_CRITERIA,
    );
    expect(rec.error).toBeUndefined();
    const s = await rowsFor(env.dealId!);
    expect([s.deal.state, s.deliveries, s.runs]).toEqual(["VERIFYING", 1, 1]);
  });

  it("concurrent and replayed deliveries create exactly one delivery and one verification, and move no money", async () => {
    let env!: CaseEnv;
    const rec = await runCase(
      lab,
      mk("T-B2-concurrent", async (e) => {
        env = e;
        await e.journey();
        const manifest = manifestFor(await e.row(), GOOD(), { submittedAt: e.w.now().toISOString() });
        const send = () => e.w.orch.receiveDelivery({ dealId: e.dealId!, authenticatedSellerId: "seller-sim", manifest, artifact: GOOD() });
        const out = await Promise.all([...Array.from({ length: 8 }, send), ...Array.from({ length: 4 }, () => e.w.orch.advance(e.dealId!))]);
        expect(out.slice(0, 8).some((o) => (o as { delivery: { status: string } }).delivery.status === "DONE")).toBe(true);
        await send();
        await e.w.orch.advance(e.dealId!);
      }),
      1,
      LAB_CRITERIA,
    );
    expect(rec.error).toBeUndefined();
    const s = await rowsFor(env.dealId!);
    expect([s.deal.state, s.deliveries, s.runs]).toEqual(["VERIFYING", 1, 1]);
    expect(rec.facts.moneyOps).toEqual([]);
    expect(rec.facts.ledgerViolations).toEqual([]);
  });
});

describe("the Lab no longer depends on wall-clock time, and refuses to report an environment stall as a result", () => {
  it("a default Lab delivery stamps the WORLD clock: a world 3 hours behind real time still lands (this is what flaked B2)", async () => {
    let env!: CaseEnv;
    const rec = await runCase(
      lab,
      mk("T-B2-lab-fix", async (e) => {
        env = e;
        await e.journey();
        e.w.clock.t -= 3 * HOUR;
        expect((await e.deliver(GOOD())).delivery).toMatchObject({ status: "DONE" });
        expect(e.manifest(await e.row(), GOOD()).submittedAt).toBe(e.w.now().toISOString());
      }),
      1,
      LAB_CRITERIA,
    );
    expect(rec.error).toBeUndefined();
    expect((await rowsFor(env.dealId!)).deal.state).toBe("VERIFYING");
    expect(rec.facts.deliveryOutcomes).toEqual(["DONE"]);
  });

  it("a run whose wall-clock duration exceeds the stall limit is reported as ENVIRONMENT_STALL (an error), never as a pass or a product result", async () => {
    const slow = mk("T-stall", async (e) => {
      await e.journey();
      await new Promise((r) => setTimeout(r, 400));
    });
    const stalled = await runCase(lab, slow, 1, LAB_CRITERIA, { stallMs: 150 });
    expect(stalled.error).toMatch(/^ENVIRONMENT_STALL/);
    expect(stalled.verdict.contained).toBe(false);
    expect(stalled.verdict.outcomeCorrect).toBe(false);
    const fine = await runCase(lab, slow, 1, LAB_CRITERIA, { stallMs: 60_000 });
    expect(fine.error).toBeUndefined();
  });
});
