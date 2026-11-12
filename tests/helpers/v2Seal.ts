/**
 * TEST-ONLY V2 sealing helper (P2). The production build has NO V2 signer (tests/unit/v2-verifier-isolation.test.ts pins that); this file exists only so the verifier can be
 * exercised. It builds the signed payload from the approved specification (docs/15 section 15.5.2) by its own code, NOT by calling anything in src/domain/mandate-v2.ts, so a
 * mistake mirrored in both would still be caught by the frozen golden vectors in v2GoldenVectors.ts.
 * Keys are EPHEMERAL (generated in memory per test run, never written, printed or logged). Nothing here touches a database, PayPal or a model.
 */
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import { createKeyRegistry, publicKeyFingerprint, type KeyRegistry, type KeyStatus } from "@/domain/key-registry";
import { generateSigningKeys, signMessage, type SigningKeys } from "@/domain/signing";
import { GOLDEN_V2 } from "./v2GoldenVectors";

export const goldenDocument = (): Record<string, any> => JSON.parse(GOLDEN_V2.documentText) as Record<string, any>;

export function ephemeralKey(keyVersion: string = GOLDEN_V2.keyVersion): SigningKeys {
  return generateSigningKeys(keyVersion);
}

export function recordFor(keys: SigningKeys, status: KeyStatus = "ACTIVE", over: Record<string, unknown> = {}) {
  return { keyVersion: keys.keyVersion, algorithm: "ed25519", publicKeyB64: keys.publicKeyB64, fingerprint: publicKeyFingerprint(keys.publicKeyB64)!, status, ...over };
}
export const registryFor = (keys: SigningKeys, status: KeyStatus = "ACTIVE"): KeyRegistry => createKeyRegistry([recordFor(keys, status)]);

export interface SealOptions {
  keys: SigningKeys;
  /** the key version written in the envelope AND signed in the payload (default: keys.keyVersion) */
  keyVersion?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** sign THIS text instead of canonicalJson(document) (noncanonical / duplicate-key / malformed variants); the digest follows the text */
  text?: string;
  /** the document the payload echoes (default: the document that was passed in) */
  payloadDocument?: Record<string, any>;
  /** last chance to alter the payload object before it is signed */
  payload?: (p: Record<string, any>) => Record<string, any>;
  /** alter the envelope after signing (wrong digest, unknown field, ...) */
  envelope?: (e: Record<string, any>) => Record<string, any>;
}

/** the approved payload (docs/15 section 15.5.2), written out independently */
export function payloadFor(doc: Record<string, any>, e: { keyVersion: string; mandateDigest: string; approvedBy: string; approvedAt: string }): Record<string, any> {
  return {
    purpose: "mandate-seal",
    sealVersion: 2,
    schemaVersion: 2,
    keyVersion: e.keyVersion,
    mandateId: doc.mandateId,
    principalId: doc.principalId,
    mandateDigest: e.mandateDigest,
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
    approvedBy: e.approvedBy,
    approvedAt: e.approvedAt,
    approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION",
  };
}

export function sealV2(doc: Record<string, any>, o: SealOptions): Record<string, any> {
  const keyVersion = o.keyVersion ?? o.keys.keyVersion;
  const approvedBy = o.approvedBy ?? GOLDEN_V2.approvedBy;
  const approvedAt = o.approvedAt ?? GOLDEN_V2.approvedAt;
  const text = o.text ?? canonicalJson(doc);
  const mandateDigest = sha256Hex(text);
  let payload = payloadFor(o.payloadDocument ?? doc, { keyVersion, mandateDigest, approvedBy, approvedAt });
  if (o.payload) payload = o.payload(payload);
  const signature = signMessage(canonicalJson(payload), o.keys.privateKeyB64);
  const envelope = { sealVersion: 2, canonicalJson: text, mandateDigest, approvedBy, approvedAt, approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION", keyVersion, signature };
  return o.envelope ? o.envelope(envelope) : envelope;
}

/** sign an arbitrary message with the ephemeral key (used to sign the frozen golden payload bytes verbatim) */
export const signRaw = (message: string, keys: SigningKeys) => signMessage(message, keys.privateKeyB64);
