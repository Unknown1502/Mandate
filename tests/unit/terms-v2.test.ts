/**
 * P3: strict V2 terms, field classification (bijective mapping, unclassified fails closed), group cap, hashing, dispatching reader.
 */
import { describe, expect, it } from "vitest";
import { readTerms } from "@/domain/terms";
import {
  DEFAULT_MODEL_GROUP_CAP,
  hashAny,
  mappingHashV2,
  modelGroups,
  normalizeTermsV2,
  readAnyTerms,
  readLockedTerms,
  termsHashV2,
  termsMatchLockAny,
  validateTermsV2,
  type TermsV2,
} from "@/domain/terms-v2";
import { floorPolicy, detTermsV2, llmTermsV2, fakeMandateId, deepClone } from "../helpers/v2Fixtures";
import { TERMS_FIXTURES } from "../helpers/legacyFixtures";

const MID = fakeMandateId();
const llm = (over: Partial<TermsV2> = {}) => llmTermsV2(MID, over);
const fields = (t: TermsV2) => t.artifactSchema!.fields;

describe("V2 terms: strict schema", () => {
  it("a valid LLM-criteria V2 document is accepted with no semantic issues", () => {
    const r = readAnyTerms(llm());
    expect(r).toMatchObject({ ok: true, version: 2, issues: [] });
  });
  it("a valid deterministic-only V2 document is accepted", () => {
    expect(readAnyTerms(detTermsV2(MID))).toMatchObject({ ok: true, version: 2, issues: [] });
  });
  it("an unknown key anywhere is TERMS_INVALID (never dropped)", () => {
    expect(readAnyTerms({ ...llm(), extra: 1 })).toEqual({ ok: false, code: "TERMS_INVALID" });
    const t = deepClone(llm());
    (t.criteria[0] as Record<string, unknown>).surprise = true;
    expect(readAnyTerms(t)).toEqual({ ok: false, code: "TERMS_INVALID" });
    const u = deepClone(llm());
    (fields(u)[0] as Record<string, unknown>).hidden = "x";
    expect(readAnyTerms(u)).toEqual({ ok: false, code: "TERMS_INVALID" });
  });
  it("a deterministic criterion cannot carry inputFields / inputMaxRows", () => {
    const t = deepClone(llm());
    (t.criteria[0] as Record<string, unknown>).inputFields = ["col:email"];
    expect(readAnyTerms(t)).toEqual({ ok: false, code: "TERMS_INVALID" });
  });
  it("an llm_judged criterion must carry non-empty inputFields and a bounded inputMaxRows", () => {
    for (const bad of [{ inputFields: [] }, { inputFields: undefined }, { inputMaxRows: 0 }, { inputMaxRows: 16 }, { inputMaxRows: 1.5 }, { inputMaxRows: undefined }]) {
      const t = deepClone(llm()) as unknown as { criteria: Record<string, unknown>[] };
      Object.assign(t.criteria[1]!, bad);
      expect(readAnyTerms(t)).toEqual({ ok: false, code: "TERMS_INVALID" });
    }
  });
  it("only schemaVersion 2 is a V2 document: 1, 3, '2' and null are refused; V1 terms stay on the V1 reader", () => {
    for (const v of [1, 3, "2", null, 2.5]) expect(readAnyTerms({ ...llm(), schemaVersion: v })).toEqual({ ok: false, code: "TERMS_VERSION_UNSUPPORTED" });
    expect(readTerms(llm())).toEqual({ ok: false, code: "TERMS_VERSION_UNSUPPORTED" }); // the V1 reader never reads V2
    const v1 = TERMS_FIXTURES[0]!.terms;
    expect(readAnyTerms(v1)).toMatchObject({ ok: true, version: 1 });
  });
  it("the mandate id must be a V2 mandate id", () => {
    expect(readAnyTerms({ ...llm(), mandateId: "mandate-1" })).toEqual({ ok: false, code: "TERMS_INVALID" });
  });
  it("field ids are NFC and free of control characters", () => {
    const t = deepClone(llm());
    fields(t).push({ id: "col:café", classification: "OPAQUE" }); // NFD
    expect(readAnyTerms(t)).toEqual({ ok: false, code: "TERMS_INVALID" });
    const u = deepClone(llm());
    fields(u).push({ id: "col:bad\u0000id", classification: "OPAQUE" });
    expect(readAnyTerms(u)).toEqual({ ok: false, code: "TERMS_INVALID" });
  });
  it("non-object and hostile inputs never throw", () => {
    for (const v of [null, undefined, 1, "x", [], [llm()], Object.create(null)]) expect(() => readAnyTerms(v)).not.toThrow();
  });
});

