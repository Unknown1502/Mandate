/**
 * Deterministic bargaining policy for the BUYER side of a negotiation. Pure functions over Money: no database, no model, no I/O.
 * The orchestrator uses it twice: (1) to compute the price range it TELLS the Buyer Agent about, and (2) to VALIDATE every offer the agent (or an injected attacker)
 * produces. The mandate's ceiling is the hard limit; this module only makes the path to it controlled:
 *   - the opening offer is at or below the buyer's target (never above it);
 *   - a counteroffer is allowed only after the seller has named a price (so the seller's last ask exists);
 *   - a counteroffer never retreats below the buyer's own last offer, never exceeds the seller's last ask, never exceeds the ceiling,
 *     and moves at most half of the remaining gap per round (a controlled concession).
 */
import Decimal from "decimal.js";
import { D, minMoney, type Money } from "./money";

export interface Bounds {
  min: Money;
  max: Money;
}

const cents = (m: Money): Money => m.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** the highest opening offer: the target, and never above the ceiling */
export function openingMax(target: Money, ceiling: Money): Money {
  return minMoney(target, ceiling);
}

/** a suggested opening (about 90% of the target, to leave room to concede); guidance only, the enforced limit is openingMax */
export function openingGuide(target: Money, ceiling: Money): Money {
  return cents(openingMax(target, ceiling).mul("0.9"));
}

/**
 * The allowed range for a counteroffer, or null when none exists (no seller ask yet). `lastBuyerPrice` is the buyer's previous offer.
 * min = the buyer's own last offer (or the seller's ask if that is lower: then the buyer should simply accept);
 * max = the lowest of the ceiling, the seller's last ask, and the midpoint between the buyer's last offer and the seller's ask.
 */
export function counterBounds(s: { ceiling: Money; lastBuyerPrice?: Money; lastSellerPrice?: Money }): Bounds | null {
  if (!s.lastSellerPrice) return null;
  const ask = s.lastSellerPrice;
  const mine = s.lastBuyerPrice;
  if (!mine) return { min: new D(0), max: minMoney(s.ceiling, ask) };
  const mid = ask.gt(mine) ? cents(mine.plus(ask.minus(mine).div(2))) : ask;
  return { min: minMoney(mine, ask), max: minMoney(minMoney(s.ceiling, ask), mid) };
}
