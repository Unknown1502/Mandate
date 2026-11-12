/**
 * P2: the V2 mandate seal verifier (src/domain/mandate-v2.ts). Pure: no database, no network, no model, no PayPal. Keys are EPHEMERAL test keys.
 * Test envelopes are produced by tests/helpers/v2Seal.ts, which builds the approved signed payload by its own code; the frozen golden vectors
 * (tests/helpers/v2GoldenVectors.ts, computed by an independent script) pin the byte format itself.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import { createKeyRegistry, type KeyRegistry, type PublicKeyRecord } from "@/domain/key-registry";
import { openSealedMandateDetailed, readMandateDocument, type MandateDocument } from "@/domain/mandate";
import { V2_SEAL_ERROR_CODES, verifyV2MandateSeal, type MandateDocumentV2, type V2SealErrorCode, type V2VerifyResult } from "@/domain/mandate-v2";
import { generateSigningKeys, signMessage } from "@/domain/signing";
import { MANDATE_FIXTURES } from "../helpers/legacyFixtures";
import { ephemeralKey, goldenDocument, payloadFor, recordFor, registryFor, sealV2, signRaw } from "../helpers/v2Seal";
import { GOLDEN_V2 } from "../helpers/v2GoldenVectors";

const keys = ephemeralKey();
const registry = registryFor(keys);
const ctx = (over: { registry?: KeyRegistry; mandateId?: string; nonce?: string } = {}) => ({ registry: over.registry ?? registry, expected: { mandateId: over.mandateId ?? GOLDEN_V2.mandateId, ...(over.nonce !== undefined ? { nonce: over.nonce } : {}) } });
const seen = new Set<string>();
const verify = (env: unknown, c = ctx()): V2VerifyResult => {
  const r = verifyV2MandateSeal(env, c);
  if (!r.ok) seen.add(r.code);
  return r;
};
const code = (env: unknown, c = ctx()) => {
  const r = verify(env, c);
  return r.ok ? "OK" : r.code;
};
const doc = (f?: (d: Record<string, any>) => void) => {
  const d = goldenDocument();
  f?.(d);
  return d;
};
const seal = (d: Record<string, any>, o: Partial<Parameters<typeof sealV2>[1]> = {}) => sealV2(d, { keys, ...o });
const good = () => seal(doc());

describe("valid V2 seals", () => {
  it("the golden document + golden signed payload, signed verbatim by an ephemeral key, verify: the verifier rebuilds the approved bytes exactly", () => {
    expect(sha256Hex(GOLDEN_V2.documentText)).toBe(GOLDEN_V2.documentDigest);
    expect(sha256Hex(GOLDEN_V2.signedPayloadText)).toBe(GOLDEN_V2.signedPayloadDigest);
    expect(canonicalJson(goldenDocument())).toBe(GOLDEN_V2.documentText); // the canonicalisation rules reproduce the independently computed bytes
    const env = { sealVersion: 2, canonicalJson: GOLDEN_V2.documentText, mandateDigest: GOLDEN_V2.documentDigest, approvedBy: GOLDEN_V2.approvedBy, approvedAt: GOLDEN_V2.approvedAt, approvalMethod: GOLDEN_V2.approvalMethod, keyVersion: GOLDEN_V2.keyVersion, signature: signRaw(GOLDEN_V2.signedPayloadText, keys) };
    const r = verify(env);
    expect(r).toMatchObject({ ok: true, keyVersion: "k2", mandateDigest: GOLDEN_V2.documentDigest, approvedBy: GOLDEN_V2.approvedBy });
    if (r.ok) expect(r.document).toEqual(JSON.parse(GOLDEN_V2.documentText));
  });
  it("the helper's independently written payload equals the frozen golden payload text", () => {
    const p = payloadFor(goldenDocument(), { keyVersion: "k2", mandateDigest: GOLDEN_V2.documentDigest, approvedBy: GOLDEN_V2.approvedBy, approvedAt: GOLDEN_V2.approvedAt });
    expect(canonicalJson(p)).toBe(GOLDEN_V2.signedPayloadText);
    expect(p.languagePolicyHash).toBe(GOLDEN_V2.languagePolicyHash);
    expect(p.carryOverHash).toBe(GOLDEN_V2.carryOverHash);
  });
  it("returns the typed, validated document, the key version and the fingerprint of the REGISTRY key", () => {
    const r = verify(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document.mandateId).toBe(GOLDEN_V2.mandateId);
    expect(r.document.languagePolicy.supportedLanguages).toEqual(["en", "fr", "zh"]);
    expect(r.keyFingerprint).toBe(registry.lookup("k2")!.fingerprint);
  });
  it("does not mutate its input", () => {
    const env = good();
    const snapshot = JSON.stringify(env);
    verify(env);
    expect(JSON.stringify(env)).toBe(snapshot);
  });
  it("accepts the expected nonce when supplied, and still accepts when none is supplied", () => {
    expect(code(good(), ctx({ nonce: GOLDEN_V2.nonce }))).toBe("OK");
    expect(code(good())).toBe("OK");
  });
  it("validly handles every legal variant of the optional / boolean fields", () => {
    for (const f of [(d: any) => (d.requireHumanAbove = null), (d: any) => (d.allowPartialSettlement = true), (d: any) => (d.allowPreDeliveryCancellation = false), (d: any) => (d.injectionPolicy = "BLOCK"), (d: any) => (d.languagePolicy.supportedLanguages = ["en"]), (d: any) => (d.languagePolicy.humanReview.required = false), (d: any) => (d.languagePolicy.unsupportedBehavior = "REJECT_DELIVERY"), (d: any) => (d.languagePolicy.criterionScope = [{ criterionId: "quality", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }])]) expect(code(seal(doc(f)))).toBe("OK");
  });
});

describe("1-2. dispatch and envelope", () => {
  it("non-objects are ENVELOPE_MALFORMED", () => {
    for (const v of [null, undefined, "x", 5, true, [], [good()]]) expect(code(v)).toBe("ENVELOPE_MALFORMED");
  });
  it("an envelope without sealVersion is a V1 envelope: refused, never read as V2", () => {
    const { sealVersion: _s, ...rest } = good() as any;
    void _s;
    expect(code(rest)).toBe("UNSUPPORTED_SEAL_VERSION");
  });
  it("sealVersion other than the number 2 is refused", () => {
    for (const v of [1, 3, "2", 2.5, null, true, 0, -2]) expect(code({ ...good(), sealVersion: v }), String(v)).toBe("UNSUPPORTED_SEAL_VERSION");
  });
  it("an unknown envelope field is refused (no algorithm / publicKey / trust field can ride along)", () => {
    for (const k of ["algorithm", "alg", "publicKey", "publicKeyB64", "keyId", "jwk", "extra"]) expect(code({ ...good(), [k]: "ed25519" }), k).toBe("ENVELOPE_INVALID");
  });
  it("missing or malformed envelope fields", () => {
    const g = good() as any;
    for (const k of ["canonicalJson", "mandateDigest", "approvedBy", "approvedAt", "approvalMethod", "keyVersion", "signature"]) {
      const { [k]: _x, ...rest } = g;
      void _x;
      expect(code(rest), `missing ${k}`).toBe("ENVELOPE_INVALID");
    }
    expect(code({ ...g, mandateDigest: g.mandateDigest.toUpperCase() })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, mandateDigest: g.mandateDigest.slice(1) })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, approvalMethod: "TRUST_ME" })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, approvedAt: "2026-11-08T12:00:00Z" })).toBe("ENVELOPE_INVALID"); // not the canonical instant form
    expect(code({ ...g, approvedAt: "yesterday" })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, approvedBy: "" })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, keyVersion: "k 2" })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, keyVersion: "" })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, canonicalJson: 5 })).toBe("ENVELOPE_INVALID");
    expect(code({ ...g, canonicalJson: "x".repeat(70_000) })).toBe("ENVELOPE_INVALID");
  });
  it("signature format: wrong length, wrong alphabet, wrong padding", () => {
    const g = good() as any;
    // every variant below ALWAYS differs from the real signature (no random-dependent no-ops)
    for (const s of ["", "AAAA", g.signature.slice(0, -2), g.signature + "A", g.signature.replace("==", "A="), "!".repeat(86) + "==", "-" + g.signature.slice(1), g.signature.slice(0, 40) + "." + g.signature.slice(41)]) {
      expect(s, "variant must differ").not.toBe(g.signature);
      expect(code({ ...g, signature: s })).toBe("ENVELOPE_INVALID");
    }
  });
  it("base64 is not malleable: a different spelling of the SAME 64 signature bytes (non-zero trailing bits) is refused", () => {
    const g = good() as any;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = g.signature[85] as string;
    const base = alphabet.indexOf(last) & ~0b11; // the two low bits are padding bits
    const spellings = [0, 1, 2, 3].map((k) => alphabet[base + k]!).filter((c) => c !== last);
    expect(spellings).toHaveLength(3);
    for (const c of spellings) {
      const variant = g.signature.slice(0, 85) + c + "==";
      expect(Buffer.from(variant, "base64").equals(Buffer.from(g.signature, "base64")), "same decoded bytes").toBe(true);
      expect(code({ ...g, signature: variant })).toBe("ENVELOPE_INVALID");
    }
    expect(code(g)).toBe("OK");
  });
});

describe("3. digest", () => {
  it("a digest that is not the hash of the received text is DIGEST_MISMATCH", () => {
    const g = good() as any;
    expect(code({ ...g, mandateDigest: sha256Hex("something else") })).toBe("DIGEST_MISMATCH");
    expect(code({ ...g, mandateDigest: "0".repeat(64) })).toBe("DIGEST_MISMATCH");
  });
  it("a one-character change of the document text with the old digest is DIGEST_MISMATCH", () => {
    const g = good() as any;
    expect(code({ ...g, canonicalJson: g.canonicalJson.replace("100.00", "100.01") })).toBe("DIGEST_MISMATCH");
  });
  it("a payload signed over a different digest than the document's is SIGNATURE_INVALID (the wrong mandate digest is covered)", () => {
    expect(code(seal(doc(), { payload: (p) => ({ ...p, mandateDigest: sha256Hex("other") }) }))).toBe("SIGNATURE_INVALID");
  });
});

describe("4-6. strict JSON, version peek, canonical bytes (all with a CORRECT digest and a CORRECT signature over the received text)", () => {
  const signText = (text: string) => seal(doc(), { text });
  it("malformed JSON", () => {
    for (const t of ["{ ", "{'a':1}", GOLDEN_V2.documentText + "x", GOLDEN_V2.documentText.slice(0, -1), "{} {}", "{,}", "[1,]"]) expect(code(signText(t)), t.slice(0, 20)).toBe("MALFORMED_JSON");
    expect(code(signText(""))).toBe("ENVELOPE_INVALID"); // shorter than the smallest possible document
  });
  it("duplicate keys at the top level, nested, inside arrays of objects, and in escaped spellings", () => {
    const t = GOLDEN_V2.documentText;
    const variants: string[] = [
      t.replace('"budgetTotal":"100.00"', '"budgetTotal":"100.00","budgetTotal":"999999.00"'),
      t.replace('"budgetTotal":"100.00"', '"budgetTotal":"1.00","budgetTotal":"100.00"'),
      t.replace('"humanReview":{"required":true}', '"humanReview":{"required":true,"required":false}'),
      t.replace('"detector":{', '"detector":{"id":"x",'),
      t.replace('"criterionScope":[]', '"criterionScope":[{"criterionId":"quality","criterionId":"other","scope":"INPUT_FIELDS","rows":"MODEL_SAMPLE"}]'),
      t.replace('"budgetTotal":"100.00"', '"budgetTotal":"100.00","budget\\u0054otal":"1.00"'),
      t.replace('"carryOver":null', '"carryOver":null,"carryOver":null'),
      t.replace('"nonce":"00112233445566778899aabbccddeeff"', '"nonce":"00112233445566778899aabbccddeeff","nonce":"ffeeddccbbaa99887766554433221100"'),
    ];
    for (const v of variants) expect(code(signText(v)), v.slice(0, 80)).toBe("DUPLICATE_KEY");
  });
  it("__proto__ is refused", () => {
    expect(code(signText(GOLDEN_V2.documentText.replace(/\}$/, ',"__proto__":{"budgetTotal":"1.00"}}')))).toBe("FORBIDDEN_KEY");
  });
  it("nesting beyond the bound and a document beyond the size bound", () => {
    expect(code(signText("[".repeat(40) + "]".repeat(40)))).toBe("TOO_DEEP");
    expect(code(signText(`{"x":"${"a".repeat(40_000)}"}`))).toBe("TOO_LARGE");
  });
  it("a document whose own schemaVersion is not 2 (absent, 1, 3, '2', 2.5, null) is UNSUPPORTED_SCHEMA_VERSION", () => {
    for (const f of [(d: any) => delete d.schemaVersion, (d: any) => (d.schemaVersion = 1), (d: any) => (d.schemaVersion = 3), (d: any) => (d.schemaVersion = "2"), (d: any) => (d.schemaVersion = null)]) {
      expect(code(seal(doc(f), { payloadDocument: doc() }))).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }
    // a non-integer spelling cannot be produced by the canonicaliser, so it is written into the signed text directly
    expect(code(signText(GOLDEN_V2.documentText.replace('"schemaVersion":2', '"schemaVersion":2.5')))).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });
  it("a non-object JSON document is DOCUMENT_INVALID", () => {
    for (const t of ["[]", "null", '"x"', "70", "true"]) expect(code(signText(t))).toBe("DOCUMENT_INVALID");
  });
  it("a correctly signed but NON-CANONICAL text is refused: key order, whitespace, escapes, trailing newline, number spelling", () => {
    const t = GOLDEN_V2.documentText;
    const o = JSON.parse(t) as Record<string, any>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(o).reverse()));
    const variants = [
      reordered,
      JSON.stringify(o, null, 2),
      t.replace('{"allowPartialSettlement"', '{ "allowPartialSettlement"'),
      t + "\n",
      " " + t,
      t.replace('"principal-golden-1"', '"principal-golden-\\u0031"'),
      t.replace('"schemaVersion":2', '"schemaVersion":2.0'),
      t.replace('"schemaVersion":2', '"schemaVersion":2e0'),
      t.replace('"policyVersion":1', '"policyVersion":1.0'),
      t.replace('"data_cleaning"', '"data\\u005fcleaning"'),
    ];
    for (const v of variants) {
      expect(JSON.parse(v), "the variant is the same data").toBeTruthy();
      expect(code(signText(v)), v.slice(0, 70)).toBe("NON_CANONICAL_DOCUMENT");
    }
  });
  it("the verifier never normalises: whatever it authenticates are the received bytes", () => {
    const g = good() as any;
    const spaced = g.canonicalJson.replace('"allowPartialSettlement"', ' "allowPartialSettlement"');
    expect(code({ ...g, canonicalJson: spaced, mandateDigest: sha256Hex(spaced) })).toBe("NON_CANONICAL_DOCUMENT"); // digest consistent, but the received text is not the canonical text and is NOT silently canonicalised
  });
});

describe("Unicode: NFC / NFD / confusables are different bytes and are never normalised", () => {
  const NFC = "café-seller";
  const NFD = "café-seller";
  it("sanity: the two spellings are different strings", () => {
    expect(NFC).not.toBe(NFD);
    expect(NFC.normalize("NFD")).toBe(NFD);
  });
  it("a document carrying the NFD spelling verifies as NFD and the verifier returns it unchanged", () => {
    const r = verify(seal(doc((d) => (d.counterparties = [NFD]))));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document.counterparties).toEqual([NFD]);
  });
  it("swapping NFD for NFC in a signed document (digest recomputed, old signature) is SIGNATURE_INVALID", () => {
    const signed = seal(doc((d) => (d.counterparties = [NFD]))) as any;
    const text = signed.canonicalJson.replace(NFD, NFC);
    expect(text).not.toBe(signed.canonicalJson);
    expect(code({ ...signed, canonicalJson: text, mandateDigest: sha256Hex(text) })).toBe("SIGNATURE_INVALID");
    expect(code({ ...signed, canonicalJson: text })).toBe("DIGEST_MISMATCH");
  });
  it("a Cyrillic homoglyph in principalId changes the digest and the signed payload", () => {
    const signed = seal(doc()) as any;
    const text = signed.canonicalJson.replace("principal-golden-1", "prіncipal-golden-1"); // U+0456
    expect(code({ ...signed, canonicalJson: text, mandateDigest: sha256Hex(text) })).toBe("SIGNATURE_INVALID");
  });
  it("the combining mark written as an escape is a non-canonical spelling of the same data", () => {
    const signed = seal(doc((d) => (d.counterparties = [NFD]))) as any;
    const text = signed.canonicalJson.replace("́", "\\u0301");
    expect(code(seal(doc((d) => (d.counterparties = [NFD])), { text }))).toBe("NON_CANONICAL_DOCUMENT");
  });
  it("a lone surrogate round-trips byte for byte and is judged only by the schema, not silently repaired", () => {
    const d = doc((x) => (x.counterparties = ["a\ud800b"]));
    const r = verify(seal(d));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document.counterparties[0]).toBe("a\ud800b");
  });
});

describe("7. strict V2 schema (a correctly sealed but invalid document is refused)", () => {
  const invalid = (name: string, f: (d: Record<string, any>) => void) => it(name, () => expect(code(seal(doc(f), { payloadDocument: doc() }))).toBe("DOCUMENT_INVALID"));
  it("every authorization field is required: removing any one is DOCUMENT_INVALID", () => {
    for (const k of ["mandateId", "nonce", "principalId", "currency", "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", "counterparties", "injectionPolicy", "allowPartialSettlement", "allowPreDeliveryCancellation", "expiresAt", "languagePolicy", "carryOver"]) {
      expect(code(seal(doc((d) => delete d[k]), { payloadDocument: doc() })), `missing ${k}`).toBe("DOCUMENT_INVALID");
    }
  });
  it("unknown fields at every level are refused", () => {
    for (const f of [(d: any) => (d.extra = 1), (d: any) => (d.carryover = null), (d: any) => (d.languagePolicy.extra = 1), (d: any) => (d.languagePolicy.detector.extra = 1), (d: any) => (d.languagePolicy.humanReview.extra = 1), (d: any) => (d.languagePolicy.criterionScope = [{ criterionId: "quality", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE", extra: 1 }])]) expect(code(seal(doc(f)))).toBe("DOCUMENT_INVALID");
  });
  invalid("mandateId not a cuid", (d) => (d.mandateId = "mandate-1"));
  invalid("mandateId uppercase", (d) => (d.mandateId = d.mandateId.toUpperCase()));
  invalid("mandateId one character short", (d) => (d.mandateId = d.mandateId.slice(1)));
  invalid("nonce uppercase hex", (d) => (d.nonce = d.nonce.toUpperCase()));
  invalid("nonce 31 hex characters", (d) => (d.nonce = d.nonce.slice(1)));
  invalid("nonce 33 hex characters", (d) => (d.nonce = d.nonce + "0"));
  invalid("nonce not hex", (d) => (d.nonce = "z".repeat(32)));
  invalid("currency EUR", (d) => (d.currency = "EUR"));
  invalid("amount with one decimal", (d) => (d.budgetTotal = "100.0"));
  invalid("amount with three decimals", (d) => (d.budgetTotal = "100.001"));
  invalid("amount with a leading zero", (d) => (d.budgetTotal = "0100.00"));
  invalid("amount zero", (d) => (d.perDealMax = "0.00"));
  invalid("amount negative", (d) => (d.perDealMax = "-1.00"));
  invalid("amount as a number", (d) => (d.budgetTotal = 100));
  invalid("perDealMax above budgetTotal", (d) => (d.perDealMax = "200.00"));
  invalid("requireHumanAbove above perDealMax", (d) => (d.requireHumanAbove = "50.00"));
  invalid("requireHumanAbove an empty string", (d) => (d.requireHumanAbove = ""));
  invalid("allowedTaskTypes empty", (d) => (d.allowedTaskTypes = []));
  invalid("allowedTaskTypes unknown", (d) => (d.allowedTaskTypes = ["fraud"]));
  invalid("allowedTaskTypes duplicated", (d) => (d.allowedTaskTypes = ["data_cleaning", "data_cleaning"]));
  invalid("counterparties empty", (d) => (d.counterparties = []));
  invalid("counterparties not in canonical (ascending) order", (d) => (d.counterparties = ["seller-b", "seller-a"]));
  invalid("counterparties duplicated", (d) => (d.counterparties = ["seller-a", "seller-a"]));
  invalid("counterparty empty", (d) => (d.counterparties = [""]));
  invalid("counterparty too long", (d) => (d.counterparties = ["x".repeat(65)]));
  invalid("injectionPolicy unknown", (d) => (d.injectionPolicy = "IGNORE"));
  invalid("allowPartialSettlement as a string", (d) => (d.allowPartialSettlement = "false"));
  invalid("allowPreDeliveryCancellation null", (d) => (d.allowPreDeliveryCancellation = null));
  invalid("expiresAt without milliseconds", (d) => (d.expiresAt = "2030-01-01T00:00:00Z"));
  invalid("expiresAt with an offset", (d) => (d.expiresAt = "2030-01-01T00:00:00.000+01:00"));
  invalid("expiresAt not a date", (d) => (d.expiresAt = "never"));
  invalid("principalId empty", (d) => (d.principalId = ""));
  invalid("principalId too long", (d) => (d.principalId = "p".repeat(129)));
  invalid("carryOver an object (carry-over is not supported at P2)", (d) => (d.carryOver = { previousMandateId: "c0123456789abcdefghijklmn" }));
  invalid("languagePolicy null", (d) => (d.languagePolicy = null));
  invalid("languagePolicy wrong schema tag", (d) => (d.languagePolicy.schema = "mandate.languagePolicy/2"));
  invalid("languagePolicy wrong policyVersion", (d) => (d.languagePolicy.policyVersion = 2));
  invalid("languagePolicy supportedLanguages empty", (d) => (d.languagePolicy.supportedLanguages = []));
  invalid("languagePolicy supportedLanguages unknown language", (d) => (d.languagePolicy.supportedLanguages = ["de"]));
  invalid("languagePolicy supportedLanguages out of order", (d) => (d.languagePolicy.supportedLanguages = ["zh", "en"]));
  invalid("languagePolicy supportedLanguages duplicated", (d) => (d.languagePolicy.supportedLanguages = ["en", "en"]));
  invalid("languagePolicy ALLOW_COUNTED name-like behaviour", (d) => (d.languagePolicy.nameLikeBehavior = "ALLOW_COUNTED"));
  invalid("languagePolicy an 'ALLOW' behaviour", (d) => (d.languagePolicy.unsupportedBehavior = "ALLOW"));
  invalid("languagePolicy short text exempted", (d) => (d.languagePolicy.shortText = "EXEMPT_UNDER_5"));
  invalid("languagePolicy detector hash not sha256:<hex>", (d) => (d.languagePolicy.detector.vocabularyHash = "abc"));
  invalid("languagePolicy detector version not semver", (d) => (d.languagePolicy.detector.version = "1.0"));
  invalid("languagePolicy criterionScope out of order", (d) =>
    (d.languagePolicy.criterionScope = [
      { criterionId: "quality", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" },
      { criterionId: "accuracy", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" },
    ]));
  invalid("languagePolicy criterionScope unknown scope", (d) => (d.languagePolicy.criterionScope = [{ criterionId: "quality", scope: "ALL_FIELDS", rows: "MODEL_SAMPLE" }]));
  invalid("languagePolicy humanReview.required not a boolean", (d) => (d.languagePolicy.humanReview.required = "yes"));
});

describe("8. key resolution comes ONLY from the registry", () => {
  const custom = (rec: Partial<PublicKeyRecord> | null): KeyRegistry => ({ lookup: () => (rec === null ? null : ({ ...recordFor(keys), ...rec } as PublicKeyRecord)) });
  it("unknown key version", () => {
    expect(code(good(), ctx({ registry: createKeyRegistry([]) }))).toBe("KEY_VERSION_UNKNOWN");
    expect(code(seal(doc(), { keyVersion: "k9" }), ctx())).toBe("KEY_VERSION_UNKNOWN");
    expect(code(good(), ctx({ registry: custom(null) }))).toBe("KEY_VERSION_UNKNOWN");
  });
  it("a registry that returns a record for a DIFFERENT version than asked is refused", () => {
    expect(code(good(), ctx({ registry: custom({ keyVersion: "k1" }) }))).toBe("KEY_VERSION_UNKNOWN");
  });
  it("unsupported algorithm in a registry record", () => {
    for (const a of ["none", "rsa-pss", "ed448", "ES256", "", undefined]) expect(code(good(), ctx({ registry: custom({ algorithm: a as never }) })), String(a)).toBe("KEY_ALGORITHM_UNSUPPORTED");
  });
  it("revoked and disabled keys are refused (and any status other than ACTIVE fails closed)", () => {
    expect(code(good(), ctx({ registry: registryFor(keys, "REVOKED") }))).toBe("KEY_REVOKED");
    expect(code(good(), ctx({ registry: registryFor(keys, "DISABLED") }))).toBe("KEY_DISABLED");
    for (const s of ["RETIRED", "active", "", undefined, null, 1]) expect(code(good(), ctx({ registry: custom({ status: s as never }) })), String(s)).toBe("KEY_DISABLED");
  });
  it("a record whose fingerprint does not match its key is refused at verification time too (defence in depth for hand-made registries)", () => {
    expect(code(good(), ctx({ registry: custom({ fingerprint: "0".repeat(64) }) }))).toBe("KEY_FINGERPRINT_MISMATCH");
    expect(code(good(), ctx({ registry: custom({ publicKeyB64: "AAAA" }) }))).toBe("KEY_FINGERPRINT_MISMATCH");
  });
  it("wrong public key: another key registered under the version -> SIGNATURE_INVALID", () => {
    const other = ephemeralKey();
    expect(code(good(), ctx({ registry: registryFor(other) }))).toBe("SIGNATURE_INVALID");
  });
  it("key confusion: signed as k1, presented as k2 that names the same key -> SIGNATURE_INVALID (the key version is inside the signed payload)", () => {
    const k1 = { ...keys, keyVersion: "k1" };
    const env = seal(doc(), { keys: k1 as never, keyVersion: "k1" }) as any;
    const reg = createKeyRegistry([recordFor(keys, "ACTIVE", { keyVersion: "k1" }), recordFor(keys, "ACTIVE", { keyVersion: "k2" })]);
    expect(code(env, ctx({ registry: reg }))).toBe("OK");
    expect(code({ ...env, keyVersion: "k2" }, ctx({ registry: reg }))).toBe("SIGNATURE_INVALID");
  });
  it("a public key placed in the document or the envelope is never used", () => {
    const attacker = ephemeralKey();
    const env = seal(doc((d) => (d.publicKey = attacker.publicKeyB64)), { keys: attacker });
    expect(code(env)).toBe("DOCUMENT_INVALID");
    expect(code({ ...seal(doc(), { keys: attacker }), publicKey: attacker.publicKeyB64 })).toBe("ENVELOPE_INVALID");
    expect(code(seal(doc(), { keys: attacker }))).toBe("SIGNATURE_INVALID"); // signed by a key the registry does not hold under k2
  });
  it("there is no default key: an empty registry refuses everything", () => {
    expect(code(good(), ctx({ registry: createKeyRegistry([]) }))).toBe("KEY_VERSION_UNKNOWN");
  });
});

describe("9. the signature covers purpose, versions, identity, digest, policy hash and every authorization field", () => {
  it("wrong purpose tag (valid signature over a payload with another purpose)", () => {
    for (const p of ["terms-attestation", "mandate-seal ", "Mandate-Seal", "mandate", "", "mandate-seal/v1"]) expect(code(seal(doc(), { payload: (x) => ({ ...x, purpose: p }) })), p).toBe("SIGNATURE_INVALID");
  });
  it("no purpose tag at all (the V1 payload shape) is not accepted", () => {
    expect(code(seal(doc(), { payload: ({ purpose: _p, ...rest }) => rest }))).toBe("SIGNATURE_INVALID");
    void 0;
  });
  it("wrong schema version / seal version inside the signed payload", () => {
    for (const f of [(p: any) => ({ ...p, schemaVersion: 1 }), (p: any) => ({ ...p, schemaVersion: 3 }), (p: any) => ({ ...p, sealVersion: 1 }), (p: any) => ({ ...p, sealVersion: "2" })]) expect(code(seal(doc(), { payload: f }))).toBe("SIGNATURE_INVALID");
  });
  it("wrong key version inside the signed payload", () => {
    expect(code(seal(doc(), { payload: (p) => ({ ...p, keyVersion: "k1" }) }))).toBe("SIGNATURE_INVALID");
  });
  it("wrong mandate id / principal id / language-policy hash / carry-over hash inside the signed payload", () => {
    for (const f of [(p: any) => ({ ...p, mandateId: "c" + "9".repeat(24) }), (p: any) => ({ ...p, principalId: "someone-else" }), (p: any) => ({ ...p, languagePolicyHash: sha256Hex("other policy") }), (p: any) => ({ ...p, carryOverHash: sha256Hex("{}") })]) expect(code(seal(doc(), { payload: f }))).toBe("SIGNATURE_INVALID");
  });
  it("an authorization field missing from the signed payload, or the whole echo missing, is not accepted", () => {
    expect(code(seal(doc(), { payload: ({ authorization: _a, ...rest }) => rest }))).toBe("SIGNATURE_INVALID");
    for (const k of ["currency", "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", "counterparties", "injectionPolicy", "allowPartialSettlement", "allowPreDeliveryCancellation", "expiresAt"]) {
      expect(code(seal(doc(), { payload: (p) => ({ ...p, authorization: Object.fromEntries(Object.entries(p.authorization).filter(([x]) => x !== k)) }) })), `echo without ${k}`).toBe("SIGNATURE_INVALID");
    }
    for (const k of ["languagePolicyHash", "carryOverHash", "mandateDigest", "mandateId", "principalId", "approvedBy", "approvedAt", "approvalMethod", "keyVersion", "schemaVersion", "sealVersion"]) {
      expect(code(seal(doc(), { payload: (p) => Object.fromEntries(Object.entries(p).filter(([x]) => x !== k)) })), `payload without ${k}`).toBe("SIGNATURE_INVALID");
    }
  });
  it("an unknown extra key in the signed payload is not accepted", () => {
    expect(code(seal(doc(), { payload: (p) => ({ ...p, algorithm: "ed25519" }) }))).toBe("SIGNATURE_INVALID");
  });
  it("tampering with ANY authorization field of the document (digest recomputed, old signature kept) is SIGNATURE_INVALID, field by field", () => {
    const signed = good() as any;
    const alternatives: Record<string, unknown> = {
      mandateId: "c" + "1".repeat(24),
      nonce: "ffeeddccbbaa99887766554433221100",
      principalId: "principal-other",
      budgetTotal: "999.00",
      perDealMax: "26.00",
      requireHumanAbove: "11.00",
      allowedTaskTypes: ["data_cleaning"], // identical value: used below to prove an unchanged field verifies
      counterparties: ["seller-a", "seller-c"],
      injectionPolicy: "BLOCK",
      allowPartialSettlement: true,
      allowPreDeliveryCancellation: false,
      expiresAt: "2031-01-01T00:00:00.000Z",
    };
    for (const [k, v] of Object.entries(alternatives)) {
      const d = JSON.parse(signed.canonicalJson) as Record<string, any>;
      d[k] = v;
      const text = canonicalJson(d);
      const c = code({ ...signed, canonicalJson: text, mandateDigest: sha256Hex(text) });
      expect(c, k).toBe(k === "allowedTaskTypes" ? "OK" : "SIGNATURE_INVALID");
    }
    for (const f of [(d: any) => (d.languagePolicy.supportedLanguages = ["en", "fr"]), (d: any) => (d.languagePolicy.humanReview.required = false), (d: any) => (d.languagePolicy.unsupportedBehavior = "REJECT_DELIVERY"), (d: any) => (d.languagePolicy.detector.version = "1.0.1")]) {
      const d = JSON.parse(signed.canonicalJson) as Record<string, any>;
      f(d);
      const text = canonicalJson(d);
      expect(code({ ...signed, canonicalJson: text, mandateDigest: sha256Hex(text) })).toBe("SIGNATURE_INVALID");
    }
  });
  it("tampering with an envelope field that is part of the signed payload (approvedBy, approvedAt) is SIGNATURE_INVALID", () => {
    const g = good() as any;
    expect(code({ ...g, approvedBy: "attacker@example.com" })).toBe("SIGNATURE_INVALID");
    expect(code({ ...g, approvedAt: "2026-11-08T12:00:00.001Z" })).toBe("SIGNATURE_INVALID");
  });
  it("tampered signature: every byte position flipped is SIGNATURE_INVALID or ENVELOPE_INVALID, never accepted", () => {
    const g = good() as any;
    const raw = Buffer.from(g.signature, "base64");
    for (let i = 0; i < raw.length; i++) {
      const b = Buffer.from(raw);
      b[i] = b[i]! ^ 0x01;
      expect(code({ ...g, signature: b.toString("base64") }), `byte ${i}`).toBe("SIGNATURE_INVALID");
    }
  });
  it("a signature made with the V1 seal rules over the V2 digest is not accepted", () => {
    const g = good() as any;
    const v1Payload = canonicalJson({ approvalMethod: g.approvalMethod, approvedAt: g.approvedAt, approvedBy: g.approvedBy, digest: g.mandateDigest, keyVersion: g.keyVersion });
    expect(code({ ...g, signature: signMessage(v1Payload, keys.privateKeyB64) })).toBe("SIGNATURE_INVALID");
  });
});

describe("10. mandate identity and nonce", () => {
  it("the signed mandateId must equal the external record id", () => {
    expect(code(good(), ctx({ mandateId: "c" + "2".repeat(24) }))).toBe("MANDATE_ID_MISMATCH");
    expect(code(good(), ctx({ mandateId: GOLDEN_V2.mandateId.toUpperCase() }))).toBe("MANDATE_ID_MISMATCH");
    expect(code(good(), ctx({ mandateId: "" }))).toBe("MANDATE_ID_MISMATCH");
    expect(code(good(), { registry, expected: {} as never })).toBe("MANDATE_ID_MISMATCH");
    expect(code(good(), { registry, expected: undefined as never })).toBe("MANDATE_ID_MISMATCH");
  });
  it("the nonce must equal the expected nonce when one is supplied", () => {
    expect(code(good(), ctx({ nonce: "ffeeddccbbaa99887766554433221100" }))).toBe("NONCE_MISMATCH");
    expect(code(good(), ctx({ nonce: GOLDEN_V2.nonce.toUpperCase() }))).toBe("NONCE_MISMATCH");
    expect(code(good(), ctx({ nonce: "" }))).toBe("NONCE_MISMATCH");
  });
  it("replay-shaped fixtures: the same sealed envelope presented as another record is refused; a nonce changed by an attacker breaks the signature", () => {
    const env = good() as any;
    expect(code(env, ctx({ mandateId: "c" + "3".repeat(24) }))).toBe("MANDATE_ID_MISMATCH");
    const d = JSON.parse(env.canonicalJson) as Record<string, any>;
    d.nonce = "ffeeddccbbaa99887766554433221100";
    const text = canonicalJson(d);
    expect(code({ ...env, canonicalJson: text, mandateDigest: sha256Hex(text) })).toBe("SIGNATURE_INVALID");
  });
  it("LIMITATION (documented, not claimed away): two DIFFERENT sealed mandates that reuse one nonce both verify - uniqueness is a persistence property of a later stage", () => {
    const a = seal(doc());
    const b = seal(doc((d) => ((d.mandateId = "c" + "4".repeat(24)), (d.budgetTotal = "50.00"), (d.perDealMax = "10.00"), (d.requireHumanAbove = "5.00"))));
    expect(code(a)).toBe("OK");
    expect(code(b, ctx({ mandateId: "c" + "4".repeat(24) }))).toBe("OK");
    expect((a as any).canonicalJson).not.toBe((b as any).canonicalJson);
  });
});

describe("downgrade and cross-protocol confusion (V1 <-> V2)", () => {
  const v1Fixture = MANDATE_FIXTURES.find((f) => f.shape === "V1_FULL")!;
  const v1Sealed = () => {
    const digest = sha256Hex(v1Fixture.canonicalJson);
    const approval = { approvedBy: "p@example.com", approvedAt: "2026-11-08T00:00:00.000Z", approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" };
    const payload = canonicalJson({ approvalMethod: approval.approvalMethod, approvedAt: approval.approvedAt, approvedBy: approval.approvedBy, digest, keyVersion: keys.keyVersion });
    return { canonicalJson: v1Fixture.canonicalJson, mandateDigest: digest, ...approval, keyVersion: keys.keyVersion, signature: signMessage(payload, keys.privateKeyB64) };
  };
  it("a V1 sealed envelope (no sealVersion) under the V2 verifier is refused", () => {
    expect(code(v1Sealed())).toBe("UNSUPPORTED_SEAL_VERSION");
  });
  it("a V1 document wrapped in a V2 envelope and signed with the V2 rules is refused (UNSUPPORTED_SCHEMA_VERSION: it has no schemaVersion 2)", () => {
    for (const f of MANDATE_FIXTURES) expect(code(seal(doc(), { text: f.canonicalJson })), f.shape).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });
  it("a V1 document with sealVersion 2 and its V1 signature is refused", () => {
    expect(code({ ...v1Sealed(), sealVersion: 2 })).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });
  it("a V2 envelope presented to the V1 opener: the V1 opener refuses it (its payload differs, so the V1 signature check fails)", () => {
    const g = good() as any;
    const asV1 = { canonicalJson: g.canonicalJson, mandateDigest: g.mandateDigest, approvedBy: g.approvedBy, approvedAt: g.approvedAt, approvalMethod: g.approvalMethod, keyVersion: g.keyVersion, signature: g.signature };
    expect(openSealedMandateDetailed(asV1, keys.publicKeyB64)).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
  });
  it("a V2 document signed with the V1 seal rules is refused by the V1 opener (P1 guard: explicit schemaVersion is unsupported) and by the V2 verifier", () => {
    const text = canonicalJson(doc());
    const digest = sha256Hex(text);
    const approval = { approvedBy: "p@example.com", approvedAt: "2026-11-08T00:00:00.000Z", approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" };
    const payload = canonicalJson({ ...approval, digest, keyVersion: keys.keyVersion });
    const v1Like = { canonicalJson: text, mandateDigest: digest, ...approval, keyVersion: keys.keyVersion, signature: signMessage(payload, keys.privateKeyB64) };
    expect(openSealedMandateDetailed(v1Like, keys.publicKeyB64)).toEqual({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
    expect(readMandateDocument(text)).toEqual({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
    expect(code(v1Like)).toBe("UNSUPPORTED_SEAL_VERSION");
  });
  it("a V2 document is not assignable to the V1 MandateDocument type the policy and settlement engines consume", () => {
    const r = verify(good());
    if (!r.ok) throw new Error("fixture");
    const v2: MandateDocumentV2 = r.document;
    // @ts-expect-error the V2 document must not be usable where a V1 MandateDocument is required
    const asV1: MandateDocument = v2;
    void asV1;
    expect(v2.schemaVersion).toBe(2);
  });
});

describe("robustness: the verifier never throws and never accepts a mutated envelope", () => {
  it("hostile inputs return a taxonomy code, not an exception", () => {
    const hostile: unknown[] = [null, undefined, 0, "", [], {}, { sealVersion: 2 }, { sealVersion: 2, canonicalJson: {} }, Object.create(null), new Date(), () => 1, Symbol.iterator as unknown, { get sealVersion() { throw new Error("boom"); } }];
    for (const [i, h] of hostile.entries()) {
      let r: V2VerifyResult | undefined;
      expect(() => (r = verify(h)), `hostile #${i}`).not.toThrow();
      expect(r!.ok).toBe(false);
    }
  });
  it("700 single-character mutations of the envelope fields are never accepted", () => {
    const g = good() as any;
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 700; n++) {
      const field = ["canonicalJson", "mandateDigest", "signature", "keyVersion", "approvedBy", "approvedAt"][Math.floor(rnd() * 6)]!;
      const s: string = g[field];
      const i = Math.floor(rnd() * s.length);
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789+/=:.- ";
      let ch = alphabet[Math.floor(rnd() * alphabet.length)]!;
      if (ch === s[i]) ch = ch === "x" ? "y" : "x";
      const mutated = { ...g, [field]: s.slice(0, i) + ch + s.slice(i + 1) };
      expect(verify(mutated).ok, `${field}@${i}`).toBe(false);
    }
  });
  it("every error code the verifier can return is in the published taxonomy, and every published code was produced by at least one test above", () => {
    for (const c of seen) expect(V2_SEAL_ERROR_CODES as readonly string[]).toContain(c);
    const missing = (V2_SEAL_ERROR_CODES as readonly V2SealErrorCode[]).filter((c) => !seen.has(c));
    expect(missing).toEqual([]);
  });
  it("sanity: an unrelated generated key never verifies the golden seal", () => {
    const stranger = generateSigningKeys("k2");
    expect(code(good(), ctx({ registry: registryFor(stranger) }))).toBe("SIGNATURE_INVALID");
  });
});
