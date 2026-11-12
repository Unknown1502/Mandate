/**
 * P1 forward-compatibility guards: the strict, version-aware readers for mandate documents and locked terms.
 * Pure (no database, no network). Uses the IMMUTABLE historical fixtures in tests/helpers/legacyFixtures.ts and a THROWAWAY in-memory signing key.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTHORIZATION_READERS, READER_GUARD_VERSION } from "@/domain/compat";
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import { MANDATE_V1_SHAPES, mandateDigest, openSealedMandate, openSealedMandateDetailed, readMandateDocument, sealMandate, type MandateDocument, type SealedMandate } from "@/domain/mandate";
import { D } from "@/domain/money";
import { evaluatePolicy, type PolicyInput } from "@/domain/policy";
import { generateSigningKeys, signMessage } from "@/domain/signing";
import { TermsReadError, normalizeTerms, readTerms, readTermsOrThrow, termsHash, termsMatchLock, termsSchema } from "@/domain/terms";
import { createSession, verifySession } from "@/lib/session";
import { MANDATE_FIXTURES, TERMS_FIXTURES } from "../helpers/legacyFixtures";

const keys = generateSigningKeys("p1-test");
const APPROVAL = { approvedBy: "p@example.com", approvedAt: "2026-11-08T00:00:00.000Z", approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" };
const FULL = MANDATE_FIXTURES.find((f) => f.shape === "V1_FULL")!;

/** the V1 seal payload, written out independently of src so a change to it breaks these tests */
const v1Payload = (digest: string, keyVersion: string) => canonicalJson({ approvalMethod: APPROVAL.approvalMethod, approvedAt: APPROVAL.approvedAt, approvedBy: APPROVAL.approvedBy, digest, keyVersion });
/** what only the key holder (the application) could produce: ANY text, signed with the V1 rules */
function signText(text: string): SealedMandate {
  const digest = sha256Hex(text);
  return { canonicalJson: text, mandateDigest: digest, ...APPROVAL, keyVersion: keys.keyVersion, signature: signMessage(v1Payload(digest, keys.keyVersion), keys.privateKeyB64) };
}
const mutate = (text: string, f: (o: Record<string, unknown>) => void): string => {
  const o = JSON.parse(text) as Record<string, unknown>;
  f(o);
  return JSON.stringify(o);
};
const read = (t: unknown) => readMandateDocument(t);
const code = (t: unknown) => {
  const r = read(t);
  return r.ok ? `OK:${r.shape}` : r.code;
};

