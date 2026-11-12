/**
 * V2 mandate SEAL VERIFIER (P2; docs/15 sections 15.5.2, 15.5.3 and 15.24).
 *
 * SCOPE. This module can only VERIFY. It contains no signing function, never receives a private key and creates no document, so it is not a V2 writer. It is also
 * NOT CONNECTED to anything live: nothing in src/ imports it (tests/unit/v2-verifier-isolation.test.ts pins that), so a V2 document can neither authorize a deal nor
 * reach negotiation, verification, orchestration or settlement at P2. Its result type (MandateDocumentV2) is deliberately not assignable to the V1 MandateDocument that the
 * policy engine and the settlement engine consume. Operational use needs P3 and the later integration stages, each separately approved.
 *
 * WHAT IS VERIFIED (every step fails closed with a closed-enum code, in this order):
 *   1 dispatch        envelope is a plain object with sealVersion === 2 (an envelope without sealVersion is a V1 envelope: refused, never read as V2)
 *   2 envelope        strict shape: no unknown field (so no "algorithm" / "publicKey" field can be smuggled in), exact field formats
 *   3 digest          sha256(canonicalJson text) equals mandateDigest, compared in constant time
 *   4 strict JSON     duplicate keys at any depth (also escaped spellings), __proto__, malformed JSON, trailing content, depth / size bounds
 *   5 version peek    the document's own schemaVersion must be exactly 2 (a mismatch with sealVersion cannot be read as anything)
 *   6 canonical bytes canonicalJson(parsed) must equal the received text byte for byte; the text is never normalised, so the bytes authenticated are the bytes received
 *   7 strict schema   every field required and typed, no unknown field, canonical set ordering, canonical money and instants, languagePolicy and carryOver validated
 *   8 key             keyVersion resolved ONLY through the supplied registry (never a key from the document); algorithm, status and fingerprint checked
 *   9 signature       Ed25519 over canonicalJson(payload), where the payload is REBUILT here from the parsed document and the envelope (never from caller-supplied echoes)
 *  10 identity        the signed mandateId equals the external record id; the nonce equals the expected nonce when one is supplied
 * The signed payload is exactly the approved format (docs/15 section 15.5.2): purpose "mandate-seal", sealVersion, schemaVersion, keyVersion, mandateId, principalId,
 * mandateDigest, languagePolicyHash, carryOverHash, an explicit echo of every authorization field, approvedBy, approvedAt, approvalMethod.
 *
 * NOT CLAIMED. Nonce UNIQUENESS (replay of the same sealed mandate under another record) is a persistence property that needs a unique index and the V2 write path (a later
 * stage). This verifier validates the nonce's structure and its signed binding to the mandate, and compares it with an expected value when the caller has one.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseStrictJson } from "../lib/strict-json";
import { canonicalJson, sha256Hex } from "./canonical";
import { publicKeyFingerprint, type KeyRegistry } from "./key-registry";
import { INJECTION_POLICIES, TASK_TYPES } from "./mandate";
import { CURRENCY, parseMoney, parsePositiveMoney } from "./money";
import { verifyMessage } from "./signing";

export const V2_SEAL_PURPOSE = "mandate-seal";
export const V2_SEAL_VERSION = 2;
export const V2_APPROVAL_METHOD = "EXPLICIT_DIGEST_CONFIRMATION";
/** a Prisma cuid() as the Mandate row id is generated today: "c" + 24 base-36 characters */
export const MANDATE_ID_PATTERN = /^c[a-z0-9]{24}$/;
/** a sealed mandate document is about 1.2 KB; 32 KB is a generous bound (the envelope as a whole is bounded at 64 KB) */
const MAX_DOCUMENT_BYTES = 32_768;
/** 128-bit nonce, lowercase hex */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export const V2_SEAL_ERROR_CODES = [
  "ENVELOPE_MALFORMED",
  "UNSUPPORTED_SEAL_VERSION",
  "ENVELOPE_INVALID",
  "DIGEST_MISMATCH",
  "MALFORMED_JSON",
  "DUPLICATE_KEY",
  "FORBIDDEN_KEY",
  "TOO_DEEP",
  "TOO_LARGE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "NON_CANONICAL_DOCUMENT",
  "DOCUMENT_INVALID",
  "KEY_VERSION_UNKNOWN",
  "KEY_ALGORITHM_UNSUPPORTED",
  "KEY_DISABLED",
  "KEY_REVOKED",
  "KEY_FINGERPRINT_MISMATCH",
  "SIGNATURE_INVALID",
  "MANDATE_ID_MISMATCH",
  "NONCE_MISMATCH",
  /** an unexpected exception inside the verifier (hostile input that reached an unforeseen branch): refused, never propagated */
  "VERIFIER_ERROR",
] as const;
export type V2SealErrorCode = (typeof V2_SEAL_ERROR_CODES)[number];

