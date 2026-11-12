/**
 * V2 mandate WRITER (P3; docs/15 sections 15.3.4, 15.5.2, 15.12): two-step human approval with exact canonical-digest confirmation, a pre-allocated mandate identity and
 * nonce inside the signed document, and the language policy as part of the signed scope.
 *
 * The V2 seal VERIFIER (mandate-v2.ts) stays the only authority on what is valid: every sealed mandate is verified by it before it is persisted, so a writer bug can
 * never store a seal the reader would refuse (and cannot store one it would accept wrongly, because the verifier rebuilds the signed bytes independently).
 * V1 writers (mandates.ts previewMandate/approveMandate) are untouched and keep producing V1 documents.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { safeEqual } from "../lib/session";
import { canonicalJson, sha256Hex } from "./canonical";
import { INJECTION_POLICIES, TASK_TYPES } from "./mandate";
import {
  buildV2SignedPayload,
  languagePolicyV1Schema,
  mandateDocumentV2Schema,
  MANDATE_ID_PATTERN,
  NONCE_PATTERN,
  V2_APPROVAL_METHOD,
  V2_SEAL_VERSION,
  verifyV2MandateSeal,
  type MandateDocumentV2,
  type SealedMandateV2,
} from "./mandate-v2";
import { CURRENCY, fmt, parseMoney, parsePositiveMoney } from "./money";
import { signMessage, type SigningKeys } from "./signing";
import { registryFromSigningKeys } from "./v2-keys";
import type { KeyRegistry } from "./key-registry";
import type { LanguagePolicy } from "./language-policy";
import { gateStillValid, type V2GateOpen } from "./v2-release-gate";

export class ConfirmationMismatchV2Error extends Error {}
export class DuplicateMandateError extends Error {}
export class MandateDraftIncompleteError extends Error {}
export class DetectorNotReleasedError extends Error {}
/** V2 is disabled until the release gate is open (final directive part 7) */
export class V2DisabledError extends Error {}

const moneyStr = z.string().refine((s) => {
  try {
    parsePositiveMoney(s);
    return true;
  } catch {
    return false;
  }
}, "must be a positive USD amount with at most 2 decimals");

/** What the human fills in for a V2 mandate. STRICT. The booleans have NO default (V2 makes every behaviour explicit). mandateId/nonce are issued by the PREVIEW. */
export const mandateDraftV2Schema = z
  .strictObject({
    currency: z.literal(CURRENCY),
    budgetTotal: moneyStr,
    perDealMax: moneyStr,
    requireHumanAbove: moneyStr.optional(),
    allowedTaskTypes: z.array(z.enum(TASK_TYPES)).min(1),
    counterparties: z.array(z.string().min(1).max(64)).min(1),
    injectionPolicy: z.enum(INJECTION_POLICIES),
    allowPartialSettlement: z.boolean(),
    allowPreDeliveryCancellation: z.boolean(),
    expiresAt: z.iso.datetime(),
    languagePolicy: languagePolicyV1Schema,
    mandateId: z.string().regex(MANDATE_ID_PATTERN).optional(),
    nonce: z.string().regex(NONCE_PATTERN).optional(),
  })
  .superRefine((d, ctx) => {
    try {
      if (parseMoney(d.perDealMax).gt(parseMoney(d.budgetTotal))) ctx.addIssue({ code: "custom", message: "perDealMax must not exceed budgetTotal", path: ["perDealMax"] });
      if (d.requireHumanAbove && parseMoney(d.requireHumanAbove).gt(parseMoney(d.perDealMax))) ctx.addIssue({ code: "custom", message: "requireHumanAbove must not exceed perDealMax", path: ["requireHumanAbove"] });
    } catch {
      ctx.addIssue({ code: "custom", message: "amount cannot be compared" });
    }
  });
export type MandateDraftV2 = z.infer<typeof mandateDraftV2Schema>;

const uniqSorted = (a: readonly string[]): string[] => [...new Set(a)].sort();

