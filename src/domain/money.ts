import Decimal from "decimal.js";

/** Isolated Decimal constructor: round-down, high precision, no global mutation. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
export type Money = InstanceType<typeof D>;

export const CURRENCY = "USD" as const;
const MONEY_RE = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;

/** Parse a decimal STRING with at most 2 decimals. Numbers (floats) are rejected by type. */
export function parseMoney(s: string): Money {
  if (typeof s !== "string" || !MONEY_RE.test(s)) throw new Error("Invalid money string");
  return new D(s);
}

export function parsePositiveMoney(s: string): Money {
  const m = parseMoney(s);
  if (m.lte(0)) throw new Error("Amount must be greater than zero");
  return m;
}

export const fmt = (m: Money): string => m.toFixed(2);

export function assertUsd(code: string): void {
  if (code !== CURRENCY) throw new Error(`Unsupported currency ${code}; only USD`);
}

/** price * earned / 100, rounded DOWN to cents. earned must be an integer in [0,100]. */
export function proportion(price: Money, earned: number): Money {
  if (!Number.isInteger(earned) || earned < 0 || earned > 100) throw new Error("earned must be an integer 0..100");
  return price.mul(earned).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

export const minMoney = (a: Money, b: Money): Money => (a.lte(b) ? a : b);
