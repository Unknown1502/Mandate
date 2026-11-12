/** P2: the public-key registry used by the V2 seal verifier. Pure. Keys are EPHEMERAL test keys; no private key is ever read, printed or stored. */
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_KEY_REGISTRY, KEY_STATUSES, KeyRegistryError, SUPPORTED_KEY_ALGORITHMS, createKeyRegistry, publicKeyFingerprint } from "@/domain/key-registry";
import { ephemeralKey, recordFor } from "../helpers/v2Seal";

const k = ephemeralKey("k1");
const rec = (over: Record<string, unknown> = {}) => recordFor(k, "ACTIVE", { keyVersion: "k1", ...over });
const code = (records: unknown[]) => {
  try {
    createKeyRegistry(records);
    return "OK";
  } catch (e) {
    return e instanceof KeyRegistryError ? e.code : `OTHER:${(e as Error).message}`;
  }
};

describe("registry contract", () => {
  it("supports exactly Ed25519 and the three statuses", () => {
    expect([...SUPPORTED_KEY_ALGORITHMS]).toEqual(["ed25519"]);
    expect([...KEY_STATUSES]).toEqual(["ACTIVE", "DISABLED", "REVOKED"]);
  });
  it("looks a record up by EXACT key version and returns it frozen", () => {
    const r = createKeyRegistry([rec()]);
    const found = r.lookup("k1");
    expect(found).toMatchObject({ keyVersion: "k1", algorithm: "ed25519", status: "ACTIVE" });
    expect(Object.isFrozen(found)).toBe(true);
    expect(r.lookup("K1")).toBeNull();
    expect(r.lookup("k1 ")).toBeNull();
    expect(r.lookup("k")).toBeNull();
    expect(r.lookup("")).toBeNull();
  });
  it("prototype-ish names and non-strings find nothing (no inherited lookup, no coercion)", () => {
    const r = createKeyRegistry([rec()]);
    for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) expect(r.lookup(v), v).toBeNull();
    for (const v of [undefined, null, 1, {}, ["k1"], { toString: () => "k1" }]) expect(r.lookup(v as never), String(typeof v)).toBeNull();
  });
  it("no default key and no fallback: an empty registry knows nothing and an unknown version is null", () => {
    expect(EMPTY_KEY_REGISTRY.lookup("k1")).toBeNull();
    expect(createKeyRegistry([rec()]).lookup("k2")).toBeNull();
  });
  it("several versions may name the same key (rotation) but each is a separate, explicit record", () => {
    const r = createKeyRegistry([rec(), rec({ keyVersion: "k2", status: "DISABLED" })]);
    expect(r.lookup("k1")!.status).toBe("ACTIVE");
    expect(r.lookup("k2")!.status).toBe("DISABLED");
  });
  it("records carry public material only: the record shape has no private-key field and a record that tries to carry one is refused", () => {
    expect(Object.keys(createKeyRegistry([rec()]).lookup("k1")!).sort()).toEqual(["algorithm", "fingerprint", "keyVersion", "publicKeyB64", "status"]);
    expect(code([rec({ privateKeyB64: k.privateKeyB64 })])).toBe("RECORD_INVALID");
    expect(code([rec({ publicKeyB64: k.privateKeyB64 })])).toBe("PUBLIC_KEY_INVALID"); // a PKCS8 private key is not an SPKI public key
  });
});

describe("construction fails closed (at start-up, not at verification time)", () => {
  it("record shape", () => {
    for (const bad of [null, undefined, "k1", 5, [], {}, rec({ extra: 1 }), rec({ keyVersion: "" }), rec({ keyVersion: "k 1" }), rec({ keyVersion: "k".repeat(33) }), rec({ keyVersion: ".k" }), rec({ status: "RETIRED" }), rec({ status: undefined }), rec({ algorithm: "rsa" }), rec({ algorithm: "ED25519" }), rec({ algorithm: undefined }), rec({ fingerprint: "AB".repeat(32) }), rec({ fingerprint: "ab".repeat(31) }), rec({ fingerprint: undefined })]) {
      expect(code([bad]), JSON.stringify(bad)?.slice(0, 60)).toBe("RECORD_INVALID");
    }
  });
  it("the declared fingerprint must equal the SHA-256 of the key's DER bytes", () => {
    expect(code([rec({ fingerprint: "0".repeat(64) })])).toBe("FINGERPRINT_MISMATCH");
    expect(code([rec({ fingerprint: createHash("sha256").update("other").digest("hex") })])).toBe("FINGERPRINT_MISMATCH");
    const other = ephemeralKey("x");
    expect(code([rec({ publicKeyB64: other.publicKeyB64 })])).toBe("FINGERPRINT_MISMATCH");
  });
  it("the key must be a base64 Ed25519 SPKI public key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(code([rec({ publicKeyB64: "", fingerprint: "a".repeat(64) })])).toBe("RECORD_INVALID"); // empty is not even a candidate
    for (const bad of ["AAAA", "not base64!", rsa, ec, k.publicKeyB64.slice(2), k.publicKeyB64 + "A"]) {
      expect(code([rec({ publicKeyB64: bad, fingerprint: "a".repeat(64) })]), bad.slice(0, 20)).toBe("PUBLIC_KEY_INVALID");
    }
    expect(publicKeyFingerprint(rsa)).toBeNull();
    expect(publicKeyFingerprint(ec)).toBeNull();
  });
  it("duplicate key versions are refused", () => {
    expect(code([rec(), rec()])).toBe("DUPLICATE_KEY_VERSION");
    expect(code([rec(), rec({ status: "REVOKED" })])).toBe("DUPLICATE_KEY_VERSION");
  });
  it("a bad record anywhere refuses the whole registry", () => {
    expect(code([rec(), rec({ keyVersion: "k2", status: "bogus" })])).toBe("RECORD_INVALID");
  });
});

describe("fingerprint", () => {
  it("is the lowercase hex SHA-256 of the SPKI DER bytes (computed independently here)", () => {
    expect(publicKeyFingerprint(k.publicKeyB64)).toBe(createHash("sha256").update(Buffer.from(k.publicKeyB64, "base64")).digest("hex"));
  });
  it("two different keys never share a fingerprint", () => {
    expect(publicKeyFingerprint(ephemeralKey().publicKeyB64)).not.toBe(publicKeyFingerprint(ephemeralKey().publicKeyB64));
  });
  it("non-string input is null, not an exception", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(publicKeyFingerprint(v as never)).toBeNull();
  });
});
