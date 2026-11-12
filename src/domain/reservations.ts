/**
 * Reservation expiry and cleanup (P5). A budget reservation is a claim on the mandate's budget; a claim that outlives its purpose starves later deals.
 *
 * Releasing is the SAFE direction: it can only free budget, never move money, and a deal that loses its reservation before an order exists simply cannot proceed
 * (createPayPalOrder refuses without an ACTIVE reservation). Rules, each applied per deal under the mandate row lock with compare-and-set transitions:
 *   A. defence in depth: an ACTIVE reservation whose deal is already terminal WITHOUT a capture (BLOCKED, EXPIRED, FAILED, VOIDED) is released.
 *   B. an unfinished PRE-ORDER deal (POLICY_CHECKED, or NEEDS_HUMAN raised from POLICY_CHECKED) that has been idle longer than idleTtlMs, or whose mandate has expired,
 *      is BLOCKED (reason RESERVATION_IDLE_EXPIRED / MANDATE_EXPIRED) and its reservation released.
 * A deal with a PayPal order or authorization is never touched here: those are handled by the settlement engine's own expiry and reconciliation paths.
 */
import type { PrismaClient } from "@prisma/client";
import { lockMandate, releaseReservation } from "./budget";
import { transitionDeal } from "./deals";
import { appendEvent } from "./ledger";

const SWEEP = "reservation-sweeper";
const NON_CAPTURE_TERMINAL = ["BLOCKED", "EXPIRED", "FAILED", "VOIDED"] as const;

export interface SweepResult {
  releasedTerminal: string[];
  blockedIdle: string[];
}

export async function sweepReservations(db: PrismaClient, p: { now: Date; idleTtlMs: number; limit?: number; /** restrict the sweep to one mandate (operational scoping; omit to sweep everything) */ mandateId?: string }): Promise<SweepResult> {
  const out: SweepResult = { releasedTerminal: [], blockedIdle: [] };
  const limit = Math.min(Math.max(p.limit ?? 200, 1), 1000);

  // Rule A
  const terminal = await db.budgetReservation.findMany({ where: { status: "ACTIVE", ...(p.mandateId ? { mandateId: p.mandateId } : {}), deal: { state: { in: [...NON_CAPTURE_TERMINAL] } } }, take: limit });
  for (const r of terminal) {
    await db.$transaction(async (tx) => {
      await lockMandate(tx, r.mandateId);
      const fresh = await tx.budgetReservation.findUnique({ where: { id: r.id }, include: { deal: true } });
      if (!fresh || fresh.status !== "ACTIVE" || !(NON_CAPTURE_TERMINAL as readonly string[]).includes(fresh.deal.state)) return;
      await releaseReservation(tx, fresh.dealId);
      await appendEvent(tx, fresh.dealId, "RESERVATION_RELEASED_BY_SWEEP", SWEEP, { reason: `DEAL_${fresh.deal.state}` });
      out.releasedTerminal.push(fresh.dealId);
    });
  }

  // Rule B
  const cutoff = new Date(p.now.getTime() - p.idleTtlMs);
  const idle = await db.deal.findMany({
    where: {
      ...(p.mandateId ? { mandateId: p.mandateId } : {}),
      reservations: { some: { status: "ACTIVE" } },
      paypalOrderId: null,
      OR: [{ state: "POLICY_CHECKED" }, { state: "NEEDS_HUMAN", needsHumanFrom: "POLICY_CHECKED" }],
    },
    include: { mandate: true },
    take: limit,
  });
  for (const d of idle) {
    const mandateExpired = d.mandate.expiresAt <= p.now;
    if (!mandateExpired && d.updatedAt > cutoff) continue;
    await db.$transaction(async (tx) => {
      await lockMandate(tx, d.mandateId);
      const fresh = await tx.deal.findUnique({ where: { id: d.id } });
      if (!fresh || fresh.paypalOrderId !== null || !(fresh.state === "POLICY_CHECKED" || (fresh.state === "NEEDS_HUMAN" && fresh.needsHumanFrom === "POLICY_CHECKED"))) return;
      await transitionDeal(tx, d.id, "BLOCKED", SWEEP, { reason: mandateExpired ? "MANDATE_EXPIRED" : "RESERVATION_IDLE_EXPIRED" });
      await releaseReservation(tx, d.id);
      out.blockedIdle.push(d.id);
    }).catch((e: Error) => {
      // a concurrent actor moved the deal first: the compare-and-set protected it, nothing to do
      if (e.name !== "StaleStateError" && e.name !== "IllegalTransitionError") throw e;
    });
  }
  return out;
}
