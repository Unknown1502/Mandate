/**
 * Public-key registry for V2 seal verification (P2; docs/15 section 15.5.3 step 5 and section 15.24).
 *
 * A registry answers ONE question: "which public key, algorithm and status does this keyVersion name?". Properties:
 *   - EXPLICIT: a keyVersion is looked up by exact string; there is no default key, no "latest" and no fallback.
 *   - STATIC: it is built in memory from records the deployment supplies. There is no remote fetching and no trust-on-first-use; a key that arrives inside a document is
 *     never consulted (the verifier takes the key only from here).
 *   - VALIDATED AT CONSTRUCTION: every record is parsed strictly (algorithm must be "ed25519"; the key must parse as an Ed25519 SPKI public key; the declared fingerprint must equal
 *     the SHA-256 of the key's DER bytes; keyVersion unique). A bad record throws when the registry is built, never later at verification time.
 *   - PUBLIC MATERIAL ONLY: this module cannot sign and never receives a private key.
 *
 * Statuses: ACTIVE verifies. DISABLED (operator suspended, reversible) and REVOKED (compromised, permanent) are both REFUSED by the verifier; the two are kept apart so the
 * audit trail says why. There is deliberately no "retired but still trusted" state in P2 (see the rotation limitation in docs/15 section 15.24).
 */
import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";

export const SUPPORTED_KEY_ALGORITHMS = ["ed25519"] as const;
export type KeyAlgorithm = (typeof SUPPORTED_KEY_ALGORITHMS)[number];
export const KEY_STATUSES = ["ACTIVE", "DISABLED", "REVOKED"] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];
export const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface PublicKeyRecord {
  readonly keyVersion: string;
  readonly algorithm: KeyAlgorithm;
  /** SPKI DER, base64 (the same encoding the V1 verifier uses) */
  readonly publicKeyB64: string;
  /** lowercase hex SHA-256 of the SPKI DER bytes */
  readonly fingerprint: string;
  readonly status: KeyStatus;
}

export interface KeyRegistry {
  /** exact-match lookup; null when the version is not registered. Never throws, never falls back. */
  lookup(keyVersion: string): PublicKeyRecord | null;
}

/** lowercase hex SHA-256 of the key's SPKI DER bytes, or null if the input is not a base64 Ed25519 SPKI public key */
export function publicKeyFingerprint(publicKeyB64: string): string | null {
  try {
    if (typeof publicKeyB64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyB64)) return null;
    const der = Buffer.from(publicKeyB64, "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

const recordSchema = z.strictObject({
  keyVersion: z.string().regex(KEY_VERSION_PATTERN),
  algorithm: z.literal("ed25519"),
  publicKeyB64: z.string().min(1).max(512),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(KEY_STATUSES),
});

export class KeyRegistryError extends Error {
  constructor(readonly code: "RECORD_INVALID" | "DUPLICATE_KEY_VERSION" | "PUBLIC_KEY_INVALID" | "FINGERPRINT_MISMATCH") {
    super(code);
    this.name = "KeyRegistryError";
  }
}

/** Build a registry from explicit records. Throws KeyRegistryError for ANY invalid record (fail at start-up, not at verification time). */
export function createKeyRegistry(records: readonly unknown[]): KeyRegistry {
  const byVersion = new Map<string, PublicKeyRecord>();
  for (const raw of records) {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) throw new KeyRegistryError("RECORD_INVALID");
    const rec = parsed.data;
    if (byVersion.has(rec.keyVersion)) throw new KeyRegistryError("DUPLICATE_KEY_VERSION");
    const fp = publicKeyFingerprint(rec.publicKeyB64);
    if (fp === null) throw new KeyRegistryError("PUBLIC_KEY_INVALID");
    if (fp !== rec.fingerprint) throw new KeyRegistryError("FINGERPRINT_MISMATCH");
    byVersion.set(rec.keyVersion, Object.freeze({ ...rec }));
  }
  return Object.freeze({
    // a Map lookup is exact-match by construction (no prototype keys, no coercion); anything that is not a string finds nothing
    lookup: (keyVersion: string) => (typeof keyVersion === "string" ? (byVersion.get(keyVersion) ?? null) : null),
  });
}

/** a registry that knows no key: every V2 seal is refused with KEY_VERSION_UNKNOWN. This is the only registry the P2 build constructs outside tests. */
export const EMPTY_KEY_REGISTRY: KeyRegistry = createKeyRegistry([]);