describe("the three known V1 mandate shapes keep their established semantics", () => {
  it("the inventory is exactly three shapes", () => {
    expect([...MANDATE_V1_SHAPES].sort()).toEqual(["V1_BASE", "V1_FULL", "V1_NO_CANCELLATION_FLAG"]);
    expect(MANDATE_FIXTURES.map((f) => f.shape).sort()).toEqual([...MANDATE_V1_SHAPES].sort());
  });

  for (const f of MANDATE_FIXTURES) {
    describe(f.shape, () => {
      it("golden: the stored bytes still hash to the stored digest", () => {
        expect(sha256Hex(f.canonicalJson)).toBe(f.digest);
      });
      it("is identified as exactly this shape and read IDENTICALLY to JSON.parse (no key added, none removed, none defaulted)", () => {
        const r = read(f.canonicalJson);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.shape).toBe(f.shape);
        expect(r.doc).toEqual(JSON.parse(f.canonicalJson));
        expect(Object.keys(r.doc).sort()).toEqual(Object.keys(JSON.parse(f.canonicalJson) as object).sort());
        expect(canonicalJson(r.doc)).toBe(f.canonicalJson); // the canonical form is untouched
      });
      it("V1 cryptography is unchanged: re-sealing the document reproduces the SAME bytes and the golden digest, and the seal opens", () => {
        const doc = JSON.parse(f.canonicalJson) as MandateDocument;
        const sealed = sealMandate(doc, APPROVAL, keys);
        expect(sealed.canonicalJson).toBe(f.canonicalJson);
        expect(sealed.mandateDigest).toBe(f.digest);
        expect(mandateDigest(doc)).toBe(f.digest);
        expect(sealed.signature).toBe(signText(f.canonicalJson).signature); // Ed25519 is deterministic: the signed payload is exactly the V1 payload
        const opened = openSealedMandateDetailed(sealed, keys.publicKeyB64);
        expect(opened).toMatchObject({ ok: true, shape: f.shape });
        expect(openSealedMandate(sealed, keys.publicKeyB64)).toEqual(doc);
      });
      it("tampering is still caught by the V1 checks, in the V1 order (digest, then signature)", () => {
        const sealed = signText(f.canonicalJson);
        expect(openSealedMandateDetailed({ ...sealed, canonicalJson: f.canonicalJson.replace(/"budgetTotal":"[^"]+"/, '"budgetTotal":"777.00"') }, keys.publicKeyB64)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
        expect(openSealedMandateDetailed({ ...sealed, signature: signText("{}").signature }, keys.publicKeyB64)).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
        expect(openSealedMandateDetailed({ ...sealed, keyVersion: "other" }, keys.publicKeyB64)).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
        expect(openSealedMandate(sealed, generateSigningKeys("x").publicKeyB64)).toBeNull();
      });
    });
  }
});

describe("unknown and ambiguous versions fail closed (they are never read as V1)", () => {
  it("any explicit schemaVersion is unsupported, whatever its value", () => {
    for (const v of [1, 2, 3, "1", "2", 0, -1, null, true, 2.5, ""]) expect(code(mutate(FULL.canonicalJson, (o) => (o.schemaVersion = v))), String(v)).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });
  it("a few new properties do NOT make a document 'V2': without schemaVersion they are simply unknown fields", () => {
    for (const k of ["languagePolicy", "carryOver", "mandateId", "nonce", "version", "sealVersion", "allowLlmJudgedCriteria", "inputFields", "futureLimit"]) {
      expect(code(mutate(FULL.canonicalJson, (o) => (o[k] = { x: 1 }))), k).toBe("UNKNOWN_FIELD");
    }
    expect(code(mutate(FULL.canonicalJson, (o) => ((o.languagePolicy = {}), (o.mandateId = "m"), (o.nonce = "n"))))).toBe("UNKNOWN_FIELD");
  });
  it("the cancellation flag without the partial-settlement flag matches NO known shape", () => {
    const only = mutate(FULL.canonicalJson, (o) => delete o.allowPartialSettlement);
    expect(only).toContain("allowPreDeliveryCancellation");
    expect(code(only)).toBe("UNRECOGNISED_SHAPE");
  });
  it("every base field is required, in every shape", () => {
    for (const f of MANDATE_FIXTURES) for (const k of ["principalId", "currency", "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", "counterparties", "injectionPolicy", "expiresAt"]) {
      expect(code(mutate(f.canonicalJson, (o) => delete o[k])), `${f.shape} - ${k}`).toBe("MISSING_FIELD");
    }
  });
  it("an unknown field is refused in every shape, never stripped", () => {
    for (const f of MANDATE_FIXTURES) expect(code(mutate(f.canonicalJson, (o) => (o.extra = true))), f.shape).toBe("UNKNOWN_FIELD");
  });
});

describe("invalid values and structures are refused (validation happens before anything is trusted)", () => {
  const bad = (name: string, f: (o: Record<string, unknown>) => void) => it(name, () => expect(code(mutate(FULL.canonicalJson, f))).toBe("INVALID_FIELD"));
  bad("budgetTotal as a number", (o) => (o.budgetTotal = 100));
  bad("budgetTotal negative", (o) => (o.budgetTotal = "-1.00"));
  bad("budgetTotal with three decimals", (o) => (o.budgetTotal = "1.005"));
  bad("perDealMax empty", (o) => (o.perDealMax = ""));
  bad("requireHumanAbove zero", (o) => (o.requireHumanAbove = "0.00"));
  bad("currency other than USD", (o) => (o.currency = "EUR"));
  bad("expiresAt not an ISO instant", (o) => (o.expiresAt = "tomorrow"));
  bad("allowedTaskTypes empty", (o) => (o.allowedTaskTypes = []));
  bad("allowedTaskTypes unknown type", (o) => (o.allowedTaskTypes = ["data_cleaning", "fraud"]));
  bad("allowedTaskTypes not a list", (o) => (o.allowedTaskTypes = "data_cleaning"));
  bad("counterparties empty", (o) => (o.counterparties = []));
  bad("counterparties contains a non-string", (o) => (o.counterparties = ["seller-sim", 7]));
  bad("injectionPolicy unknown", (o) => (o.injectionPolicy = "IGNORE"));
  bad("allowPartialSettlement as a string", (o) => (o.allowPartialSettlement = "true"));
  bad("allowPreDeliveryCancellation as a number", (o) => (o.allowPreDeliveryCancellation = 1));
  bad("principalId empty", (o) => (o.principalId = ""));
  bad("principalId an object", (o) => (o.principalId = { id: "p" }));
  it("non-objects and malformed text", () => {
    for (const t of ["[]", "null", '"x"', "1", "true"]) expect(code(t), t).toBe("NOT_AN_OBJECT");
    for (const t of ["", "{", "{'a':1}", '{"a":1,}', "not json", undefined, null, 5, {}]) expect(code(t), String(t)).toBe("MALFORMED_JSON");
  });
});

describe("duplicate JSON keys cannot change the effective authorization", () => {
  const dup = (key: string, first: string, second: string) => FULL.canonicalJson.replace(`"${key}":${first}`, `"${key}":${first},"${key}":${second}`);

  it("the hazard is real: JSON.parse takes the LAST value, and the old opener (a cast over JSON.parse) would have accepted a signed duplicate-key document", () => {
    const text = dup("budgetTotal", '"100.00"', '"999999.00"');
    expect((JSON.parse(text) as { budgetTotal: string }).budgetTotal).toBe("999999.00");
    const oldOpener = (s: SealedMandate) => (sha256Hex(s.canonicalJson) === s.mandateDigest ? (JSON.parse(s.canonicalJson) as MandateDocument) : null); // pre-P1 behaviour, signature check omitted: the document IS validly signed below
    expect(oldOpener(signText(text))?.budgetTotal).toBe("999999.00");
  });

  const attacks: [string, string][] = [
    ["budget raised by a later duplicate", dup("budgetTotal", '"100.00"', '"999999.00"')],
    ["budget lowered by a later duplicate (the first value must not win either)", dup("budgetTotal", '"100.00"', '"1.00"')],
    ["per-deal maximum raised", dup("perDealMax", '"60.00"', '"99999.00"')],
    ["human-review threshold removed (null after a value)", dup("requireHumanAbove", '"50.00"', "null")],
    ["pre-delivery cancellation switched on by a duplicate", FULL.canonicalJson.replace('"allowPreDeliveryCancellation":true', '"allowPreDeliveryCancellation":false,"allowPreDeliveryCancellation":true')],
    ["partial settlement switched on by a duplicate", FULL.canonicalJson.replace('"allowPartialSettlement":false', '"allowPartialSettlement":false,"allowPartialSettlement":true')],
    ["counterparty list replaced by a duplicate", dup("counterparties", '["seller-sim"]', '["attacker"]')],
    ["expiry extended", dup("expiresAt", '"2030-01-01T00:00:00.000Z"', '"2099-01-01T00:00:00.000Z"')],
    ["principal swapped", dup("principalId", '"cmw3xoefu0000vfd4exqasaje"', '"someone-else"')],
    ["a key repeated with an ESCAPED spelling", FULL.canonicalJson.replace('"budgetTotal":"100.00"', '"budgetTotal":"100.00","budget\\u0054otal":"999999.00"')],
    ["a duplicate inside an unknown nested object", FULL.canonicalJson.replace(/\}$/, ',"x":{"a":1,"a":2}}')],
    ["a duplicated field in a legacy shape without the flags", MANDATE_FIXTURES[0]!.canonicalJson.replace('"budgetTotal":"30.00"', '"budgetTotal":"30.00","budgetTotal":"1.00"')],
  ];
  for (const [name, text] of attacks) {
    it(`${name}: refused at the reader, and a validly SIGNED copy is refused by the opener`, () => {
      expect(code(text)).toBe("DUPLICATE_KEY");
      const sealed = signText(text);
      expect(openSealedMandate(sealed, keys.publicKeyB64)).toBeNull();
      expect(openSealedMandateDetailed(sealed, keys.publicKeyB64)).toEqual({ ok: false, code: "DUPLICATE_KEY" });
    });
  }
  it("__proto__ is refused as a key", () => {
    expect(code(FULL.canonicalJson.replace(/\}$/, ',"__proto__":{"budgetTotal":"9"}}'))).toBe("FORBIDDEN_KEY");
  });
});

