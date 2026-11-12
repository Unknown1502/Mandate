import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * Ed25519 "application seal". This proves the application sealed a human-approved mandate;
 * it is NOT a user-held-key signature and must not be described as one.
 */
export interface SigningKeys {
  privateKeyB64: string; // PKCS8 DER, base64
  publicKeyB64: string; // SPKI DER, base64
  keyVersion: string;
}

export function generateSigningKeys(keyVersion = "v1"): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyB64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    keyVersion,
  };
}

export function signMessage(message: string, privateKeyB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

export function verifyMessage(message: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function loadSigningKeys(env: Record<string, string | undefined>): SigningKeys {
  const priv = env.MANDATE_SIGNING_PRIVATE_KEY;
  const pub = env.MANDATE_SIGNING_PUBLIC_KEY;
  if (!priv || !pub || /^replace_me/.test(priv) || /^replace_me/.test(pub)) {
    throw new Error("MANDATE_SIGNING_PRIVATE_KEY / MANDATE_SIGNING_PUBLIC_KEY are not configured");
  }
  return { privateKeyB64: priv, publicKeyB64: pub, keyVersion: env.MANDATE_SIGNING_KEY_VERSION ?? "v1" };
}
