import { createHash } from "node:crypto";
import type { Criterion } from "@/domain/terms";
import { toCsv } from "@/verification/csv";
import { submitDelivery, type DeliveryDeps } from "@/verification/delivery";
import { MockPayPal } from "../helpers/mockPayPal";
import { authorizedDeal, makeCtx, prisma, type Setup } from "./engineFixtures";

export { prisma, makeCtx, MockPayPal };

export const HEADERS = ["id", "email", "joined"];
export const GOOD_ROWS = [
  ["1", "a@x.com", "2024-01-05"],
  ["2", "b@x.com", "2024-02-29"],
  ["3", "c@x.com", "2023-12-31"],
  ["4", "d@x.com", "2024-03-10"],
  ["5", "e@x.com", "2024-04-01"],
];

const d = (id: string, validator: string, params: Record<string, unknown>, required: boolean, weight: number): Criterion => ({ id, text: `${id} check`, type: "deterministic", validator: validator as never, params, required, weight });
/** weights sum to 100 */
export const DET: Criterion[] = [
  d("schema", "csv_schema_matches", { columns: HEADERS }, true, 40),
  d("dupes", "no_duplicate_rows", {}, true, 20),
  d("dates", "date_format_valid", { column: "joined", format: "YYYY-MM-DD" }, false, 20),
  d("missing", "null_rate_below", { maxMissingPercent: 20 }, false, 20),
];
export const MIXED: Criterion[] = [d("schema", "csv_schema_matches", { columns: HEADERS }, true, 50), { id: "quality", text: "The cleaned data looks consistent and plausible", type: "llm_judged", required: true, weight: 50 }];

export const csvBytes = (headers: string[], rows: string[][]) => Buffer.from(toCsv(headers, rows), "utf8");
export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const GOOD = () => csvBytes(HEADERS, GOOD_ROWS);

export function manifestFor(deal: { id: string; termsHash: string | null }, artifact: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    dealId: deal.id,
    termsHash: deal.termsHash!,
    sellerPrincipalId: "seller-sim",
    artifactReference: "cleaned.csv",
    artifactSha256: sha256(artifact),
    artifactSize: artifact.length,
    mediaType: "text/csv",
    submittedAt: new Date().toISOString(),
    ...over,
  };
}

/** A deal in AWAITING_DELIVERY (authorized on the MOCK PayPal) with the given locked criteria. */
export async function awaitingDelivery(setup: Setup = {}, mock = new MockPayPal()) {
  const ctx = makeCtx(mock);
  const base = await authorizedDeal(mock, ctx, { criteria: DET, ...setup });
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } });
  return { mock, ctx, base, deal };
}

export async function deliver(
  dealId: string,
  artifact: Buffer,
  o: { manifest?: Record<string, unknown> | null; seller?: string; deps?: Partial<DeliveryDeps> } = {},
) {
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  return submitDelivery(
    { db: prisma, ...o.deps },
    { dealId, authenticatedSellerId: o.seller ?? "seller-sim", manifest: o.manifest === null ? undefined : { ...manifestFor(deal, artifact), ...(o.manifest ?? {}) }, artifact },
  );
}

/** Run `fn` with the immutability trigger disabled, to simulate someone with direct database access. Always re-enabled. */
export async function bypassingImmutability<T>(table: "Delivery" | "VerificationRun", fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_immutable"`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${table}_immutable"`);
  }
}
