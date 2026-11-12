import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@/domain/canonical";
import { D, parseMoney, parsePositiveMoney, proportion, fmt, assertUsd } from "@/domain/money";
import { generateSigningKeys } from "@/domain/signing";
import { buildMandateDocument, mandateDigest, mandateDraftSchema, openSealedMandate, sealMandate } from "@/domain/mandate";
import { criteriaIssues, termsHash, termsMatchLock, termsSchema } from "@/domain/terms";
import { goodTerms } from "./helpers";

describe("money", () => {
  it("is exact decimal arithmetic (no float drift)", () => {
    expect(fmt(parseMoney("0.1").add(parseMoney("0.2")))).toBe("0.30");
  });
  it("rejects floats-as-strings, negatives, >2dp, exponent, empty, and non-strings", () => {
    for (const bad of ["1.005", "-1", "1e3", "", " 1", "1,5", "01", "abc"]) expect(() => parseMoney(bad)).toThrow();
    expect(() => parseMoney(5 as unknown as string)).toThrow();
  });
  it("rejects zero for positive amounts", () => {
    expect(() => parsePositiveMoney("0")).toThrow();
    expect(() => parsePositiveMoney("0.00")).toThrow();
  });
  it("only USD", () => {
    expect(() => assertUsd("EUR")).toThrow();
    expect(() => assertUsd("USD")).not.toThrow();
  });
  it("proportion rounds DOWN to cents and enforces 0..100 integers", () => {
    expect(fmt(proportion(new D("20.00"), 70))).toBe("14.00");
    expect(fmt(proportion(new D("10.00"), 33))).toBe("3.30");
    expect(fmt(proportion(new D("0.99"), 50))).toBe("0.49"); // 0.495 -> 0.49, never rounds up
    expect(fmt(proportion(new D("10.00"), 0))).toBe("0.00");
    expect(fmt(proportion(new D("10.00"), 100))).toBe("10.00");
    for (const bad of [-1, 101, 50.5, NaN]) expect(() => proportion(new D("10"), bad)).toThrow();
  });
});

describe("canonicalJson", () => {
  it("is key-order independent and stable", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("fails closed on floats, undefined, NaN, Date, functions", () => {
    for (const bad of [1.5, undefined, NaN, new Date(), () => 1, Infinity]) expect(() => canonicalJson({ x: bad })).toThrow();
  });
  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

const keys = generateSigningKeys("v1");
const draft = mandateDraftSchema.parse({
  currency: "USD",
  budgetTotal: "100",
  perDealMax: "40",
  requireHumanAbove: "30",
  allowedTaskTypes: ["data_cleaning"],
  counterparties: ["seller-sim", "alpha"],
  injectionPolicy: "HUMAN_REVIEW",
  expiresAt: "2030-01-01T00:00:00.000Z",
});
const approval = { approvedBy: "owner@example.com", approvedAt: "2026-11-05T00:00:00.000Z", approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" };

describe("mandate draft and seal", () => {
  it("rejects perDealMax > budgetTotal and requireHumanAbove > perDealMax", () => {
    expect(() => mandateDraftSchema.parse({ ...draft, perDealMax: "200" })).toThrow();
    expect(() => mandateDraftSchema.parse({ ...draft, requireHumanAbove: "50" })).toThrow();
    expect(() => mandateDraftSchema.parse({ ...draft, currency: "EUR" })).toThrow();
    expect(() => mandateDraftSchema.parse({ ...draft, allowedTaskTypes: [] })).toThrow();
  });
  it("digest is order/duplicate independent", () => {
    const a = buildMandateDocument("p1", draft);
    const b = buildMandateDocument("p1", { ...draft, counterparties: ["alpha", "seller-sim", "alpha"] });
    expect(mandateDigest(a)).toBe(mandateDigest(b));
    expect(mandateDigest(a)).not.toBe(mandateDigest(buildMandateDocument("p2", draft)));
  });
  it("opens a valid seal and returns the signed document", () => {
    const sealed = sealMandate(buildMandateDocument("p1", draft), approval, keys);
    expect(openSealedMandate(sealed, keys.publicKeyB64)?.budgetTotal).toBe("100.00");
  });
  it("rejects a tampered document, tampered approval, wrong key, and garbage signature", () => {
    const sealed = sealMandate(buildMandateDocument("p1", draft), approval, keys);
    const doc = JSON.parse(sealed.canonicalJson);
    const forged = canonicalJson({ ...doc, budgetTotal: "999999.00" });
    expect(openSealedMandate({ ...sealed, canonicalJson: forged }, keys.publicKeyB64)).toBeNull();
    expect(openSealedMandate({ ...sealed, canonicalJson: forged, mandateDigest: sha256Hex(forged) }, keys.publicKeyB64)).toBeNull();
    expect(openSealedMandate({ ...sealed, approvedBy: "evil@example.com" }, keys.publicKeyB64)).toBeNull();
    expect(openSealedMandate(sealed, generateSigningKeys().publicKeyB64)).toBeNull();
    expect(openSealedMandate({ ...sealed, signature: "AAAA" }, keys.publicKeyB64)).toBeNull();
    expect(openSealedMandate(sealed, "not-a-key")).toBeNull();
  });
});

describe("terms", () => {
  it("hash is independent of criteria order and changes with price, criteria, deadline", () => {
    const t = goodTerms();
    const reordered = goodTerms({ criteria: [...t.criteria].reverse() });
    expect(termsHash(t)).toBe(termsHash(reordered));
    expect(termsHash(goodTerms({ price: "20.01" }))).not.toBe(termsHash(t));
    expect(termsHash(goodTerms({ deadline: "2029-01-02T00:00:00.000Z" }))).not.toBe(termsHash(t));
    const c = structuredClone(t);
    c.criteria[0]!.weight = 40;
    expect(termsHash(c)).not.toBe(termsHash(t));
  });
  it("drift check", () => {
    const t = goodTerms();
    const h = termsHash(t);
    expect(termsMatchLock(t, h)).toBe(true);
    expect(termsMatchLock({ ...t, price: "25.00" }, h)).toBe(false);
    expect(termsMatchLock("garbage", h)).toBe(false);
  });
  it("criteria structural issues", () => {
    expect(criteriaIssues(goodTerms().criteria)).toEqual([]);
    const c = goodTerms().criteria;
    c[0]!.weight = 60;
    expect(criteriaIssues(c)).toContain("WEIGHTS_NOT_100");
    expect(criteriaIssues(goodTerms().criteria.map((x) => ({ ...x, required: false })))).toContain("NO_REQUIRED_CRITERION");
    const dup = goodTerms().criteria;
    dup[1]!.id = "schema";
    expect(criteriaIssues(dup)).toContain("DUPLICATE_CRITERION_ID");
  });
  it("schema rejects unknown validators, float prices, non-USD, and float params", () => {
    expect(termsSchema.safeParse(goodTerms({ price: "20.123" })).success).toBe(false);
    expect(termsSchema.safeParse({ ...goodTerms(), currency: "EUR" }).success).toBe(false);
    const bad = structuredClone(goodTerms()) as unknown as { criteria: { validator: string }[] };
    bad.criteria[0]!.validator = "run_arbitrary_code";
    expect(termsSchema.safeParse(bad).success).toBe(false);
    const floaty = structuredClone(goodTerms());
    (floaty.criteria[0] as { params: Record<string, unknown> }).params = { rate: 0.5 };
    expect(termsSchema.safeParse(floaty).success).toBe(false);
  });
});
