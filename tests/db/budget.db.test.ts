/** DB-tested against real PostgreSQL (mandate_test): atomic budget reservation under concurrency. */
import { describe, expect, it } from "vitest";
import { checkPolicy, reserveForDeal } from "@/domain/deals";
import { committedFor, convertReservation, releaseReservation } from "@/domain/budget";
import { D } from "@/domain/money";
import { deps, dealWithLockedTerms, makeMandate, makePrincipal, prisma } from "./fixtures";

async function readyDeals(n: number, budget: string, price: string) {
  const p = await makePrincipal();
  const m = await makeMandate(p, { budgetTotal: budget, perDealMax: budget, requireHumanAbove: undefined });
  const deals = [];
  for (let i = 0; i < n; i++) {
    const d = await dealWithLockedTerms(p, m.id, { price });
    deals.push(d);
  }
  // Move every deal to POLICY_CHECKED while nothing is reserved yet, so they compete at reservation time.
  for (const d of deals) await checkPolicy(prisma, { dealId: d.id, deps });
  return { p, m, deals };
}

describe("atomic budget reservation", () => {
  it("two concurrent deals cannot both reserve the same remaining budget", async () => {
    const { deals } = await readyDeals(2, "100", "60.00");
    const results = await Promise.all(deals.map((d) => reserveForDeal(prisma, { dealId: d.id, deps })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)[0]).toMatchObject({ ok: false, reasons: expect.arrayContaining(["BUDGET_EXCEEDED"]) });
  });

  it("10 concurrent deals of 20 against a 100 budget: exactly 5 win and the total never exceeds the budget", async () => {
    const { m, deals } = await readyDeals(10, "100", "20.00");
    const results = await Promise.all(deals.map((d) => reserveForDeal(prisma, { dealId: d.id, deps })));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const committed = await prisma.$transaction((tx) => committedFor(tx, m.id));
    expect(committed.toFixed(2)).toBe("100.00");
  });

  it("reserving the same deal twice is idempotent (one row)", async () => {
    const { deals } = await readyDeals(1, "100", "20.00");
    const a = await reserveForDeal(prisma, { dealId: deals[0]!.id, deps });
    const b = await reserveForDeal(prisma, { dealId: deals[0]!.id, deps });
    expect(a).toEqual({ ok: true, created: true });
    expect(b).toEqual({ ok: true, created: false });
    expect(await prisma.budgetReservation.count({ where: { dealId: deals[0]!.id } })).toBe(1);
  });

  it("conversion records the captured amount and frees the unused remainder; release frees everything", async () => {
    const { m, deals } = await readyDeals(2, "100", "60.00");
    await reserveForDeal(prisma, { dealId: deals[0]!.id, deps });
    expect((await prisma.$transaction((tx) => committedFor(tx, m.id))).toFixed(2)).toBe("60.00");
    await prisma.$transaction((tx) => convertReservation(tx, deals[0]!.id, new D("42.00")));
    expect((await prisma.$transaction((tx) => committedFor(tx, m.id))).toFixed(2)).toBe("42.00");
    // 42 captured + 60 requested = 102 > 100: still refused. The unused 18 is only freed once the conversion happened.
    expect(await reserveForDeal(prisma, { dealId: deals[1]!.id, deps })).toMatchObject({ ok: false, reasons: expect.arrayContaining(["BUDGET_EXCEEDED"]) });
  });

  it("after conversion the freed remainder becomes available to a smaller deal", async () => {
    const { m, deals } = await readyDeals(1, "100", "60.00");
    await reserveForDeal(prisma, { dealId: deals[0]!.id, deps });
    await prisma.$transaction((tx) => convertReservation(tx, deals[0]!.id, new D("42.00")));
    const small = await dealWithLockedTerms({ id: m.principalId }, m.id, { price: "58.00" });
    expect((await checkPolicy(prisma, { dealId: small.id, deps })).outcome).toBe("OK"); // 42 + 58 = 100
    expect(await reserveForDeal(prisma, { dealId: small.id, deps })).toMatchObject({ ok: true });
  });

  it("released reservations stop counting", async () => {
    const { m, deals } = await readyDeals(1, "100", "60.00");
    await reserveForDeal(prisma, { dealId: deals[0]!.id, deps });
    await prisma.$transaction((tx) => releaseReservation(tx, deals[0]!.id));
    expect((await prisma.$transaction((tx) => committedFor(tx, m.id))).toFixed(2)).toBe("0.00");
  });
});
