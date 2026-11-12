import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { CURRENCY, fmt, parseMoney, parsePositiveMoney } from "./money";
import { parseStrictJson, type StrictJsonErrorCode } from "../lib/strict-json";
import { signMessage, verifyMessage, type SigningKeys } from "./signing";

export const TASK_TYPES = ["data_cleaning"] as const;
export const INJECTION_POLICIES = ["HUMAN_REVIEW", "BLOCK"] as const;

const moneyStr = z.string().refine((s) => {
  try {
    parsePositiveMoney(s);
    return true;
  } catch {
    return false;
  }
}, "must be a positive USD amount with at most 2 decimals");

/** What the human fills in. Validated at the HTTP boundary. */
export const mandateDraftSchema = z
  .object({
    currency: z.literal(CURRENCY),
    budgetTotal: moneyStr,
    perDealMax: moneyStr,
    requireHumanAbove: moneyStr.optional(),
    allowedTaskTypes: z.array(z.enum(TASK_TYPES)).min(1),
    counterparties: z.array(z.string().min(1).max(64)).min(1),
    injectionPolicy: z.enum(INJECTION_POLICIES).default("HUMAN_REVIEW"),
    /** Pre-agreed permission for partial settlement. Still requires partial capture to be verified in Sandbox. */
    allowPartialSettlement: z.boolean().default(false),
    /** Cancellation terms: may the principal cancel (void) the authorization BEFORE delivery? System cancels are always allowed. */
    allowPreDeliveryCancellation: z.boolean().default(true),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((d, ctx) => {
    if (parseMoney(d.perDealMax).gt(parseMoney(d.budgetTotal)))
      ctx.addIssue({ code: "custom", message: "perDealMax must not exceed budgetTotal", path: ["perDealMax"] });
    if (d.requireHumanAbove && parseMoney(d.requireHumanAbove).gt(parseMoney(d.perDealMax)))
      ctx.addIssue({ code: "custom", message: "requireHumanAbove must not exceed perDealMax", path: ["requireHumanAbove"] });
  });
export type MandateDraft = z.infer<typeof mandateDraftSchema>;

/** The exact, normalized document that is hashed and sealed. */
export interface MandateDocument {
  /** type-level only: a V1 document never carries a schemaVersion, so a V2 document (schemaVersion: 2) is NOT assignable to this type and cannot reach the policy or settlement engines by accident */
  schemaVersion?: never;
  principalId: string;
  currency: "USD";
  budgetTotal: string;
  perDealMax: string;
  requireHumanAbove: string | null;
  allowedTaskTypes: string[];
  counterparties: string[];
  injectionPolicy: (typeof INJECTION_POLICIES)[number];
  /** absent in the oldest stored documents (see MandateShape); an absent flag reads as "not granted" everywhere it is consumed */
  allowPartialSettlement?: boolean;
  /** absent in older stored documents (see MandateShape); only an explicit true grants pre-delivery cancellation */
  allowPreDeliveryCancellation?: boolean;
  expiresAt: string;
}

const uniqSorted = (a: string[]) => [...new Set(a)].sort();

export function buildMandateDocument(principalId: string, draft: MandateDraft): MandateDocument {
  return {
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
  };
}

export const mandateDigest = (doc: MandateDocument): string => sha256Hex(canonicalJson(doc));

export interface Approval {
  approvedBy: string;
  approvedAt: string; // ISO
  approvalMethod: string;
}

export interface SealedMandate {
  canonicalJson: string;
  mandateDigest: string;
  approvedBy: string;
  approvedAt: string;
  approvalMethod: string;
  keyVersion: string;
  signature: string;
}

const sealPayload = (digest: string, a: Approval, keyVersion: string) =>
  canonicalJson({ approvalMethod: a.approvalMethod, approvedAt: a.approvedAt, approvedBy: a.approvedBy, digest, keyVersion });

/** Seal a human-approved mandate. Caller must already have verified the human's explicit confirmation. */
export function sealMandate(doc: MandateDocument, approval: Approval, keys: SigningKeys): SealedMandate {
  const digest = mandateDigest(doc);
  return {
    canonicalJson: canonicalJson(doc),
    mandateDigest: digest,
    ...approval,
    keyVersion: keys.keyVersion,
    signature: signMessage(sealPayload(digest, approval, keys.keyVersion), keys.privateKeyB64),
  };
}

// ------------------------------------------------------------------------------------------------------ strict, version-aware reader (P1)
/**
 * The three historical shapes of a stored mandate document. None carries a version field; they differ ONLY in which of the two behaviour flags exist, because the
 * flags were added over time. Each is recognised structurally and unambiguously; anything else is refused (never guessed, never defaulted, never rewritten).
 */
export const MANDATE_V1_SHAPES = ["V1_FULL", "V1_NO_CANCELLATION_FLAG", "V1_BASE"] as const;
export type MandateShape = (typeof MANDATE_V1_SHAPES)[number];
const BASE_KEYS = ["principalId", "currency", "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", "counterparties", "injectionPolicy", "expiresAt"] as const;
const FLAG_PARTIAL = "allowPartialSettlement";
const FLAG_CANCEL = "allowPreDeliveryCancellation";

export type MandateReadCode = StrictJsonErrorCode | "NOT_AN_OBJECT" | "UNSUPPORTED_SCHEMA_VERSION" | "UNKNOWN_FIELD" | "MISSING_FIELD" | "UNRECOGNISED_SHAPE" | "INVALID_FIELD";
export type MandateRead = { ok: true; doc: MandateDocument; shape: MandateShape } | { ok: false; code: MandateReadCode };

const mandateFields = {
  principalId: z.string().min(1).max(128),
  currency: z.literal(CURRENCY),
  budgetTotal: moneyStr,
  perDealMax: moneyStr,
  requireHumanAbove: moneyStr.nullable(),
  allowedTaskTypes: z.array(z.enum(TASK_TYPES)).min(1),
  counterparties: z.array(z.string().min(1).max(64)).min(1),
  injectionPolicy: z.enum(INJECTION_POLICIES),
  expiresAt: z.iso.datetime(),
};
const SHAPE_SCHEMAS: Record<MandateShape, z.ZodType<MandateDocument>> = {
  V1_FULL: z.strictObject({ ...mandateFields, [FLAG_PARTIAL]: z.boolean(), [FLAG_CANCEL]: z.boolean() }) as unknown as z.ZodType<MandateDocument>,
  V1_NO_CANCELLATION_FLAG: z.strictObject({ ...mandateFields, [FLAG_PARTIAL]: z.boolean() }) as unknown as z.ZodType<MandateDocument>,
  V1_BASE: z.strictObject(mandateFields) as unknown as z.ZodType<MandateDocument>,
};

/**
 * Parse stored mandate document text into a trusted MandateDocument, or refuse. Order: (1) strict JSON (duplicate keys, __proto__, malformed, bounds) ->
 * (2) must be a plain object -> (3) ANY explicit `schemaVersion` is a version this code does not support (future documents are never read as V1) ->
 * (4) unknown keys are refused, never stripped -> (5) missing base keys refused -> (6) the flag combination must be one of the three known shapes ->
 * (7) the shape's strict schema validates every value. The result is the schema's output; nothing is cast, and no key is added to or removed from a legacy shape.
 */
export function readMandateDocument(text: unknown): MandateRead {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const v = parsed.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, code: "NOT_AN_OBJECT" };
  const keys = Object.keys(v);
  if (keys.includes("schemaVersion")) return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" };
  const known = new Set<string>([...BASE_KEYS, FLAG_PARTIAL, FLAG_CANCEL]);
  if (keys.some((k) => !known.has(k))) return { ok: false, code: "UNKNOWN_FIELD" };
  if (BASE_KEYS.some((k) => !keys.includes(k))) return { ok: false, code: "MISSING_FIELD" };
  const partial = keys.includes(FLAG_PARTIAL);
  const cancel = keys.includes(FLAG_CANCEL);
  const shape: MandateShape | null = partial && cancel ? "V1_FULL" : partial ? "V1_NO_CANCELLATION_FLAG" : !cancel ? "V1_BASE" : null;
  if (shape === null) return { ok: false, code: "UNRECOGNISED_SHAPE" };
  const checked = SHAPE_SCHEMAS[shape].safeParse(v);
  return checked.success ? { ok: true, doc: checked.data, shape } : { ok: false, code: "INVALID_FIELD" };
}

export type OpenSealedResult = { ok: true; doc: MandateDocument; shape: MandateShape } | { ok: false; code: "DIGEST_MISMATCH" | "SIGNATURE_INVALID" | MandateReadCode };

/**
 * Verify the seal (V1 cryptography, unchanged: same digest rule, same signed payload, same order) and return the document read STRICTLY from the signed bytes.
 * Limits must be read from this result, never from loose database columns that someone could have edited.
 */
export function openSealedMandateDetailed(s: SealedMandate, publicKeyB64: string): OpenSealedResult {
  if (sha256Hex(s.canonicalJson) !== s.mandateDigest) return { ok: false, code: "DIGEST_MISMATCH" };
  const ok = verifyMessage(
    sealPayload(s.mandateDigest, { approvedBy: s.approvedBy, approvedAt: s.approvedAt, approvalMethod: s.approvalMethod }, s.keyVersion),
    s.signature,
    publicKeyB64,
  );
  if (!ok) return { ok: false, code: "SIGNATURE_INVALID" };
  return readMandateDocument(s.canonicalJson);
}

export function openSealedMandate(s: SealedMandate, publicKeyB64: string): MandateDocument | null {
  const r = openSealedMandateDetailed(s, publicKeyB64);
  return r.ok ? r.doc : null;
}