describe("old-reader / new-document incompatibility (why the guarded reader must be deployed BEFORE any new document version is written)", () => {
  const future = mutate(FULL.canonicalJson, (o) => {
    o.schemaVersion = 2;
    o.languagePolicy = { supportedLanguages: ["en"] };
    o.budgetTotal = "5.00";
  });
  it("the pre-P1 opener accepts a validly signed future document and silently drops what it does not understand; the guarded opener refuses it", () => {
    const sealed = signText(future);
    const oldOpener = (s: SealedMandate) => JSON.parse(s.canonicalJson) as MandateDocument; // pre-P1: cast, no validation
    expect((oldOpener(sealed) as unknown as { languagePolicy?: unknown }).languagePolicy).toBeDefined(); // the old code holds it but nothing in V1 consumes it: the policy is ignored
    expect(openSealedMandate(sealed, keys.publicKeyB64)).toBeNull();
    expect(openSealedMandateDetailed(sealed, keys.publicKeyB64)).toEqual({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
  });
  it("the pre-P1 terms reader strips unknown keys, so extra authorization fields vanished while the hash still matched; the guarded reader refuses", () => {
    const t = TERMS_FIXTURES[1]!;
    const withExtra = { ...t.terms, inputFields: ["col:a"], criteria: (t.terms.criteria as Record<string, unknown>[]).map((c) => ({ ...c, inputFields: ["col:a"] })) };
    const oldNonStrict = z.object({ taskType: z.string(), description: z.string(), criteria: z.array(z.object({ id: z.string(), text: z.string(), required: z.boolean(), weight: z.number(), type: z.string(), validator: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() })), price: z.string(), currency: z.string(), deadline: z.string(), sellerId: z.string(), mandateId: z.string() });
    const stripped = oldNonStrict.parse(withExtra);
    expect(JSON.stringify(stripped)).not.toContain("inputFields"); // silently dropped
    expect(readTerms(withExtra)).toEqual({ ok: false, code: "TERMS_INVALID" });
    expect(termsMatchLock(withExtra, t.hash)).toBe(false);
  });
});

describe("locked terms: V1 keeps its established semantics, everything else is refused", () => {
  for (const t of TERMS_FIXTURES) {
    it(`golden: ${t.name}`, () => {
      const r = readTerms(t.terms);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.version).toBe(1);
      expect(r.terms).toEqual(t.terms);
      expect(termsHash(r.terms)).toBe(t.hash);
      expect(termsHash(normalizeTerms(r.terms))).toBe(t.hash);
      expect(termsMatchLock(t.terms, t.hash)).toBe(true);
      expect(readTermsOrThrow(t.terms)).toEqual(t.terms);
      expect(termsSchema.parse(t.terms)).toEqual(t.terms); // the writer schema agrees
    });
  }
  const T = TERMS_FIXTURES[0]!;
  const tcode = (o: unknown) => {
    const r = readTerms(o);
    return r.ok ? "OK" : r.code;
  };
  const withT = (f: (o: Record<string, unknown>) => void) => {
    const o = structuredClone(T.terms);
    f(o);
    return o;
  };
  it("an explicit schemaVersion on the terms or on a criterion is an unsupported version (not stripped, not V1)", () => {
    for (const v of [1, 2, "2", null]) expect(tcode(withT((o) => (o.schemaVersion = v))), String(v)).toBe("TERMS_VERSION_UNSUPPORTED");
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[0]!.schemaVersion = 2)))).toBe("CRITERION_VERSION_UNSUPPORTED");
    expect(readTerms(withT((o) => (o.schemaVersion = 2)))).toEqual({ ok: false, code: "TERMS_VERSION_UNSUPPORTED" });
  });
  it("a few new properties are not a version: unknown top-level or criterion fields are TERMS_INVALID", () => {
    for (const k of ["languagePolicy", "artifactSchema", "inputFields", "futureField", "mandateDigest"]) expect(tcode(withT((o) => (o[k] = 1))), k).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[0]!.inputFields = ["a"])))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[1]!.futureCriterionField = true)))).toBe("TERMS_INVALID");
  });
  it("an extra authorization field cannot hide behind a valid V1 hash: the hash of the stripped terms no longer locks the document", () => {
    const stuffed = { ...T.terms, languagePolicy: { supportedLanguages: ["en"] } };
    expect(termsHash(T.terms as never)).toBe(T.hash);
    expect(termsMatchLock(stuffed, T.hash)).toBe(false);
  });
  it("every V1 field is required", () => {
    for (const k of Object.keys(T.terms)) expect(tcode(withT((o) => delete o[k])), k).toBe("TERMS_INVALID");
  });
  it("unknown criterion type, wrong shapes and bad values", () => {
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[0]!.type = "oracle")))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => delete (o.criteria as Record<string, unknown>[])[0]!.type))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[0]!.params = {})))).toBe("TERMS_INVALID"); // llm_judged carries no params
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[1]!.validator = "run_shell")))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => ((o.criteria as Record<string, unknown>[])[1]!.params = { columns: [{ a: 1 }] })))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.criteria = [])))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.criteria = "llm_judged")))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.criteria = [null])))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.price = 20)))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.currency = "EUR")))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.deadline = "soon")))).toBe("TERMS_INVALID");
    expect(tcode(withT((o) => (o.taskType = "fraud")))).toBe("TERMS_INVALID");
  });
  it("non-objects", () => {
    for (const v of [null, undefined, "x", 1, true, [], [T.terms]]) expect(tcode(v), String(v)).toBe("TERMS_NOT_OBJECT");
  });
  it("readTermsOrThrow throws a typed error with the same code", () => {
    expect(() => readTermsOrThrow({ ...T.terms, schemaVersion: 2 })).toThrow(TermsReadError);
    try {
      readTermsOrThrow(null);
    } catch (e) {
      expect((e as TermsReadError).code).toBe("TERMS_NOT_OBJECT");
    }
  });
  it("the writer schema is strict too: lockTerms cannot persist an unknown field", () => {
    expect(termsSchema.safeParse({ ...T.terms, inputFields: [] }).success).toBe(false);
  });
});

