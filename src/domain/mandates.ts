import type { PrismaClient } from "@prisma/client";
import {
  buildMandateDocument,
  mandateDigest,
  mandateDraftSchema,
  openSealedMandate,
  sealMandate,
  type MandateDocument,
} from "./mandate";
import type { SigningKeys } from "./signing";
import { safeEqual } from "../lib/session";
import type { KeyRegistry } from "./key-registry";
import { verifyV2MandateSeal, type MandateDocumentV2 } from "./mandate-v2";
import { gateStillValid, type V2GateOpen } from "./v2-release-gate";

export class ConfirmationMismatchError extends Error {}
export class NotFoundError extends Error {}

/** Step 1 of approval: validate the draft and return exactly what the human will be asked to confirm. */
export function previewMandate(principalId: string, draft: unknown): { document: MandateDocument; digest: string } {
  const parsed = mandateDraftSchema.parse(draft);
  const document = buildMandateDocument(principalId, parsed);
  return { document, digest: mandateDigest(document) };
}

/**
 * Step 2: the human explicitly confirms by echoing the digest of the exact document previewed.
 * Only then is the mandate sealed and persisted. Result is "human-approved, application-signed".
 */
export async function approveMandate(
  db: PrismaClient,
  p: { principalId: string; principalEmail: string; draft: unknown; confirmDigest: string; keys: SigningKeys; now?: Date },
) {
  const { document, digest } = previewMandate(p.principalId, p.draft);
  if (!safeEqual(p.confirmDigest, digest)) throw new ConfirmationMismatchError("Confirmation digest does not match the mandate");
  const now = p.now ?? new Date();
  if (new Date(document.expiresAt) <= now) throw new Error("Mandate expiry must be in the future");
  const sealed = sealMandate(document, { approvedBy: p.principalEmail, approvedAt: now.toISOString(), approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" }, p.keys);
  return db.mandate.create({
    data: {
      principalId: p.principalId,
      currency: document.currency,
      budgetTotal: document.budgetTotal,
      perDealMax: document.perDealMax,
      requireHumanAbove: document.requireHumanAbove,
      allowedTaskTypes: document.allowedTaskTypes,
      counterparties: document.counterparties,
      injectionPolicy: document.injectionPolicy,
      expiresAt: new Date(document.expiresAt),
      canonicalJson: sealed.canonicalJson,
      mandateDigest: sealed.mandateDigest,
      approvedBy: sealed.approvedBy,
      approvedAt: new Date(sealed.approvedAt),
      approvalMethod: sealed.approvalMethod,
      keyVersion: sealed.keyVersion,
      signature: sealed.signature,
    },
  });
}

type MandateRow = Awaited<ReturnType<PrismaClient["mandate"]["findUniqueOrThrow"]>>;

/** Verify the V1 seal and return the document from the SIGNED bytes (never from loose columns). V2 rows are NOT readable here (null): use openMandateRow(). */
export function verifiedDocument(row: MandateRow, publicKeyB64: string): MandateDocument | null {
  if (row.sealVersion !== 1) return null;
  const doc = openSealedMandate(
    {
      canonicalJson: row.canonicalJson,
      mandateDigest: row.mandateDigest,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      approvalMethod: row.approvalMethod,
      keyVersion: row.keyVersion,
      signature: row.signature,
    },
    publicKeyB64,
  );
  return doc && doc.principalId === row.principalId ? doc : null;
}

/** What a verified mandate row yields. The two versions are DIFFERENT TYPES: a V2 document is not assignable to the V1 type. */
export type OpenedMandate =
  | { version: 1; doc: MandateDocument }
  | { version: 2; doc: MandateDocumentV2; mandateDigest: string; keyVersion: string; approvedBy: string; approvedAt: string };

export interface MandateKeyContext {
  /** V1 seals are verified with this single key (unchanged legacy behaviour) */
  publicKeyB64: string;
  /** V2 seals (and attestations) resolve keys ONLY here; without a registry no V2 mandate verifies */
  registry?: KeyRegistry;
  /** the V2 release gate (final directive part 7): without a valid, unexpired gate decision NO V2 mandate opens, whatever its signature says */
  v2Gate?: V2GateOpen;
}

/**
 * THE mandate opener (P3). Dispatches on the stored seal version, verifies, and returns the document from the SIGNED bytes. The sealVersion column is a hint only: it
 * selects the verifier, and a hint that disagrees with the signed bytes makes that verifier refuse (fail closed in both directions). Never throws; null = not trusted.
 */
export function openMandateRow(row: MandateRow, ctx: MandateKeyContext): OpenedMandate | null {
  if (row.sealVersion === 1) {
    const doc = verifiedDocument(row, ctx.publicKeyB64);
    return doc ? { version: 1, doc } : null;
  }
  if (row.sealVersion !== 2 || !ctx.registry || row.mandateNonce === null) return null;
  if (!gateStillValid(ctx.v2Gate, new Date())) return null; // V2 is disabled until the release gate is open
  const r = verifyV2MandateSeal(
    {
      sealVersion: 2,
      canonicalJson: row.canonicalJson,
      mandateDigest: row.mandateDigest,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt.toISOString(),
      approvalMethod: row.approvalMethod,
      keyVersion: row.keyVersion,
      signature: row.signature,
    },
    { registry: ctx.registry, expected: { mandateId: row.id, nonce: row.mandateNonce } },
  );
  if (!r.ok || r.document.principalId !== row.principalId) return null;
  // the mirrored detector-pin columns are query / audit hints: they must equal what the signature covers
  const dp = r.document.languagePolicy.detector;
  if (row.detectorId !== dp.id || row.detectorVersion !== dp.version || row.detectorVocabularyHash !== dp.vocabularyHash) return null;
  return { version: 2, doc: r.document, mandateDigest: r.mandateDigest, keyVersion: r.keyVersion, approvedBy: r.approvedBy, approvedAt: r.approvedAt };
}