/** 25 chars: "c" + 24 of [a-z0-9] drawn from a CSPRNG (same shape as a cuid, so it is a valid primary key and matches the verifier's pattern). */
export function newMandateId(rng: (n: number) => Buffer = randomBytes): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = rng(24);
  let out = "c";
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
export const newMandateNonce = (rng: (n: number) => Buffer = randomBytes): string => rng(16).toString("hex");

export function buildMandateDocumentV2(principalId: string, draft: MandateDraftV2 & { mandateId: string; nonce: string }): MandateDocumentV2 {
  const doc = {
    schemaVersion: 2 as const,
    mandateId: draft.mandateId,
    nonce: draft.nonce,
    principalId,
    currency: draft.currency,
    budgetTotal: fmt(parseMoney(draft.budgetTotal)),
    perDealMax: fmt(parseMoney(draft.perDealMax)),
    requireHumanAbove: draft.requireHumanAbove ? fmt(parseMoney(draft.requireHumanAbove)) : null,
    allowedTaskTypes: uniqSorted(draft.allowedTaskTypes),
    counterparties: uniqSorted(draft.counterparties),
    injectionPolicy: draft.injectionPolicy,
    allowPartialSettlement: draft.allowPartialSettlement,
    allowPreDeliveryCancellation: draft.allowPreDeliveryCancellation,
    expiresAt: new Date(draft.expiresAt).toISOString(),
    languagePolicy: draft.languagePolicy,
    carryOver: null,
  };
  return mandateDocumentV2Schema.parse(doc); // the signed document is exactly what the strict schema accepts
}

export const mandateDigestV2 = (doc: MandateDocumentV2): string => sha256Hex(canonicalJson(doc));

/** Plain-language rendering of the exact document the human is asked to confirm (nothing truncated, nothing summarised away). */
export function renderMandatePreview(doc: MandateDocumentV2): string[] {
  const p = doc.languagePolicy;
  return [
    `Mandate ${doc.mandateId} (V2) for principal ${doc.principalId}`,
    `Budget total ${doc.budgetTotal} ${doc.currency}; per-deal maximum ${doc.perDealMax}; human review above ${doc.requireHumanAbove ?? "(no price threshold)"}`,
    `Allowed task types: ${doc.allowedTaskTypes.join(", ")}`,
    `Counterparties: ${doc.counterparties.join(", ")}`,
    `Injection policy: ${doc.injectionPolicy}; partial settlement ${doc.allowPartialSettlement ? "allowed" : "not allowed"}; pre-delivery cancellation ${doc.allowPreDeliveryCancellation ? "allowed" : "not allowed"}`,
    `Expires ${doc.expiresAt}`,
    `Language policy (a floor every deal under this mandate must meet or exceed): supported languages ${p.supportedLanguages.join(", ")}; detector ${p.detector.id}@${p.detector.version} (${p.detector.vocabularyHash})`,
    `Text in an unsupported language: ${p.unsupportedBehavior}; text whose language is uncertain: ${p.uncertainBehavior}; incomplete scan: ${p.incompleteScanBehavior}; name-like tokens in a model-visible field are treated as UNCERTAIN; short text is never exempt`,
    `Human review of language-triggered outcomes: ${p.humanReview.required ? "required" : "not required"}`,
    `Budget carry-over: none`,
    `Confirm only if you intend to authorise exactly this document (digest ${mandateDigestV2(doc)}). This approval is recorded and sealed by the application key; it is not a signature made with a key you hold.`,
  ];
}

export interface MandatePreviewV2 {
  document: MandateDocumentV2;
  digest: string;
  /** the draft completed with the issued mandateId and nonce: pass THIS (and the digest) to approveMandateV2 */
  draft: MandateDraftV2 & { mandateId: string; nonce: string };
  rendering: string[];
}

/** Step 1: validate, issue the identity (or keep the one already issued), and return exactly what the human will be asked to confirm. Read-only. */
export function previewMandateV2(principalId: string, draft: unknown, rng?: (n: number) => Buffer): MandatePreviewV2 {
  const parsed = mandateDraftV2Schema.parse(draft);
  const complete = { ...parsed, mandateId: parsed.mandateId ?? newMandateId(rng), nonce: parsed.nonce ?? newMandateNonce(rng) };
  const document = buildMandateDocumentV2(principalId, complete);
  return { document, digest: mandateDigestV2(document), draft: complete, rendering: renderMandatePreview(document) };
}