describe("V2 terms: classification and mapping (docs/15 15.7)", () => {
  const issues = (t: TermsV2, o?: { modelGroupCap?: number }) => validateTermsV2(t, o).sort();
  it("valid terms have no issues", () => expect(issues(llm())).toEqual([]));
  it("LLM criteria require an artifactSchema and a languagePolicy", () => {
    const t = llm();
    delete t.artifactSchema;
    delete t.languagePolicy;
    expect(issues(t)).toEqual(["ARTIFACT_SCHEMA_REQUIRED", "LANGUAGE_POLICY_REQUIRED"]);
  });
  it("deterministic-only terms may not carry model configuration", () => {
    expect(issues({ ...detTermsV2(MID), artifactSchema: llm().artifactSchema })).toEqual(["MODEL_CONFIG_NOT_ALLOWED"]);
    expect(issues({ ...detTermsV2(MID), languagePolicy: floorPolicy() })).toEqual(["MODEL_CONFIG_NOT_ALLOWED"]);
  });
  it("a field listing a criterion that does not list it back is CLASSIFICATION_CONFLICT (bijection)", () => {
    const t = deepClone(llm());
    (t.criteria[1] as { inputFields: string[] }).inputFields = ["col:description"]; // delivery_notes still lists 'coherent'
    expect(issues(t)).toContain("CLASSIFICATION_CONFLICT");
  });
  it("a criterion listing a CRITERION_INPUT field that does not list the criterion is CLASSIFICATION_CONFLICT", () => {
    const t = deepClone(llm());
    const f = fields(t).find((x) => x.id === "col:delivery_notes")!;
    (f as { classification: string; criteria: string[] }).criteria = ["schema"]; // a deterministic criterion
    expect(issues(t)).toEqual(expect.arrayContaining(["CLASSIFICATION_CONFLICT", "CRITERION_UNKNOWN"]));
  });
  it("a criterion listing an OPAQUE field is refused", () => {
    const t = deepClone(llm());
    (t.criteria[1] as { inputFields: string[] }).inputFields.push("col:email");
    expect(issues(t)).toContain("CLASSIFICATION_CONFLICT");
  });
  it("a criterion listing a field that is not declared at all is FIELD_UNKNOWN_IN_CRITERION (unclassified never reaches a model)", () => {
    const t = deepClone(llm());
    (t.criteria[1] as { inputFields: string[] }).inputFields.push("col:undeclared");
    expect(issues(t)).toContain("FIELD_UNKNOWN_IN_CRITERION");
  });
  it("a field naming an unknown criterion is CRITERION_UNKNOWN", () => {
    const t = deepClone(llm());
    (fields(t).find((x) => x.id === "col:description") as { criteria: string[] }).criteria.push("ghost");
    expect(issues(t)).toContain("CRITERION_UNKNOWN");
  });
  it("duplicate field ids and duplicate criterion ids are refused", () => {
    const t = deepClone(llm());
    fields(t).push({ id: "col:email", classification: "OPAQUE" });
    expect(issues(t)).toContain("FIELD_DUPLICATE");
    const u = deepClone(llm());
    u.criteria.push({ ...u.criteria[0]! });
    expect(issues(u)).toContain("CRITERION_DUPLICATE");
  });
  it("the header row and the manifest namespace must be declared and OPAQUE (column names and metadata are never model-readable here)", () => {
    for (const reserved of ["csv:header", "manifest:artifactReference", "manifest:mediaType", "manifest:metadata"]) {
      const missing = deepClone(llm());
      missing.artifactSchema!.fields = fields(missing).filter((f) => f.id !== reserved);
      expect(issues(missing), reserved).toContain("RESERVED_FIELD_MISSING");
      const promoted = deepClone(llm());
      const idx = fields(promoted).findIndex((f) => f.id === reserved);
      fields(promoted)[idx] = { id: reserved, classification: "CRITERION_INPUT", criteria: ["coherent"] };
      expect(issues(promoted), reserved).toContain("RESERVED_FIELD_NOT_OPAQUE");
    }
  });
  it("languagePolicy.criterionScope must equal the set of llm_judged criteria exactly", () => {
    expect(issues(llm({ languagePolicy: floorPolicy({ criterionScope: [] }) }))).toEqual(["LANGUAGE_SCOPE_MISMATCH"]);
    expect(issues(llm({ languagePolicy: floorPolicy({ criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }, { criterionId: "zzz", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }) }))).toEqual(["LANGUAGE_SCOPE_MISMATCH"]);
  });
});

