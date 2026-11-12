/**
 * TermsAttestation (P3; docs/15 section 15.5.4). PURE: signing takes keys as an argument, nothing here touches a database or the environment.
 *
 * WHAT IT PROVES (wording that must be used in code, UI and docs): "The application recorded that <actor> approved these exact terms under this mandate at <time>,
 * and attests to that record with its Ed25519 application key." It is NOT the user's own cryptographic signature (the user holds no key).
 *
 * The signed payload binds: deal id, mandate id AND digest, terms hash, terms schema version, language policy hash, the criterion-to-field mapping hash, the
 * approving actor, the approval time and a single-use approval nonce. Its purpose tag ("terms-attestation") is distinct from the mandate seal's, so a signature over
 * one can never verify as the other. The signed bytes are canonicalJson(payload); the stored text is re-parsed strictly and must equal its own canonical form.
 */
import { z } from "zod";
import { parseStrictJson } from "../lib/strict-json";
import { canonicalJson, sha256Hex } from "./canonical";
import { publicKeyFingerprint, type KeyRegistry } from "./key-registry";
import { MANDATE_ID_PATTERN, NONCE_PATTERN } from "./mandate-v2";
import { signMessage, verifyMessage, type SigningKeys } from "./signing";
import { createHash, timingSafeEqual } from "node:crypto";

export const ATTESTATION_PURPOSE = "terms-attestation";
export const ATTESTATION_VERSION = 1;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime().refine((s) => {
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
}, "canonical instant");

export const attestationPayloadSchema = z.strictObject({
  purpose: z.literal(ATTESTATION_PURPOSE),
  attestationVersion: z.literal(ATTESTATION_VERSION),
  keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  dealId: z.string().min(1).max(64),
  mandateId: z.string().regex(MANDATE_ID_PATTERN),
  mandateDigest: hex64,
  termsHash: hex64,
  termsSchemaVersion: z.literal(2),
  languagePolicyHash: hex64.nullable(),
  mappingHash: hex64,
  approvalKind: z.literal("HUMAN_PREAUTH"),
  actor: z.strictObject({ kind: z.literal("human"), id: z.string().min(1).max(128), label: z.string().min(1).max(254) }),
  approvedAt: instant,
  approvalNonce: z.string().regex(NONCE_PATTERN),
});
export type AttestationPayload = z.infer<typeof attestationPayloadSchema>;
export type UnsignedAttestation = Omit<AttestationPayload, "approvedAt">;

export interface AttestationBinding {
  dealId: string;
  mandateId: string;
  mandateDigest: string;
  termsHash: string;
  termsSchemaVersion: 2;
  languagePolicyHash: string | null;
  mappingHash: string;
}

export function buildUnsignedAttestation(
  b: AttestationBinding,
  x: { keyVersion: string; actor: { id: string; label: string }; approvalNonce: string },
): UnsignedAttestation {
  return {
    purpose: ATTESTATION_PURPOSE,
    attestationVersion: ATTESTATION_VERSION,
    keyVersion: x.keyVersion,
    ...b,
    approvalKind: "HUMAN_PREAUTH",
    actor: { kind: "human", id: x.actor.id, label: x.actor.label },
    approvalNonce: x.approvalNonce,
  };
}

/** What the human echoes at step 2: a digest of every bound value EXCEPT the approval time (which does not exist yet at preview). */
export const attestationDigest = (u: UnsignedAttestation): string => sha256Hex(canonicalJson(u));

export interface SignedAttestation {
  payloadJson: string;
  signature: string;
  keyVersion: string;
  payload: AttestationPayload;
}

export function signAttestation(u: UnsignedAttestation, approvedAt: string, keys: SigningKeys): SignedAttestation {
  if (u.keyVersion !== keys.keyVersion) throw new Error("attestation key version does not match the signing key");
  const payload = attestationPayloadSchema.parse({ ...u, approvedAt });
  const payloadJson = canonicalJson(payload);
  return { payloadJson, signature: signMessage(payloadJson, keys.privateKeyB64), keyVersion: keys.keyVersion, payload };
}

