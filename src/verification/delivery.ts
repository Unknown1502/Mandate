/**
 * Delivery ingestion. The seller sends a manifest + the artifact BYTES; nothing here reads the filesystem, executes anything, builds
 * SQL/shell commands from content, or lets the seller touch the locked terms. Every rejection is ledgered by code only (never by content).
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { StaleStateError, transitionDeal } from "../domain/deals";
import { appendEvent } from "../domain/ledger";
import { readLockedTermsOrThrow, termsMatchLockAny } from "../domain/terms-v2";
import { DEFAULT_MAX_ARTIFACT_BYTES, deliveryManifestSchema } from "./contracts";
import { CsvError, PARSER_VERSION, decodeUtf8Strict, parseCsv, DEFAULT_LIMITS, type CsvLimits } from "./csv";

export interface DeliveryDeps {
  db: PrismaClient;
  maxArtifactBytes?: number;
  limits?: CsvLimits;
  now?: () => Date;
}

export type DeliveryResult =
  | { ok: true; deliveryId: string; idempotent: boolean; rowCount: number; columnCount: number }
  | { ok: false; code: string };

const SKEW_MS = 5 * 60_000;

/** Magic numbers of common non-text formats. A file labelled text/csv that starts like one of these is refused outright. */
function looksBinary(b: Uint8Array): boolean {
  const h = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  return h(0x50, 0x4b, 0x03, 0x04) || h(0x25, 0x50, 0x44, 0x46) || h(0x7f, 0x45, 0x4c, 0x46) || h(0x4d, 0x5a) || h(0x1f, 0x8b) || h(0x89, 0x50, 0x4e, 0x47) || h(0xd0, 0xcf, 0x11, 0xe0) || h(0x23, 0x21); // zip/xlsx, pdf, elf, exe, gzip, png, ole, shebang
}

export async function submitDelivery(
  d: DeliveryDeps,
  p: { dealId: string; authenticatedSellerId: string; manifest: unknown; artifact: Uint8Array },
): Promise<DeliveryResult> {
  const now = (d.now ?? (() => new Date()))();
  const maxBytes = d.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

  const deal = await d.db.deal.findUnique({ where: { id: p.dealId }, include: { delivery: true } });
  const reject = async (code: string): Promise<DeliveryResult> => {
    if (deal) await d.db.$transaction((tx) => appendEvent(tx, deal.id, "DELIVERY_REJECTED", `seller:${p.authenticatedSellerId.slice(0, 40)}`, { code }));
    return { ok: false, code };
  };
  if (!deal) return { ok: false, code: "DEAL_NOT_FOUND" };

  const parsed = deliveryManifestSchema.safeParse(p.manifest);
  if (!parsed.success) return reject("MANIFEST_INVALID");
  const m = parsed.data;
  const manifestHash = sha256Hex(canonicalJson(m));

  if (m.dealId !== deal.id) return reject("DEAL_ID_MISMATCH");
  if (!deal.termsHash || !deal.termsJson || !termsMatchLockAny(deal.termsJson, deal.termsHash)) return reject("TERMS_NOT_LOCKED");
  if (m.termsHash !== deal.termsHash) return reject("TERMS_HASH_MISMATCH");
  const terms = readLockedTermsOrThrow(deal.termsJson);
  if (m.sellerPrincipalId !== terms.sellerId || p.authenticatedSellerId !== terms.sellerId || deal.sellerId !== terms.sellerId) return reject("SELLER_MISMATCH");

  // Duplicate / replay handling comes before state checks: an identical resubmission is idempotent, a different one is refused.
  if (deal.delivery) {
    const same = deal.delivery.artifactSha256 === m.artifactSha256 && deal.delivery.manifestHash === manifestHash;
    return same ? { ok: true, deliveryId: deal.delivery.id, idempotent: true, ...summaryOf(deal.delivery.parseSummaryJson) } : reject("DUPLICATE_DELIVERY");
  }
  if (deal.state !== "AWAITING_DELIVERY") return reject(`STATE_${deal.state}`);

  const submittedAt = new Date(m.submittedAt);
  if (submittedAt.getTime() > now.getTime() + SKEW_MS) return reject("TIMESTAMP_IN_FUTURE");
  if (now.getTime() > new Date(terms.deadline).getTime()) return reject("DELIVERY_AFTER_DEADLINE");

  if (!p.artifact || p.artifact.length === 0) return reject("ARTIFACT_MISSING");
  if (p.artifact.length > maxBytes) return reject("ARTIFACT_TOO_LARGE"); // before hashing or parsing anything
  if (p.artifact.length !== m.artifactSize) return reject("ARTIFACT_SIZE_MISMATCH");
  if (createHash("sha256").update(p.artifact).digest("hex") !== m.artifactSha256) return reject("ARTIFACT_HASH_MISMATCH"); // tampered in transit
  if (looksBinary(p.artifact)) return reject("UNSUPPORTED_FORMAT");

  let text: string;
  let csv;
  try {
    text = decodeUtf8Strict(p.artifact);
    csv = parseCsv(text, d.limits ?? DEFAULT_LIMITS);
  } catch (e) {
    return reject(e instanceof CsvError ? `CSV_${e.code}` : "CSV_INVALID");
  }
  const parseSummary = { rowCount: csv.rows.length, columnCount: csv.headers.length };

  try {
    const delivery = await d.db.$transaction(async (tx) => {
      const row = await tx.delivery.create({
        data: {
          dealId: deal.id,
          sellerPrincipalId: m.sellerPrincipalId,
          termsHash: m.termsHash,
          artifactReference: m.artifactReference,
          artifactSha256: m.artifactSha256,
          artifactSize: m.artifactSize,
          mediaType: m.mediaType,
          artifactText: text,
          manifestJson: m as unknown as Prisma.InputJsonValue,
          manifestHash,
          submittedAt,
          parserVersion: PARSER_VERSION,
          parseSummaryJson: parseSummary,
        },
      });
      await transitionDeal(tx, deal.id, "DELIVERED", `seller:${m.sellerPrincipalId}`, { deliveryId: row.id });
      await appendEvent(tx, deal.id, "DELIVERY_RECEIVED", `seller:${m.sellerPrincipalId}`, {
        deliveryId: row.id,
        artifactSha256: m.artifactSha256,
        artifactSize: m.artifactSize,
        artifactReference: m.artifactReference,
        manifestHash,
        parserVersion: PARSER_VERSION,
        ...parseSummary,
      });
      return row;
    });
    return { ok: true, deliveryId: delivery.id, idempotent: false, ...parseSummary };
  } catch (e) {
    // A concurrent submission won the unique(dealId) / state race.
    if ((e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") {
      const existing = await d.db.delivery.findUnique({ where: { dealId: deal.id } });
      if (existing && existing.artifactSha256 === m.artifactSha256 && existing.manifestHash === manifestHash) return { ok: true, deliveryId: existing.id, idempotent: true, ...parseSummary };
      return reject("DUPLICATE_DELIVERY");
    }
    throw e;
  }
}

function summaryOf(j: unknown): { rowCount: number; columnCount: number } {
  const s = j as { rowCount?: number; columnCount?: number } | null;
  return { rowCount: s?.rowCount ?? 0, columnCount: s?.columnCount ?? 0 };
}
