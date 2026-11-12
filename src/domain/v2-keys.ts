import { createKeyRegistry, publicKeyFingerprint, type KeyRegistry, type KeyStatus } from "./key-registry";
import type { SigningKeys } from "./signing";

/**
 * Public-key registry for the application's own signing key (P3). Only PUBLIC material is used; the private key never enters a registry.
 * There is exactly one entry, so a seal or attestation under any other key version fails closed (KEY_VERSION_UNKNOWN).
 */
export function registryFromSigningKeys(keys: Pick<SigningKeys, "keyVersion" | "publicKeyB64">, status: KeyStatus = "ACTIVE"): KeyRegistry {
  const fingerprint = publicKeyFingerprint(keys.publicKeyB64);
  if (fingerprint === null) throw new Error("signing public key is not an Ed25519 SPKI key");
  return createKeyRegistry([{ keyVersion: keys.keyVersion, algorithm: "ed25519", publicKeyB64: keys.publicKeyB64, fingerprint, status }]);
}