// ------------------------------------------------------------------------------------------------------------------------------------ schemas
const money2 = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/).refine((s) => {
  try {
    parsePositiveMoney(s);
    return true;
  } catch {
    return false;
  }
}, "positive USD amount with exactly two decimals");
const canonicalInstant = z.iso.datetime().refine((s) => {
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
}, "canonical UTC instant with milliseconds");
/** a set written in canonical order: strictly ascending (so sorted AND duplicate-free) */
const strictlyAscending = (a: readonly string[]) => a.every((x, i) => i === 0 || a[i - 1]! < x);
const vocabularyHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const behaviour = z.enum(["UNVERIFIABLE_HUMAN_REVIEW", "REJECT_DELIVERY"]);

export const languagePolicyV1Schema = z.strictObject({
  schema: z.literal("mandate.languagePolicy/1"),
  policyVersion: z.literal(1),
  supportedLanguages: z.array(z.enum(["en", "fr", "zh"])).min(1).max(3).refine(strictlyAscending, "canonical order"),
  detector: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), vocabularyHash }),
  unsupportedBehavior: behaviour,
  uncertainBehavior: behaviour,
  nameLikeBehavior: z.literal("UNCERTAIN"),
  incompleteScanBehavior: behaviour,
  shortText: z.literal("NO_EXEMPTION"),
  criterionScope: z
    .array(z.strictObject({ criterionId: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), scope: z.literal("INPUT_FIELDS"), rows: z.literal("MODEL_SAMPLE") }))
    .max(20)
    .refine((a) => strictlyAscending(a.map((x) => x.criterionId)), "canonical order"),
  humanReview: z.strictObject({ required: z.boolean() }),
});

export const mandateDocumentV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    mandateId: z.string().regex(MANDATE_ID_PATTERN),
    nonce: z.string().regex(NONCE_PATTERN),
    principalId: z.string().min(1).max(128),
    currency: z.literal(CURRENCY),
    budgetTotal: money2,
    perDealMax: money2,
    requireHumanAbove: money2.nullable(),
    allowedTaskTypes: z.array(z.enum(TASK_TYPES)).min(1).refine(strictlyAscending, "canonical order"),
    counterparties: z.array(z.string().min(1).max(64)).min(1).refine(strictlyAscending, "canonical order"),
    injectionPolicy: z.enum(INJECTION_POLICIES),
    allowPartialSettlement: z.boolean(),
    allowPreDeliveryCancellation: z.boolean(),
    expiresAt: canonicalInstant,
    languagePolicy: languagePolicyV1Schema,
    /** reserved: the only value this verifier accepts is null (budget carry-over is a later, separately approved stage) */
    carryOver: z.null(),
  })
  .superRefine((d, ctx) => {
    try {
      if (parseMoney(d.perDealMax).gt(parseMoney(d.budgetTotal))) ctx.addIssue({ code: "custom", message: "perDealMax must not exceed budgetTotal", path: ["perDealMax"] });
      if (d.requireHumanAbove && parseMoney(d.requireHumanAbove).gt(parseMoney(d.perDealMax))) ctx.addIssue({ code: "custom", message: "requireHumanAbove must not exceed perDealMax", path: ["requireHumanAbove"] });
    } catch {
      // an amount that does not parse is already reported by its own field check; this cross-field rule must not throw
      ctx.addIssue({ code: "custom", message: "amount cannot be compared" });
    }
  });
/** NOT assignable to the V1 MandateDocument: it cannot flow into the policy or settlement engines by accident */
export type MandateDocumentV2 = z.infer<typeof mandateDocumentV2Schema>;

const envelopeSchema = z.strictObject({
  sealVersion: z.literal(V2_SEAL_VERSION),
  canonicalJson: z.string().min(2).max(65_536),
  mandateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedBy: z.string().min(1).max(254),
  approvedAt: canonicalInstant,
  approvalMethod: z.literal(V2_APPROVAL_METHOD),
  keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  /** Ed25519 signatures are 64 bytes: 88 base64 characters ending "==" */
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/)
    // canonical base64 only: the 86th character carries 4 significant bits, so several spellings decode to the same 64 bytes; a signature string is not malleable here
    .refine((s) => Buffer.from(s, "base64").toString("base64") === s, "canonical base64"),
});
export type SealedMandateV2 = z.infer<typeof envelopeSchema>;

export type V2VerifyResult =
  | { ok: true; document: MandateDocumentV2; keyVersion: string; keyFingerprint: string; mandateDigest: string; approvedBy: string; approvedAt: string }
  | { ok: false; code: V2SealErrorCode };

export interface V2VerifyContext {
  /** the ONLY source of verification keys */
  registry: KeyRegistry;
  /** identity of the record the envelope was loaded from; the signed mandateId must equal it */
  expected: { mandateId: string; nonce?: string };
}

// ------------------------------------------------------------------------------------------------------------------------------------ verification
const fail = (code: V2SealErrorCode): V2VerifyResult => ({ ok: false, code });