/** Seal a human-approved V2 mandate. Caller must already have verified the human's explicit confirmation. */
export function sealMandateV2(doc: MandateDocumentV2, approval: { approvedBy: string; approvedAt: string }, keys: SigningKeys): SealedMandateV2 {
  const text = canonicalJson(doc);
  const digest = sha256Hex(text);
  const env = { sealVersion: V2_SEAL_VERSION, mandateDigest: digest, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, approvalMethod: V2_APPROVAL_METHOD, keyVersion: keys.keyVersion } as const;
  const message = canonicalJson(buildV2SignedPayload(doc, env, "mandate-seal"));
  return { ...env, canonicalJson: text, signature: signMessage(message, keys.privateKeyB64) };
}

export interface ApproveMandateV2Params {
  principalId: string;
  principalEmail: string;
  draft: unknown;
  confirmDigest: string;
  keys: SigningKeys;
  now?: Date;
  /** P7: when supplied, the pinned detector must be a RELEASED, non-revoked entry (a mandate can only pin an approved release) */
  detectorPermitted?: (detector: LanguagePolicy["detector"], supported?: readonly string[]) => boolean;
  /** registry used for the pre-persist self-verification (defaults to the signing key alone) */
  registry?: KeyRegistry;
  /** REQUIRED to write a V2 mandate: the open release gate */
  v2Gate?: V2GateOpen;
}

/**
 * Step 2: the human echoes the digest of the exact document previewed. Only then is the mandate sealed, self-verified and persisted. Result is "human-approved,
 * application-signed". The draft MUST carry the mandateId and nonce issued by the preview (an approval never invents identity).
 */
export async function approveMandateV2(db: PrismaClient, p: ApproveMandateV2Params) {
  if (!gateStillValid(p.v2Gate, p.now ?? new Date())) throw new V2DisabledError("V2 is disabled: the release gate is not open");
  const parsed = mandateDraftV2Schema.parse(p.draft);
  if (!parsed.mandateId || !parsed.nonce) throw new MandateDraftIncompleteError("The draft must carry the mandateId and nonce issued by the preview");
  const document = buildMandateDocumentV2(p.principalId, { ...parsed, mandateId: parsed.mandateId, nonce: parsed.nonce });
  const digest = mandateDigestV2(document);
  if (!safeEqual(p.confirmDigest, digest)) throw new ConfirmationMismatchV2Error("Confirmation digest does not match the mandate");
  const now = p.now ?? new Date();
  if (new Date(document.expiresAt) <= now) throw new Error("Mandate expiry must be in the future");
  if (p.detectorPermitted && !p.detectorPermitted(document.languagePolicy.detector, document.languagePolicy.supportedLanguages)) throw new DetectorNotReleasedError("The pinned detector is not an approved release");

  const sealed = sealMandateV2(document, { approvedBy: p.principalEmail, approvedAt: now.toISOString() }, p.keys);
  // never persist a seal the verifier would refuse
  const check = verifyV2MandateSeal(sealed, { registry: p.registry ?? registryFromSigningKeys(p.keys), expected: { mandateId: document.mandateId, nonce: document.nonce } });
  if (!check.ok) throw new Error(`V2 seal self-verification failed: ${check.code}`);

  try {
    return await db.mandate.create({
      data: {
        id: document.mandateId,
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
        sealVersion: 2,
        schemaVersion: 2,
        languagePolicyHash: sha256Hex(canonicalJson(document.languagePolicy)),
        mandateNonce: document.nonce,
        detectorId: document.languagePolicy.detector.id,
        detectorVersion: document.languagePolicy.detector.version,
        detectorVocabularyHash: document.languagePolicy.detector.vocabularyHash,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new DuplicateMandateError("A mandate with this identity or nonce already exists");
    throw e;
  }
}
