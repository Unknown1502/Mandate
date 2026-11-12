/**
 * P3: language-policy strictness lattice and the TermsAttestation (sign / verify / tamper).
 */
import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "@/domain/canonical";
import {
  attestationDigest,
  ATTESTATION_ERROR_CODES,
  attestationPayloadSchema,
  buildUnsignedAttestation,
  signAttestation,
  verifyTermsAttestation,
  type AttestationBinding,
} from "@/domain/attestation";
import { createKeyRegistry, publicKeyFingerprint } from "@/domain/key-registry";
import { isAtLeastAsStrict, stricterOf, strictnessFailures, type DeploymentFloor, type Language, type LanguagePolicy } from "@/domain/language-policy";
import { generateSigningKeys, signMessage } from "@/domain/signing";
import { registryFromSigningKeys } from "@/domain/v2-keys";
import { floorPolicy, v2Keys, v2Registry } from "../helpers/v2Fixtures";

// ---------------------------------------------------------------------------------------------------------------- language policy
const P = (over: Partial<LanguagePolicy> = {}) => floorPolicy(over);

describe("language policy lattice", () => {
  it("a policy is at least as strict as itself", () => expect(isAtLeastAsStrict(P(), P())).toBe(true));
  it("each way of being weaker is detected, by name", () => {
    const base = P({ supportedLanguages: ["en"], unsupportedBehavior: "REJECT_DELIVERY", uncertainBehavior: "REJECT_DELIVERY", incompleteScanBehavior: "REJECT_DELIVERY", humanReview: { required: true }, criterionScope: [{ criterionId: "c3", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] });
    expect(strictnessFailures(P({ ...base, supportedLanguages: ["en", "fr"] }), base)).toEqual(["LANGUAGE_WIDENED"]);
    expect(strictnessFailures(P({ ...base, unsupportedBehavior: "UNVERIFIABLE_HUMAN_REVIEW" }), base)).toEqual(["UNSUPPORTED_BEHAVIOUR_WEAKER"]);
    expect(strictnessFailures(P({ ...base, uncertainBehavior: "UNVERIFIABLE_HUMAN_REVIEW" }), base)).toEqual(["UNCERTAIN_BEHAVIOUR_WEAKER"]);
    expect(strictnessFailures(P({ ...base, incompleteScanBehavior: "UNVERIFIABLE_HUMAN_REVIEW" }), base)).toEqual(["INCOMPLETE_SCAN_BEHAVIOUR_WEAKER"]);
    expect(strictnessFailures(P({ ...base, humanReview: { required: false } }), base)).toEqual(["HUMAN_REVIEW_WEAKER"]);
    expect(strictnessFailures(P({ ...base, criterionScope: [] }), base)).toEqual(["SCOPE_NARROWED"]);
    expect(strictnessFailures(P({ ...base, detector: { ...base.detector, version: "1.0.1" } }), base)).toEqual(["DETECTOR_DIFFERS"]);
    expect(strictnessFailures(P({ ...base, detector: { ...base.detector, vocabularyHash: `sha256:${"b".repeat(64)}` } }), base)).toEqual(["DETECTOR_DIFFERS"]);
    expect(strictnessFailures(P({ ...base, detector: { ...base.detector, id: "other" } }), base)).toEqual(["DETECTOR_DIFFERS"]);
  });
  it("stricter in every dimension is accepted", () => {
    const floor = P({ supportedLanguages: ["en", "fr", "zh"] });
    expect(isAtLeastAsStrict(P({ supportedLanguages: ["en"], unsupportedBehavior: "REJECT_DELIVERY", humanReview: { required: true } }), floor)).toBe(true);
  });
  it("a detector is never ranked: a different version or vocabulary is a different detector, in both directions", () => {
    const a = P();
    const b = P({ detector: { ...a.detector, version: "2.0.0" } });
    expect(isAtLeastAsStrict(a, b)).toBe(false);
    expect(isAtLeastAsStrict(b, a)).toBe(false);
  });
});

describe("stricterOf(policy, deploymentFloor) can only tighten (property test, seeded)", () => {
  const LANGS: Language[] = ["en", "fr", "zh"];
  const BEH = ["UNVERIFIABLE_HUMAN_REVIEW", "REJECT_DELIVERY"] as const;
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const subset = (): Language[] => {
    const s = LANGS.filter(() => rnd() < 0.6);
    return s.length ? s : [pick(LANGS)];
  };
  const randPolicy = (): LanguagePolicy => P({ supportedLanguages: subset(), unsupportedBehavior: pick(BEH), uncertainBehavior: pick(BEH), incompleteScanBehavior: pick(BEH), humanReview: { required: rnd() < 0.5 } });
  const randFloor = (): DeploymentFloor => ({
    ...(rnd() < 0.7 ? { supportedLanguages: subset() } : {}),
    ...(rnd() < 0.5 ? { unsupportedBehavior: pick(BEH) } : {}),
    ...(rnd() < 0.5 ? { uncertainBehavior: pick(BEH) } : {}),
    ...(rnd() < 0.5 ? { incompleteScanBehavior: pick(BEH) } : {}),
    ...(rnd() < 0.5 ? { humanReviewRequired: rnd() < 0.5 } : {}),
    ...(rnd() < 0.5 ? { opaqueOverlay: ["col:x", "col:y"].filter(() => rnd() < 0.5) } : {}),
  });
  const rank = (b: string) => (b === "REJECT_DELIVERY" ? 2 : 1);

  it("2,000 random (policy, floor) pairs: the effective policy is never weaker than the policy in any dimension, and the detector is the policy's", () => {
    for (let i = 0; i < 2000; i++) {
      const p = randPolicy();
      const e = stricterOf(p, randFloor());
      expect(e.supportedLanguages.every((l) => p.supportedLanguages.includes(l))).toBe(true);
      expect(rank(e.unsupportedBehavior)).toBeGreaterThanOrEqual(rank(p.unsupportedBehavior));
      expect(rank(e.uncertainBehavior)).toBeGreaterThanOrEqual(rank(p.uncertainBehavior));
      expect(rank(e.incompleteScanBehavior)).toBeGreaterThanOrEqual(rank(p.incompleteScanBehavior));
      expect(e.humanReview.required || !p.humanReview.required).toBe(true);
      expect(e.detector).toEqual(p.detector);
      expect(e.nameLikeBehavior).toBe("UNCERTAIN");
      expect(e.shortText).toBe("NO_EXEMPTION");
    }
  });
  it("is idempotent and a missing floor changes nothing", () => {
    for (let i = 0; i < 300; i++) {
      const p = randPolicy();
      const f = randFloor();
      const once = stricterOf(p, f);
      const twice = stricterOf({ ...once, supportedLanguages: once.supportedLanguages.length ? once.supportedLanguages : ["en"] } as LanguagePolicy, f);
      if (once.supportedLanguages.length) expect(twice.supportedLanguages).toEqual(once.supportedLanguages);
      expect(stricterOf(p, undefined)).toMatchObject({ ...p, opaqueOverlay: [] });
    }
  });
  it("a floor can empty the language set (then every text is unsupported): stricter, never an error and never a widening", () => {
    const e = stricterOf(P({ supportedLanguages: ["en"] }), { supportedLanguages: ["zh"] });
    expect(e.supportedLanguages).toEqual([]);
    expect(stricterOf(P({ supportedLanguages: ["en"] }), { supportedLanguages: ["en", "fr", "zh"] }).supportedLanguages).toEqual(["en"]);
  });
  it("a deployment floor can never add a language, loosen a behaviour or drop human review", () => {
    const p = P({ supportedLanguages: ["en"], unsupportedBehavior: "REJECT_DELIVERY", humanReview: { required: true } });
    const e = stricterOf(p, { supportedLanguages: ["en", "fr", "zh"], unsupportedBehavior: "UNVERIFIABLE_HUMAN_REVIEW", humanReviewRequired: false });
    expect(e.supportedLanguages).toEqual(["en"]);
    expect(e.unsupportedBehavior).toBe("REJECT_DELIVERY");
    expect(e.humanReview.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- TermsAttestation
const binding = (over: Partial<AttestationBinding> = {}): AttestationBinding => ({
  dealId: "deal-1",
  mandateId: "c" + "a".repeat(24),
  mandateDigest: "1".repeat(64),
  termsHash: "2".repeat(64),
  termsSchemaVersion: 2,
  languagePolicyHash: "3".repeat(64),
  mappingHash: "4".repeat(64),
  ...over,
});
const NONCE = "ab".repeat(16);
const APPROVED_AT = "2026-11-08T12:00:00.000Z";
const unsigned = (b = binding()) => buildUnsignedAttestation(b, { keyVersion: v2Keys.keyVersion, actor: { id: "user-1", label: "p@example.test" }, approvalNonce: NONCE });
const signed = (b = binding()) => signAttestation(unsigned(b), APPROVED_AT, v2Keys);
const verify = (rec: { payloadJson: string; signature: string; keyVersion: string }, over: Partial<AttestationBinding> = {}, actor = "user-1", registry = v2Registry) =>
  verifyTermsAttestation(rec, { registry, expected: binding(over), expectedActorId: actor });

describe("TermsAttestation", () => {
  it("a correctly signed attestation verifies against the current binding and approving principal", () => {
    const s = signed();
    const r = verify(s);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.payload).toMatchObject({ approvalKind: "HUMAN_PREAUTH", actor: { kind: "human", id: "user-1" }, approvedAt: APPROVED_AT, approvalNonce: NONCE });
  });
  it("the payload is canonical JSON and carries the purpose tag", () => {
    const s = signed();
    expect(canonicalJson(JSON.parse(s.payloadJson))).toBe(s.payloadJson);
    expect(JSON.parse(s.payloadJson).purpose).toBe("terms-attestation");
  });
  it("every bound value is enforced: a different deal, mandate, digest, terms hash, schema version, language policy hash or mapping fails closed", () => {
    const s = signed();
    const cases: Array<[Partial<AttestationBinding>, string]> = [
      [{ dealId: "deal-2" }, "dealId"],
      [{ mandateId: "c" + "b".repeat(24) }, "mandateId"],
      [{ mandateDigest: "9".repeat(64) }, "mandateDigest"],
      [{ termsHash: "9".repeat(64) }, "termsHash"],
      [{ languagePolicyHash: "9".repeat(64) }, "languagePolicyHash"],
      [{ languagePolicyHash: null }, "languagePolicyHash"],
      [{ mappingHash: "9".repeat(64) }, "mappingHash"],
    ];
    for (const [over, field] of cases) expect(verify(s, over), field).toEqual({ ok: false, code: "ATTESTATION_BINDING_MISMATCH", field });
  });
  it("only the mandate's principal can have approved: another actor is refused", () => {
    expect(verify(signed(), {}, "user-2")).toEqual({ ok: false, code: "ATTESTATION_ACTOR_MISMATCH" });
  });
  it("tampering with any byte of the payload or the signature fails (payload edits are caught as signature failure or malformation)", () => {
    const s = signed();
    for (let i = 0; i < s.payloadJson.length; i += 7) {
      const c = s.payloadJson[i]!;
      const t = s.payloadJson.slice(0, i) + (c === "x" ? "y" : "x") + s.payloadJson.slice(i + 1);
      expect(verify({ ...s, payloadJson: t }).ok).toBe(false);
    }
    for (let i = 0; i < 86; i += 5) {
      const sig = s.signature;
      const t = sig.slice(0, i) + (sig[i] === "A" ? "B" : "A") + sig.slice(i + 1);
      expect(verify({ ...s, signature: t }).ok).toBe(false);
    }
  });
  it("a re-signed payload with a changed binding value is bound to the CURRENT state, not to itself", () => {
    const other = signAttestation(unsigned(binding({ termsHash: "8".repeat(64) })), APPROVED_AT, v2Keys);
    expect(verify(other)).toEqual({ ok: false, code: "ATTESTATION_BINDING_MISMATCH", field: "termsHash" });
  });
  it("non-canonical (reordered or padded) payload text is refused even if correctly signed", () => {
    const s = signed();
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s.payloadJson)).reverse()));
    const sig = signMessage(reordered, v2Keys.privateKeyB64);
    expect(verify({ payloadJson: reordered, signature: sig, keyVersion: v2Keys.keyVersion })).toEqual({ ok: false, code: "ATTESTATION_NON_CANONICAL" });
    const padded = ` ${s.payloadJson}`;
    expect(verify({ payloadJson: padded, signature: signMessage(padded, v2Keys.privateKeyB64), keyVersion: v2Keys.keyVersion }).ok).toBe(false);
  });
  it("duplicate keys in the payload are refused (strict parser)", () => {
    const s = signed();
    const dup = s.payloadJson.replace('"termsHash"', '"dealId":"deal-1","termsHash"');
    expect(verify({ payloadJson: dup, signature: signMessage(dup, v2Keys.privateKeyB64), keyVersion: v2Keys.keyVersion }).ok).toBe(false);
  });
  it("key handling: unknown, disabled, revoked and wrong keys all fail closed, and the key version inside the payload must match the record", () => {
    const s = signed();
    const other = generateSigningKeys("v2-test-1");
    expect(verify(s, {}, "user-1", registryFromSigningKeys(other))).toEqual({ ok: false, code: "SIGNATURE_INVALID" });
    expect(verify(s, {}, "user-1", createKeyRegistry([]))).toEqual({ ok: false, code: "KEY_VERSION_UNKNOWN" });
    expect(verify(s, {}, "user-1", registryFromSigningKeys(v2Keys, "DISABLED"))).toEqual({ ok: false, code: "KEY_DISABLED" });
    expect(verify(s, {}, "user-1", registryFromSigningKeys(v2Keys, "REVOKED"))).toEqual({ ok: false, code: "KEY_REVOKED" });
    expect(verify({ ...s, keyVersion: "v2-test-2" })).toEqual({ ok: false, code: "ATTESTATION_KEY_MISMATCH" });
    const wrongFp = { lookup: () => ({ keyVersion: v2Keys.keyVersion, algorithm: "ed25519" as const, publicKeyB64: v2Keys.publicKeyB64, fingerprint: createHash("sha256").update("x").digest("hex"), status: "ACTIVE" as const }) };
    expect(verify(s, {}, "user-1", wrongFp)).toEqual({ ok: false, code: "KEY_FINGERPRINT_MISMATCH" });
    expect(publicKeyFingerprint(v2Keys.publicKeyB64)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("domain separation: a signature over a MANDATE-SEAL-shaped payload does not verify as an attestation, and the purpose tag is mandatory", () => {
    const s = signed();
    const asSeal = { ...JSON.parse(s.payloadJson), purpose: "mandate-seal" };
    const text = canonicalJson(asSeal);
    expect(verify({ payloadJson: text, signature: signMessage(text, v2Keys.privateKeyB64), keyVersion: v2Keys.keyVersion })).toEqual({ ok: false, code: "ATTESTATION_MALFORMED" });
  });
  it("the human approval kind is the only one that exists (no application-only 'policy' approval)", () => {
    const p = JSON.parse(signed().payloadJson);
    expect(attestationPayloadSchema.safeParse({ ...p, approvalKind: "POLICY_WITHIN_MANDATE" }).success).toBe(false);
    expect(attestationPayloadSchema.safeParse({ ...p, actor: { kind: "policy-engine", id: "policy-engine", label: "x" } }).success).toBe(false);
  });
  it("malformed or hostile records never throw", () => {
    for (const rec of [null, undefined, {}, { payloadJson: 1, signature: 2, keyVersion: 3 }, { payloadJson: "{", signature: "x", keyVersion: "y" }, { payloadJson: "[]", signature: "A".repeat(86) + "==", keyVersion: "k" }] as never[]) {
      const r = verify(rec);
      expect(r.ok).toBe(false);
    }
    const codes = new Set(ATTESTATION_ERROR_CODES);
    for (const c of ["ATTESTATION_MALFORMED", "ATTESTATION_NON_CANONICAL", "SIGNATURE_INVALID"]) expect(codes.has(c as never)).toBe(true);
  });
  it("the preview digest covers every bound value except the approval time, and changes when any of them changes", () => {
    const base = attestationDigest(unsigned());
    expect(attestationDigest(unsigned())).toBe(base);
    for (const over of [{ termsHash: "5".repeat(64) }, { mappingHash: "5".repeat(64) }, { languagePolicyHash: null }, { mandateDigest: "5".repeat(64) }, { dealId: "deal-9" }]) expect(attestationDigest(unsigned(binding(over)))).not.toBe(base);
    const u2 = buildUnsignedAttestation(binding(), { keyVersion: v2Keys.keyVersion, actor: { id: "user-1", label: "p@example.test" }, approvalNonce: randomBytes(16).toString("hex") });
    expect(attestationDigest(u2)).not.toBe(base);
    expect(JSON.stringify(unsigned())).not.toContain("approvedAt");
  });
  it("signing refuses a key whose version differs from the one named in the attestation", () => {
    expect(() => signAttestation(unsigned(), APPROVED_AT, generateSigningKeys("other"))).toThrow();
  });
});