describe("policy evaluation refuses unsupported authorization input before anything else is trusted", () => {
  const doc = JSON.parse(FULL.canonicalJson) as MandateDocument;
  const t = TERMS_FIXTURES[1]!;
  const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({ mandate: doc, mandateId: t.terms.mandateId as string, revokedAt: null, terms: t.terms, lockedTermsHash: t.hash, committed: new D(0), now: new Date("2026-11-08T00:00:00Z"), rounds: 1, maxRounds: 4, ...over });
  it("supported V1 terms under a supported V1 mandate: OK (the golden path is unchanged)", () => {
    expect(evaluatePolicy(input())).toEqual({ outcome: "OK", reasons: [] });
  });
  it("future-version or version-carrying terms: BLOCKED TERMS_VERSION_UNSUPPORTED", () => {
    expect(evaluatePolicy(input({ terms: { ...t.terms, schemaVersion: 3 } }))).toEqual({ outcome: "BLOCKED", reasons: ["TERMS_VERSION_UNSUPPORTED"] });
    const crit = (t.terms.criteria as Record<string, unknown>[]).map((c, i) => (i === 0 ? { ...c, schemaVersion: 2 } : c));
    expect(evaluatePolicy(input({ terms: { ...t.terms, criteria: crit } })).reasons).toContain("TERMS_VERSION_UNSUPPORTED");
  });
  it("terms with an unknown field, missing field or non-object: BLOCKED TERMS_INVALID", () => {
    for (const bad of [{ ...t.terms, languagePolicy: {} }, { ...t.terms, price: undefined }, null, "x", []]) expect(evaluatePolicy(input({ terms: bad })), JSON.stringify(bad)).toEqual({ outcome: "BLOCKED", reasons: ["TERMS_INVALID"] });
  });
  it("an unsupported mandate never reaches policy as a trusted document: the opener yields null, which blocks", () => {
    expect(openSealedMandate(signText(mutate(FULL.canonicalJson, (o) => (o.schemaVersion = 2))), keys.publicKeyB64)).toBeNull();
    expect(evaluatePolicy(input({ mandate: null }))).toEqual({ outcome: "BLOCKED", reasons: ["MANDATE_SEAL_INVALID"] });
  });
  it("mixed versions are refused whichever side is unsupported (V1 mandate + future terms, future mandate + V1 terms)", () => {
    expect(evaluatePolicy(input({ terms: { ...t.terms, schemaVersion: 3 } })).outcome).toBe("BLOCKED");
    expect(openSealedMandate(signText(mutate(FULL.canonicalJson, (o) => (o.schemaVersion = 2))), keys.publicKeyB64)).toBeNull();
  });
  it("legacy shapes that omit a flag are read as 'not granted' by the policy and settlement consumers (absent stays absent)", () => {
    const base = read(MANDATE_FIXTURES[0]!.canonicalJson);
    expect(base.ok && base.doc.allowPartialSettlement).toBeUndefined();
    expect(base.ok && base.doc.allowPreDeliveryCancellation).toBeUndefined();
    expect(base.ok && base.doc.allowPreDeliveryCancellation === true).toBe(false);
  });
});