describe("V2 terms: model groups and the Q5 cap (strictest default)", () => {
  const twoViews = (): TermsV2 => {
    const t = deepClone(llm());
    t.criteria.push({ id: "notes_ok", text: "Notes are professional", type: "llm_judged", inputFields: ["col:delivery_notes"], inputMaxRows: 10, required: false, weight: 0 + 1 } as never);
    (t.criteria[0] as { weight: number }).weight = 69;
    fields(t).find((f) => f.id === "col:delivery_notes")!.classification === "CRITERION_INPUT" && ((fields(t).find((f) => f.id === "col:delivery_notes") as { criteria: string[] }).criteria = ["coherent", "notes_ok"]);
    t.languagePolicy = floorPolicy({ criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }, { criterionId: "notes_ok", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] });
    return t;
  };
  it("the default cap is 1: terms with two distinct views are refused", () => {
    expect(DEFAULT_MODEL_GROUP_CAP).toBe(1);
    expect(validateTermsV2(twoViews())).toEqual(["MODEL_GROUP_CAP_EXCEEDED"]);
  });
  it("a deployment can allow more, but never above the absolute maximum of 5", () => {
    expect(validateTermsV2(twoViews(), { modelGroupCap: 2 })).toEqual([]);
    expect(validateTermsV2(twoViews(), { modelGroupCap: 1_000 })).toEqual([]); // 2 groups <= absolute 5
    expect(modelGroups(twoViews()).map((g) => g.criterionIds)).toEqual(expect.arrayContaining([["coherent"], ["notes_ok"]]));
  });
  it("no deployment setting can raise the number of groups above the absolute maximum of 5", () => {
    const t = deepClone(llm());
    const scope: Array<{ criterionId: string; scope: "INPUT_FIELDS"; rows: "MODEL_SAMPLE" }> = [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }];
    for (let i = 0; i < 5; i++) {
      const id = "extra_" + i;
      t.criteria.push({ id, text: "x", type: "llm_judged", inputFields: ["col:delivery_notes"], inputMaxRows: i + 1, required: false, weight: 1 } as never);
      (fields(t).find((f) => f.id === "col:delivery_notes") as { criteria: string[] }).criteria.push(id);
      scope.push({ criterionId: id, scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" });
    }
    t.languagePolicy = floorPolicy({ criterionScope: scope.sort((a, b) => (a.criterionId < b.criterionId ? -1 : 1)) });
    expect(modelGroups(t)).toHaveLength(6);
    expect(validateTermsV2(t, { modelGroupCap: 1_000 })).toContain("MODEL_GROUP_CAP_EXCEEDED");
    expect(validateTermsV2(t, { modelGroupCap: 6 })).toContain("MODEL_GROUP_CAP_EXCEEDED");
  });
  it("criteria with an identical view share one group", () => {
    const t = deepClone(llm());
    t.criteria.push({ id: "tone", text: "Neutral tone", type: "llm_judged", inputFields: ["col:delivery_notes", "col:description"], inputMaxRows: 15, required: false, weight: 1 } as never);
    (fields(t).find((f) => f.id === "col:description") as { criteria: string[] }).criteria = ["coherent", "tone"];
    (fields(t).find((f) => f.id === "col:delivery_notes") as { criteria: string[] }).criteria = ["coherent", "tone"];
    expect(modelGroups(t)).toHaveLength(1);
    expect(modelGroups(t)[0]!.criterionIds.sort()).toEqual(["coherent", "tone"]);
  });
});