export const ATTESTATION_ERROR_CODES = [
  "ATTESTATION_MISSING",
  "ATTESTATION_MALFORMED",
  "ATTESTATION_NON_CANONICAL",
  "ATTESTATION_KEY_MISMATCH",
  "KEY_VERSION_UNKNOWN",
  "KEY_ALGORITHM_UNSUPPORTED",
  "KEY_DISABLED",
  "KEY_REVOKED",
  "KEY_FINGERPRINT_MISMATCH",
  "SIGNATURE_INVALID",
  "ATTESTATION_BINDING_MISMATCH",
  "ATTESTATION_ACTOR_MISMATCH",
  "VERIFIER_ERROR",
] as const;
export type AttestationErrorCode = (typeof ATTESTATION_ERROR_CODES)[number];
export type AttestationVerifyResult = { ok: true; payload: AttestationPayload; keyFingerprint: string } | { ok: false; code: AttestationErrorCode; field?: string };

const ctEqual = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const fail = (code: AttestationErrorCode, field?: string): AttestationVerifyResult => (field ? { ok: false, code, field } : { ok: false, code });

/**
 * Verify a stored attestation against the CURRENT locked state. `expected` must be re-derived by the caller from the freshly verified mandate and the deal's locked
 * terms, never from the attestation itself. `expectedActorId` is the mandate's principal: only the principal can approve their own deal.
 */
export function verifyTermsAttestation(
  record: { payloadJson: string; signature: string; keyVersion: string },
  ctx: { registry: KeyRegistry; expected: AttestationBinding; expectedActorId: string },
): AttestationVerifyResult {
  try {
    return verifySteps(record, ctx);
  } catch {
    return fail("VERIFIER_ERROR");
  }
}

function verifySteps(
  record: { payloadJson: string; signature: string; keyVersion: string },
  ctx: { registry: KeyRegistry; expected: AttestationBinding; expectedActorId: string },
): AttestationVerifyResult {
  if (!record || typeof record.payloadJson !== "string" || typeof record.signature !== "string" || typeof record.keyVersion !== "string") return fail("ATTESTATION_MALFORMED");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(record.signature) || Buffer.from(record.signature, "base64").toString("base64") !== record.signature) return fail("ATTESTATION_MALFORMED");
  const json = parseStrictJson(record.payloadJson, { maxBytes: 8_192 });
  if (!json.ok) return fail("ATTESTATION_MALFORMED");
  const parsed = attestationPayloadSchema.safeParse(json.value);
  if (!parsed.success) return fail("ATTESTATION_MALFORMED");
  const p = parsed.data;
  if (canonicalJson(p) !== record.payloadJson) return fail("ATTESTATION_NON_CANONICAL");
  if (p.keyVersion !== record.keyVersion) return fail("ATTESTATION_KEY_MISMATCH");

  const rec = ctx.registry.lookup(p.keyVersion);
  if (rec === null || rec.keyVersion !== p.keyVersion) return fail("KEY_VERSION_UNKNOWN");
  if (rec.algorithm !== "ed25519") return fail("KEY_ALGORITHM_UNSUPPORTED");
  if (rec.status === "REVOKED") return fail("KEY_REVOKED");
  if (rec.status !== "ACTIVE") return fail("KEY_DISABLED");
  const fp = publicKeyFingerprint(rec.publicKeyB64);
  if (fp === null || !ctEqual(fp, rec.fingerprint)) return fail("KEY_FINGERPRINT_MISMATCH");
  if (!verifyMessage(record.payloadJson, record.signature, rec.publicKeyB64)) return fail("SIGNATURE_INVALID");

  // binding to the CURRENT state (after the signature, so a forged record is reported as such)
  const e = ctx.expected;
  const pairs: Array<[keyof AttestationBinding, string | number | null, string | number | null]> = [
    ["dealId", p.dealId, e.dealId],
    ["mandateId", p.mandateId, e.mandateId],
    ["mandateDigest", p.mandateDigest, e.mandateDigest],
    ["termsHash", p.termsHash, e.termsHash],
    ["termsSchemaVersion", p.termsSchemaVersion, e.termsSchemaVersion],
    ["languagePolicyHash", p.languagePolicyHash, e.languagePolicyHash],
    ["mappingHash", p.mappingHash, e.mappingHash],
  ];
  for (const [field, got, want] of pairs) if (got !== want) return fail("ATTESTATION_BINDING_MISMATCH", field);
  if (!ctEqual(p.actor.id, ctx.expectedActorId)) return fail("ATTESTATION_ACTOR_MISMATCH");
  return { ok: true, payload: p, keyFingerprint: fp };
}