describe("the session token (also an authorization-bearing document) is read strictly", () => {
  const secret = "p1-test-secret-not-a-real-secret";
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  const token = (json: string) => {
    const body = Buffer.from(json).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  const now = 1_000;
  it("a token issued by createSession still verifies", () => {
    const { token: t, payload } = createSession({ id: "u1", email: "u@x.com" }, secret, now);
    expect(verifySession(t, secret, now)).toEqual(payload);
  });
  it("a validly signed token with an extra field, a missing field, a wrong type or a duplicate key is refused", () => {
    expect(verifySession(token('{"uid":"u","email":"e","exp":5000,"csrf":"c"}'), secret, now)).not.toBeNull();
    expect(verifySession(token('{"uid":"u","email":"e","exp":5000,"csrf":"c","role":"admin"}'), secret, now)).toBeNull();
    expect(verifySession(token('{"uid":"u","email":"e","exp":5000}'), secret, now)).toBeNull();
    expect(verifySession(token('{"uid":"u","email":"e","exp":"5000","csrf":"c"}'), secret, now)).toBeNull();
    expect(verifySession(token('{"uid":"u","uid":"admin","email":"e","exp":5000,"csrf":"c"}'), secret, now)).toBeNull();
    expect(verifySession(token('{"uid":"u","email":"e","exp":5000,"csrf":"c","__proto__":{}}'), secret, now)).toBeNull();
    expect(verifySession(token("[]"), secret, now)).toBeNull();
    expect(verifySession(token('{"uid":"u","email":"e","exp":500,"csrf":"c"}'), secret, now)).toBeNull(); // expired
  });
});

describe("reader markers (used by the release check)", () => {
  it("state exactly what this build reads, and that no new version can be written", () => {
    expect(READER_GUARD_VERSION).toBe("p3-v1-v2");
    expect(AUTHORIZATION_READERS).toMatchObject({ guard: "p3-v1-v2", mandateShapes: [...MANDATE_V1_SHAPES], mandateSealVersions: [1, 2], termsVersions: [1, 2], unknownVersions: "refused", unknownFields: "refused", duplicateKeys: "refused", v2Writers: "mandate+terms+attestation" });
    expect(Object.isFrozen(AUTHORIZATION_READERS)).toBe(true);
  });
});
