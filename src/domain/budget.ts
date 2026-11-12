import { D, type Money } from "./money";
import type { Tx } from "./ledger";

/** committed = SUM(amount) over ACTIVE and CONVERTED reservations (converted amount = captured amount). */
export async function committedFor(tx: Tx, mandateId: string, excludeDealId?: string): Promise<Money> {
  const rows = await tx.budgetReservation.findMany({
    where: { mandateId, status: { in: ["ACTIVE", "CONVERTED"] }, ...(excludeDealId ? { dealId: { not: excludeDealId } } : {}) },
    select: { amount: true },
  });
  return rows.reduce<Money>((s, r) => s.add(new D(r.amount.toString())), new D(0));
}

/** Serialize all budget decisions for one mandate. Must be the first statement of the transaction. */
export async function lockMandate(tx: Tx, mandateId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Mandate" WHERE id = ${mandateId} FOR UPDATE`;
  if (rows.length === 0) throw new Error(`Mandate ${mandateId} not found`);
}

export type ReserveResult = { ok: true; created: boolean } | { ok: false; reason: "BUDGET_EXCEEDED" };

/**
 * Atomically reserve `amount` for the deal. Caller must have called lockMandate() in the same transaction.
 * Idempotent per deal (unique dealId): a repeat returns the existing ACTIVE reservation.
 */
export async function reserve(tx: Tx, p: { mandateId: string; dealId: string; amount: Money; budgetTotal: Money }): Promise<ReserveResult> {
  const existing = await tx.budgetReservation.findUnique({ where: { dealId: p.dealId } });
  if (existing) {
    if (existing.status === "ACTIVE") return { ok: true, created: false };
    throw new Error(`Reservation for deal ${p.dealId} is ${existing.status}; cannot re-reserve`);
  }
  const committed = await committedFor(tx, p.mandateId);
  if (committed.add(p.amount).gt(p.budgetTotal)) return { ok: false, reason: "BUDGET_EXCEEDED" };
  await tx.budgetReservation.create({
    data: { mandateId: p.mandateId, dealId: p.dealId, amount: p.amount.toFixed(2), status: "ACTIVE" },
  });
  return { ok: true, created: true };
}

/** On confirmed settlement: record the captured amount (releasing the unused remainder implicitly). */
export async function convertReservation(tx: Tx, dealId: string, capturedAmount: Money): Promise<void> {
  const r = await tx.budgetReservation.updateMany({
    where: { dealId, status: "ACTIVE" },
    data: { status: "CONVERTED", amount: capturedAmount.toFixed(2) },
  });
  if (r.count !== 1) throw new Error(`No ACTIVE reservation to convert for deal ${dealId}`);
}

export async function releaseReservation(tx: Tx, dealId: string): Promise<void> {
  await tx.budgetReservation.updateMany({ where: { dealId, status: "ACTIVE" }, data: { status: "RELEASED" } });
}
