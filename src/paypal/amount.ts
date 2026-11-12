import Decimal from "decimal.js";

/** Format a USD amount as the exact 2-decimal string PayPal expects. No floats. */
export function usd(value: string | Decimal): string {
  const d = new Decimal(value);
  if (!d.isFinite() || d.lte(0)) throw new Error("Amount must be a positive finite decimal");
  if (d.decimalPlaces() > 2) throw new Error("USD amounts allow at most 2 decimal places");
  return d.toFixed(2);
}