describe("V2 terms: hashes bind everything that influences model exposure", () => {
  it("ordering of criteria, fields and id lists does not change the hash", () => {
    const a = llm();
    const b = deepClone(a);
    b.criteria.reverse();
    b.artifactSchema!.fields.reverse();
    (b.criteria.find((c) => c.type === "llm_judged") as { inputFields: string[] }).inputFields.reverse();
    expect(termsHashV2(b)).toBe(termsHashV2(a));
    expect(mappingHashV2(b)).toBe(mappingHashV2(a));
    expect(normalizeTermsV2(b)).toEqual(normalizeTermsV2(a));
  });
  it("any change to the mapping, classification, row limit, language policy or ordinary terms changes the terms hash", () => {
    const base = termsHashV2(llm());
    const variants: Array<(t: TermsV2) => void> = [
      (t) => ((t.criteria[1] as { inputMaxRows: number }).inputMaxRows = 14),
      (t) => Object.assign(fields(t).find((f) => f.id === "col:email")!, { classification: "CRITERION_INPUT", criteria: ["coherent"] }),
      (t) => fields(t).push({ id: "col:extra", classification: "OPAQUE" }),
      (t) => ((t.languagePolicy!.supportedLanguages as string[]) = ["en"]),
      (t) => ((t.languagePolicy!.detector as { version: string }).version = "1.0.1"),
      (t) => (t.languagePolicy!.humanReview.required = false),
      (t) => (t.price = "21.00"),
      (t) => (t.description = "x"),
    ];
    for (const [i, mutate] of variants.entries()) {
      const t = deepClone(llm());
      mutate(t);
      expect(termsHashV2(t), `variant ${i}`).not.toBe(base);
    }
  });
  it("the mapping hash covers the artifact schema and every criterion's input fields, and nothing else", () => {
    const base = mappingHashV2(llm());
    expect(mappingHashV2(llm({ price: "99.00", description: "other" }))).toBe(base);
    const t = deepClone(llm());
    (t.criteria[1] as { inputFields: string[] }).inputFields = ["col:description"];
    (fields(t).find((f) => f.id === "col:delivery_notes") as { criteria: string[] }).criteria = [];
    expect(mappingHashV2(t)).not.toBe(base);
  });
  it("termsMatchLockAny: valid V2 matches its own hash; any tamper, an invalid classification or a wrong hash does not", () => {
    const t = llm();
    const h = termsHashV2(t);
    expect(termsMatchLockAny(t, h)).toBe(true);
    expect(termsMatchLockAny(t, "0".repeat(64))).toBe(false);
    const tampered = deepClone(t);
    tampered.price = "19.00";
    expect(termsMatchLockAny(tampered, h)).toBe(false);
    const broken = deepClone(t);
    (broken.criteria[1] as { inputFields: string[] }).inputFields.push("col:email");
    expect(termsMatchLockAny(broken, termsHashV2(broken))).toBe(false); // hash matches itself, but the classification is invalid
    expect(readLockedTerms(broken)).toEqual({ ok: false, code: "TERMS_INVALID" });
  });
  it("V1 terms still lock and match through the dispatcher, with their golden hashes", () => {
    for (const f of TERMS_FIXTURES) {
      const r = readAnyTerms(f.terms);
      expect(r).toMatchObject({ ok: true, version: 1 });
      expect(hashAny(r as never)).toBe(f.hash);
      expect(termsMatchLockAny(f.terms, f.hash)).toBe(true);
    }
  });
});