/** constant-time string equality (compares fixed-length digests of both inputs, so neither the length nor the first differing byte is observable) */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** The exact object whose canonical JSON is signed (docs/15 section 15.5.2). Rebuilt from the parsed document and the envelope only. */
export function buildV2SignedPayload(doc: MandateDocumentV2, env: Omit<SealedMandateV2, "signature" | "canonicalJson">, purpose: string): Record<string, unknown> {
  return {
    purpose,
    sealVersion: V2_SEAL_VERSION,
    schemaVersion: 2,
    keyVersion: env.keyVersion,
    mandateId: doc.mandateId,
    principalId: doc.principalId,
    mandateDigest: env.mandateDigest,
    languagePolicyHash: sha256Hex(canonicalJson(doc.languagePolicy)),
    carryOverHash: sha256Hex(canonicalJson(doc.carryOver)),
    authorization: {
      currency: doc.currency,
      budgetTotal: doc.budgetTotal,
      perDealMax: doc.perDealMax,
      requireHumanAbove: doc.requireHumanAbove,
      allowedTaskTypes: doc.allowedTaskTypes,
      counterparties: doc.counterparties,
      injectionPolicy: doc.injectionPolicy,
      allowPartialSettlement: doc.allowPartialSettlement,
      allowPreDeliveryCancellation: doc.allowPreDeliveryCancellation,
      expiresAt: doc.expiresAt,
    },
    approvedBy: env.approvedBy,
    approvedAt: env.approvedAt,
    approvalMethod: env.approvalMethod,
  };
}

/** Verify a V2 sealed mandate. Never throws: every outcome is a typed result. */
export function verifyV2MandateSeal(input: unknown, ctx: V2VerifyContext): V2VerifyResult {
  try {
    return verifySteps(input, ctx);
  } catch {
    return fail("VERIFIER_ERROR");
  }
}

function verifySteps(input: unknown, ctx: V2VerifyContext): V2VerifyResult {
  // 1. dispatch
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail("ENVELOPE_MALFORMED");
  const raw = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(raw, "sealVersion") || raw.sealVersion !== V2_SEAL_VERSION) return fail("UNSUPPORTED_SEAL_VERSION");

  // 2. envelope
  const envParsed = envelopeSchema.safeParse(raw);
  if (!envParsed.success) return fail("ENVELOPE_INVALID");
  const env = envParsed.data;

  // 3. digest of the exact received bytes
  if (!constantTimeEqual(sha256Hex(env.canonicalJson), env.mandateDigest)) return fail("DIGEST_MISMATCH");

  // 4. strict JSON
  const json = parseStrictJson(env.canonicalJson, { maxBytes: MAX_DOCUMENT_BYTES });
  if (!json.ok) return fail(json.code);

  // 5. version peek
  const value = json.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("DOCUMENT_INVALID");
  if ((value as Record<string, unknown>).schemaVersion !== 2) return fail("UNSUPPORTED_SCHEMA_VERSION");

  // 6. canonical bytes (never normalised: a validly signed but non-canonical text is refused)
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return fail("DOCUMENT_INVALID");
  }
  if (canonical !== env.canonicalJson) return fail("NON_CANONICAL_DOCUMENT");

  // 7. strict schema
  const docParsed = mandateDocumentV2Schema.safeParse(value);
  if (!docParsed.success) return fail("DOCUMENT_INVALID");
  const doc = docParsed.data;

  // 8. key: registry only
  const rec = ctx.registry.lookup(env.keyVersion);
  if (rec === null) return fail("KEY_VERSION_UNKNOWN");
  if (rec.keyVersion !== env.keyVersion) return fail("KEY_VERSION_UNKNOWN");
  if (rec.algorithm !== "ed25519") return fail("KEY_ALGORITHM_UNSUPPORTED");
  if (rec.status === "REVOKED") return fail("KEY_REVOKED");
  if (rec.status !== "ACTIVE") return fail("KEY_DISABLED");
  const fp = publicKeyFingerprint(rec.publicKeyB64);
  if (fp === null || !constantTimeEqual(fp, rec.fingerprint)) return fail("KEY_FINGERPRINT_MISMATCH");

  // 9. signature over the exact approved signed bytes
  const message = canonicalJson(buildV2SignedPayload(doc, env, V2_SEAL_PURPOSE));
  if (!verifyMessage(message, env.signature, rec.publicKeyB64)) return fail("SIGNATURE_INVALID");

  // 10. identity (the record the envelope came from, and the expected nonce when supplied)
  if (typeof ctx.expected?.mandateId !== "string" || !constantTimeEqual(doc.mandateId, ctx.expected.mandateId)) return fail("MANDATE_ID_MISMATCH");
  if (ctx.expected.nonce !== undefined && (typeof ctx.expected.nonce !== "string" || !constantTimeEqual(doc.nonce, ctx.expected.nonce))) return fail("NONCE_MISMATCH");

  return { ok: true, document: doc, keyVersion: env.keyVersion, keyFingerprint: fp, mandateDigest: env.mandateDigest, approvedBy: env.approvedBy, approvedAt: env.approvedAt };
}
