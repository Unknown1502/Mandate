/**
 * P7 on real PostgreSQL (mandate_test): the detector release workflow, its database guards, the signed log, and how a release gates real use.
 * Reviewer / approver identities are test strings; no real review has happened and none is claimed.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeDeal } from "@/domain/authorization";
import {
  GovernanceError,
  approveRelease,
  detectorPermission,
  loadDetectorSnapshot,
  recordEvaluation,
  recordReview,
  registerDraft,
  releaseRelease,
  retireRelease,
  revokeRelease,
  rollbackTo,
  verifyRelease,
  type DetectorIdentity,
  type EvaluationReport,
  type Person,
} from "@/domain/detector-registry";
import { DetectorNotReleasedError, approveMandateV2, previewMandateV2 } from "@/domain/mandate-v2-writer";
import { beginNegotiation, createDeal, lockTerms } from "@/domain/deals";
import { createKeyRegistry } from "@/domain/key-registry";
import { registryFromSigningKeys } from "@/domain/v2-keys";
import { generateSigningKeys } from "@/domain/signing";
import { shippedDetector } from "@/verification/language";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReport, failureIds, runFixtures, type FixtureSet } from "../../scripts/lib/detector-eval-core";
import { floorPolicy, llmTermsV2, mandateDraftV2 } from "../helpers/v2Fixtures";
import { keys, makePrincipal, prisma, registry, v2Deps, v2Gate } from "./v2Fixtures";

const load = (n: string): FixtureSet => JSON.parse(readFileSync(resolve(__dirname, "../../eval/detector", n), "utf8")) as FixtureSet;
const tuning = load("tuning.v1.json");
const heldOut = load("heldout.v1.json");
const GAPS = failureIds(runFixtures({ tuning, heldOut }));
const CLEAN = { killed: 14, survived: 0, invalid: 0, unreached: 0, reportSha256: "e".repeat(64) };

const P = (id: string): Person => ({ id, label: `${id}@example.test` });
const SUB = P("submitter"), LANG = P("language-reviewer"), SEC = P("security-reviewer"), APP = P("approver"), REL = P("releaser");

/** a unique detector identity per test (the test database persists across runs; (id, version) and (id, vocabularyHash) are unique) */
const freshIdentity = (): DetectorIdentity => ({ id: `det-${randomBytes(4).toString("hex")}`, version: `${1 + Math.floor(Math.random() * 90)}.${Math.floor(Math.random() * 900)}.${Math.floor(Math.random() * 900)}`, vocabularyHash: `sha256:${randomBytes(32).toString("hex")}` });
const reportFor = (id: DetectorIdentity, over: Partial<Parameters<typeof buildReport>[0]> = {}): EvaluationReport => ({ ...buildReport({ tuning, heldOut, mutation: CLEAN, previous: null, previousReleaseLabel: null, knownGaps: GAPS, languageCoverage: ["en", "fr", "zh"], ...over }), detector: id });
const reg = (id: DetectorIdentity, coverage: Array<"en" | "fr" | "zh"> = ["en", "fr", "zh"], gaps = GAPS) => registerDraft(prisma, { identity: id, languageCoverage: coverage, evaluationDatasetVersion: heldOut.version, knownGaps: gaps, submittedBy: SUB, keys });
const review = (releaseId: string, kind: "LANGUAGE" | "SECURITY", by = kind === "LANGUAGE" ? LANG : SEC, over: Record<string, unknown> = {}) =>
  recordReview(prisma, { releaseId, reviewer: by, keys, review: { kind, outcome: "PASS", findingsSha256: "a".repeat(64), ...(kind === "LANGUAGE" ? { languages: ["en", "fr", "zh"] } : { adversarialCorpusSha256: "b".repeat(64) }), ...over } });

/** drive a release to REVIEW (registered, evaluated) */
async function toReview(id = freshIdentity(), coverage: Array<"en" | "fr" | "zh"> = ["en", "fr", "zh"]) {
  const r = await reg(id, coverage);
  const ev = await recordEvaluation(prisma, { releaseId: r.id, report: reportFor(id), actor: P("evaluator"), keys });
  expect(ev).toMatchObject({ passed: true, status: "REVIEW" });
  return { id, rel: r };
}
async function toReleased(id = freshIdentity(), coverage: Array<"en" | "fr" | "zh"> = ["en", "fr", "zh"]) {
  const x = await toReview(id, coverage);
  await review(x.rel.id, "LANGUAGE");
  await review(x.rel.id, "SECURITY");
  await approveRelease(prisma, { releaseId: x.rel.id, approver: APP, registry, keys });
  await releaseRelease(prisma, { releaseId: x.rel.id, releaser: REL, registry, keys });
  return x;
}
const status = async (id: string) => (await prisma.detectorRelease.findUniqueOrThrow({ where: { id } })).status;
const verified = async (id: string, r = registry) => verifyRelease(await prisma.detectorRelease.findUniqueOrThrow({ where: { id }, include: { events: true } }), r);
const code = (e: unknown) => (e instanceof GovernanceError ? e.code : String(e));
const rejects = async (p: Promise<unknown>) => code(await p.then(() => "RESOLVED", (e: unknown) => e));

describe("the workflow DRAFT -> EVALUATION -> REVIEW -> APPROVED -> RELEASED -> RETIRED", () => {
  it("a release that passes every control reaches RELEASED with a verifiable, signed, hash-chained log", async () => {
    const { rel } = await toReleased();
    expect(await status(rel.id)).toBe("RELEASED");
    const v = await verified(rel.id);
    expect(v).toMatchObject({ ok: true, status: "RELEASED", permissive: false });
    if (v.ok) expect(v.approvedBy).toEqual([APP]);
    const events = await prisma.detectorReleaseEvent.findMany({ where: { releaseId: rel.id }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["SUBMITTED", "EVALUATION_STARTED", "EVALUATION_RECORDED", "EVALUATION_PASSED", "REVIEW_RECORDED", "REVIEW_RECORDED", "APPROVED", "RELEASED"]);
    expect(events.every((e) => /^[0-9a-f]{64}$/.test(e.hash) && e.signature.length === 88 && e.keyVersion === keys.keyVersion)).toBe(true);
    const approved = events.find((e) => e.type === "APPROVED")!;
    expect(approved.payload).toMatchObject({ approver: APP, contentHash: rel.contentHash, vocabularyHash: rel.vocabularyHash, languageReviewer: LANG, securityReviewer: SEC });
    expect(approved.createdAt).toBeInstanceOf(Date);
  });
  it("registration records the immutable manifest; a duplicate version or vocabulary hash is refused", async () => {
    const id = freshIdentity();
    const r = await reg(id, ["en", "fr"]);
    expect(r).toMatchObject({ status: "DRAFT", detectorId: id.id, version: id.version, vocabularyHash: id.vocabularyHash, languageCoverage: ["en", "fr"], evaluationDatasetVersion: heldOut.version, submittedBy: SUB.id });
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await rejects(reg(id))).toBe("DUPLICATE_RELEASE");
    expect(await rejects(reg({ ...freshIdentity(), id: id.id, vocabularyHash: id.vocabularyHash }))).toBe("DUPLICATE_RELEASE");
  });
  it("evaluation controls: each defect keeps the release out of REVIEW and is recorded in the log", async () => {
    const id = freshIdentity();
    const r = await reg(id);
    const bad = (mut: (x: EvaluationReport) => void) => {
      const rep = structuredClone(reportFor(id));
      mut(rep);
      return recordEvaluation(prisma, { releaseId: r.id, report: rep, actor: P("evaluator"), keys });
    };
    expect((await bad((x) => void (x.datasets.heldOut.ids.push(x.datasets.tuning.ids[0]!)))).problems).toContain("TUNING_AND_HELD_OUT_NOT_SEPARATE");
    expect((await bad((x) => void (x.mutation.survived = 2))).problems).toContain("MUTATION_NOT_CLEAN");
    expect((await bad((x) => void (x.knownGaps = x.knownGaps.length ? [] : ["hidden-or-extra-gap"]))).problems).toContain("KNOWN_GAPS_DIFFER_FROM_MANIFEST"); // detector 1.1.0 closes every v1 miss, so the list may already be empty: always make it DIFFER
    expect((await bad((x) => void (x.suites[3]!.undisclosedFailures = 1))).problems).toContain("UNDISCLOSED_FAILURES:PROMPT_INJECTION_REGRESSION");
    expect((await bad((x) => void (x.detector.version = "9.9.9"))).problems).toContain("EVALUATED_DETECTOR_DIFFERS_FROM_RELEASE");
    expect(await status(r.id)).toBe("EVALUATION");
    expect(await rejects(review(r.id, "LANGUAGE"))).toBe("WRONG_STATUS");
    expect(await rejects(approveRelease(prisma, { releaseId: r.id, approver: APP, registry, keys }))).toBe("WRONG_STATUS");
    expect((await prisma.detectorReleaseEvent.count({ where: { releaseId: r.id, type: "EVALUATION_RECORDED" } }))).toBe(5);
    // a clean evaluation afterwards advances it
    expect(await recordEvaluation(prisma, { releaseId: r.id, report: reportFor(id), actor: P("evaluator"), keys })).toMatchObject({ passed: true, status: "REVIEW" });
  });
  it("review independence: not the submitter, language and security by different people, language review covers every claimed language, security names its corpus", async () => {
    const { rel } = await toReview();
    expect(await rejects(review(rel.id, "LANGUAGE", SUB))).toBe("REVIEWER_NOT_INDEPENDENT");
    expect(await rejects(review(rel.id, "LANGUAGE", LANG, { languages: ["en", "fr"] }))).toBe("LANGUAGE_REVIEW_INCOMPLETE");
    expect(await rejects(review(rel.id, "SECURITY", SEC, { adversarialCorpusSha256: undefined }))).toBe("SECURITY_REVIEW_NEEDS_CORPUS");
    await review(rel.id, "LANGUAGE", LANG);
    expect(await rejects(review(rel.id, "SECURITY", LANG))).toBe("REVIEWERS_NOT_DISTINCT");
    await review(rel.id, "SECURITY", SEC);
  });
  it("approval needs both passing reviews, an approver who is not the submitter or a reviewer, and a verifiable release", async () => {
    const { rel } = await toReview();
    expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: APP, registry, keys }))).toBe("REVIEWS_INCOMPLETE");
    await review(rel.id, "LANGUAGE");
    expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: APP, registry, keys }))).toBe("REVIEWS_INCOMPLETE");
    await review(rel.id, "SECURITY");
    for (const who of [SUB, LANG, SEC]) expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: who, registry, keys }))).toBe("APPROVER_NOT_INDEPENDENT");
    // a later FAIL withdraws an earlier PASS
    await review(rel.id, "SECURITY", SEC, { outcome: "FAIL" });
    expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: APP, registry, keys }))).toBe("REVIEWS_INCOMPLETE");
    await review(rel.id, "SECURITY", SEC);
    // approval is refused when the application key that signed the log is not trusted
    expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: APP, registry: registryFromSigningKeys(generateSigningKeys(keys.keyVersion)), keys }))).toBe("RELEASE_UNVERIFIABLE");
    await approveRelease(prisma, { releaseId: rel.id, approver: APP, registry, keys });
    expect(await status(rel.id)).toBe("APPROVED");
    expect(await rejects(releaseRelease(prisma, { releaseId: rel.id, releaser: SUB, registry, keys }))).toBe("RELEASER_NOT_INDEPENDENT");
    expect(await rejects(approveRelease(prisma, { releaseId: rel.id, approver: APP, registry, keys }))).toBe("WRONG_STATUS");
  });
});

describe("database guards and tamper evidence", () => {
  it("a release row is immutable except status; status moves only along the workflow; nothing is deleted", async () => {
    const { rel } = await toReview();
    await expect(prisma.$executeRaw`UPDATE "DetectorRelease" SET "vocabularyHash" = ${"sha256:" + "0".repeat(64)} WHERE id = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`UPDATE "DetectorRelease" SET "manifestJson" = '{}'::jsonb WHERE id = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`UPDATE "DetectorRelease" SET "languageCoverage" = ARRAY['en']::text[] WHERE id = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`UPDATE "DetectorRelease" SET status = 'RELEASED' WHERE id = ${rel.id}`).rejects.toThrow(/illegal detector release status/);
    await expect(prisma.$executeRaw`UPDATE "DetectorRelease" SET status = 'DRAFT' WHERE id = ${rel.id}`).rejects.toThrow(/illegal detector release status/);
    await expect(prisma.$executeRaw`DELETE FROM "DetectorRelease" WHERE id = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`UPDATE "DetectorReleaseEvent" SET actor = 'x' WHERE "releaseId" = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`DELETE FROM "DetectorReleaseEvent" WHERE "releaseId" = ${rel.id}`).rejects.toThrow(/immutable/);
    await expect(prisma.detectorRelease.create({ data: { detectorId: "x", version: "not-semver", vocabularyHash: "sha256:" + "0".repeat(64), contentHash: "0".repeat(64), languageCoverage: ["en"], evaluationDatasetVersion: "v", manifestJson: {}, submittedBy: "s" } })).rejects.toThrow();
  });
  it("tampering with the log (guards bypassed) is detected: payload, hash chain, signature, status and manifest columns", async () => {
    const tamper = async (releaseId: string, sql: string, expected: string) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorReleaseEvent" DISABLE TRIGGER "DetectorReleaseEvent_immutable"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorRelease" DISABLE TRIGGER "DetectorRelease_guard"`);
      try {
        await prisma.$executeRawUnsafe(sql);
        expect(await verified(releaseId)).toEqual({ ok: false, code: expected });
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorReleaseEvent" ENABLE TRIGGER "DetectorReleaseEvent_immutable"`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorRelease" ENABLE TRIGGER "DetectorRelease_guard"`);
      }
    };
    const a = await toReleased();
    expect(await verified(a.rel.id)).toMatchObject({ ok: true });
    await tamper(a.rel.id, `UPDATE "DetectorReleaseEvent" SET payload = jsonb_set(payload, '{approver,id}', '"mallory"') WHERE "releaseId" = '${a.rel.id}' AND type = 'APPROVED'`, "EVENT_HASH_MISMATCH");
    const b = await toReleased();
    await tamper(b.rel.id, `UPDATE "DetectorReleaseEvent" SET signature = '${"A".repeat(86)}==' WHERE "releaseId" = '${b.rel.id}' AND type = 'RELEASED'`, "EVENT_SIGNATURE_INVALID");
    const c = await toReleased();
    await tamper(c.rel.id, `UPDATE "DetectorRelease" SET status = 'RETIRED' WHERE id = '${c.rel.id}'`, "STATUS_DIFFERS_FROM_LOG");
    const d = await toReleased();
    await tamper(d.rel.id, `UPDATE "DetectorRelease" SET "contentHash" = '${"1".repeat(64)}' WHERE id = '${d.rel.id}'`, "CONTENT_HASH_MISMATCH");
    const e = await toReleased();
    await tamper(e.rel.id, `UPDATE "DetectorRelease" SET "languageCoverage" = ARRAY['en']::text[] WHERE id = '${e.rel.id}'`, "COLUMNS_DIFFER_FROM_MANIFEST");
    const f = await toReleased();
    await tamper(f.rel.id, `DELETE FROM "DetectorReleaseEvent" WHERE "releaseId" = '${f.rel.id}' AND type = 'APPROVED'`, "CHAIN_BROKEN");
    // a log signed by a key the registry does not trust grants nothing
    const g = await toReleased();
    expect(await verified(g.rel.id, createKeyRegistry([]))).toEqual({ ok: false, code: "SIGNING_KEY_NOT_TRUSTED" });
    expect(await verified(g.rel.id, registryFromSigningKeys(keys, "REVOKED"))).toEqual({ ok: false, code: "SIGNING_KEY_NOT_TRUSTED" });
  });
});

describe("a detector may be USED only under every condition", () => {
  const snap = async () => loadDetectorSnapshot(prisma, registry);
  it("hash matches an approved release, status permits, coverage meets the policy floor, the build ships exactly that detector", async () => {
    const { id, rel } = await toReleased(freshIdentity(), ["en", "fr"]);
    const s = await snap();
    const newPin = detectorPermission(s, id, "NEW_PIN");
    expect(newPin(id, ["en", "fr"])).toBe(true);
    expect(newPin(id, ["en"])).toBe(true);
    expect(newPin(id, ["en", "zh"])).toBe(false); // the release does not cover zh
    expect(newPin({ ...id, vocabularyHash: `sha256:${"0".repeat(64)}` }, [])).toBe(false); // wrong hash
    expect(newPin({ ...id, version: "999.0.0" }, [])).toBe(false);
    // the build ships a different detector than the one pinned: nothing is permitted
    expect(detectorPermission(s, { ...id, vocabularyHash: `sha256:${"2".repeat(64)}` }, "NEW_PIN")(id, [])).toBe(false);
    // a release that is merely APPROVED, or still in review, is not usable
    const rv = await toReview(freshIdentity());
    expect(detectorPermission(await snap(), rv.id, "NEW_PIN")(rv.id, [])).toBe(false);
    void rel;
  });
  it("RETIRED: usable by what already pins it, not by new pins; REVOKED: never; a corrupted row grants nothing", async () => {
    const { id, rel } = await toReleased();
    await retireRelease(prisma, { releaseId: rel.id, actor: APP, reason: "superseded", keys });
    let s = await snap();
    expect(detectorPermission(s, id, "NEW_PIN")(id, [])).toBe(false);
    expect(detectorPermission(s, id, "EXISTING_PIN")(id, [])).toBe(true);
    await revokeRelease(prisma, { releaseId: rel.id, actor: APP, reason: "defect found", keys });
    s = await snap();
    expect(detectorPermission(s, id, "EXISTING_PIN")(id, [])).toBe(false);
    expect(await status(rel.id)).toBe("REVOKED");
    expect(await rejects(retireRelease(prisma, { releaseId: rel.id, actor: APP, reason: "x", keys }))).toBe("WRONG_STATUS");
    // an unverifiable row is reported and grants nothing
    const bad = await toReleased();
    await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorRelease" DISABLE TRIGGER "DetectorRelease_guard"`);
    try {
      await prisma.$executeRaw`UPDATE "DetectorRelease" SET "contentHash" = ${"2".repeat(64)} WHERE id = ${bad.rel.id}`;
      s = await snap();
      expect(s.rejected.some((r) => r.id === bad.rel.id && r.code === "CONTENT_HASH_MISMATCH")).toBe(true);
      expect(detectorPermission(s, bad.id, "NEW_PIN")(bad.id, [])).toBe(false);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DetectorRelease" ENABLE TRIGGER "DetectorRelease_guard"`);
    }
  });
  it("rollback to an approved prior release: the prior is RELEASED again, the current is retired (or revoked); a never-approved target or a foreign detector is refused", async () => {
    const detId = `det-${randomBytes(4).toString("hex")}`;
    const mk = (n: number): DetectorIdentity => ({ id: detId, version: `1.${n}.0`, vocabularyHash: `sha256:${randomBytes(32).toString("hex")}` });
    const v1 = await toReleased(mk(1));
    await retireRelease(prisma, { releaseId: v1.rel.id, actor: APP, reason: "replaced by 1.2.0", keys });
    const v2 = await toReleased(mk(2));
    const draft = await reg(mk(3));
    expect(await rejects(rollbackTo(prisma, { toReleaseId: draft.id, fromReleaseId: v2.rel.id, actor: APP, reason: "x", registry, keys }))).toBe("WRONG_STATUS");
    const other = await toReleased(freshIdentity());
    expect(await rejects(rollbackTo(prisma, { toReleaseId: other.rel.id, fromReleaseId: v2.rel.id, actor: APP, reason: "x", registry, keys }))).toBe("ROLLBACK_TARGET_INVALID");
    await rollbackTo(prisma, { toReleaseId: v1.rel.id, fromReleaseId: v2.rel.id, actor: APP, reason: "1.2.0 mis-classifies a case", revokeFrom: true, registry, keys });
    expect(await status(v1.rel.id)).toBe("RELEASED");
    expect(await status(v2.rel.id)).toBe("REVOKED");
    expect((await prisma.detectorReleaseEvent.findFirstOrThrow({ where: { releaseId: v1.rel.id, type: "ROLLBACK_TO" } })).payload).toMatchObject({ from: v2.rel.id });
    expect(await verified(v1.rel.id)).toMatchObject({ ok: true, status: "RELEASED" });
    const s = await snap();
    expect(detectorPermission(s, v1.id, "NEW_PIN")(v1.id, [])).toBe(true);
    expect(detectorPermission(s, v2.id, "EXISTING_PIN")(v2.id, [])).toBe(false);
  });
});

describe("permissiveness (docs/15 15.18)", () => {
  it("a release more permissive than its predecessor needs an explicit acknowledgement, is flagged in the log, and is never selectable by existing mandates", async () => {
    const detId = `det-${randomBytes(4).toString("hex")}`;
    const mk = (n: number): DetectorIdentity => ({ id: detId, version: `2.${n}.0`, vocabularyHash: `sha256:${randomBytes(32).toString("hex")}` });
    const first = mk(1);
    const prev = reportFor(first);
    const looser = mk(2);
    const earlier = structuredClone(prev);
    earlier.fixtureOutcomes["tu-lang-en-1"] = "UNSUPPORTED"; // the predecessor refused this; the new detector passes it: more permissive
    const r = await reg(looser);
    const rep = { ...reportFor(looser, { previous: earlier, previousReleaseLabel: first.version }), detector: looser };
    expect(rep.comparison.permissivenessDelta.length).toBeGreaterThan(0);
    await recordEvaluation(prisma, { releaseId: r.id, report: rep, actor: P("evaluator"), keys });
    await review(r.id, "LANGUAGE");
    await review(r.id, "SECURITY");
    await approveRelease(prisma, { releaseId: r.id, approver: APP, registry, keys });
    expect(await rejects(releaseRelease(prisma, { releaseId: r.id, releaser: REL, registry, keys }))).toBe("MORE_PERMISSIVE_NEEDS_ACKNOWLEDGEMENT");
    expect(await status(r.id)).toBe("APPROVED");
    await releaseRelease(prisma, { releaseId: r.id, releaser: REL, acknowledgePermissive: true, registry, keys });
    expect(await verified(r.id)).toMatchObject({ ok: true, status: "RELEASED", permissive: true });
    const ev = await prisma.detectorReleaseEvent.findFirstOrThrow({ where: { releaseId: r.id, type: "RELEASED" } });
    expect(ev.payload).toMatchObject({ permissive: true, selectableByExistingMandates: false });
  });
  it("a mandate or terms that pin an older detector cannot silently adopt a different release: a different triple is a different detector (locking fails)", async () => {
    const p = await makePrincipal();
    const oldId = freshIdentity();
    const newId = freshIdentity();
    const mandate = await approveMandateV2(prisma, { principalId: p.id, principalEmail: p.email, ...(() => { const pv = previewMandateV2(p.id, mandateDraftV2({ languagePolicy: floorPolicy({ detector: oldId }) })); return { draft: pv.draft, confirmDigest: pv.digest }; })(), keys, registry, v2Gate });
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: mandate.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
    await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
    const terms = llmTermsV2(mandate.id, { languagePolicy: floorPolicy({ detector: newId, criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }) });
    await expect(lockTerms(prisma, { dealId: deal.id, terms, actor: "principal", principalId: p.id, deps: { ...v2Deps, detectorPermitted: () => true } })).rejects.toThrow(/LANGUAGE_POLICY_WEAKER_THAN_MANDATE.*DETECTOR_DIFFERS/);
  });
});

describe("a release gates real use (mandate approval, terms lock, authorization)", () => {
  it("a mandate can pin only a RELEASED detector; revocation then stops new deals, existing authorization and verification, fail closed", async () => {
    const { id, rel } = await toReleased(freshIdentity(), ["en", "fr", "zh"]);
    const p = await makePrincipal();
    const s1 = await loadDetectorSnapshot(prisma, registry);
    const policy = floorPolicy({ detector: id });
    const unreleased = freshIdentity();
    const attempt = (det: DetectorIdentity, snapshot = s1) => {
      const pv = previewMandateV2(p.id, mandateDraftV2({ languagePolicy: floorPolicy({ detector: det }) }));
      return approveMandateV2(prisma, { principalId: p.id, principalEmail: p.email, draft: pv.draft, confirmDigest: pv.digest, keys, registry, v2Gate, detectorPermitted: detectorPermission(snapshot, id, "NEW_PIN") });
    };
    await expect(attempt(unreleased)).rejects.toBeInstanceOf(DetectorNotReleasedError);
    const mandate = await attempt(id);
    const pinned = (await prisma.mandate.findUniqueOrThrow({ where: { id: mandate.id } })).canonicalJson;
    expect(pinned).toContain(id.vocabularyHash);
    // deal + lock under the released detector (EXISTING_PIN is what policy and the lock use)
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: mandate.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
    await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
    const terms = llmTermsV2(mandate.id, { languagePolicy: { ...policy, criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] } });
    const deps = (snap: Awaited<ReturnType<typeof loadDetectorSnapshot>>) => ({ ...v2Deps, detectorPermitted: detectorPermission(snap, id, "EXISTING_PIN") });
    await lockTerms(prisma, { dealId: deal.id, terms, actor: "principal", principalId: p.id, deps: deps(s1) });
    expect((await authorizeDeal(prisma, deal.id, deps(s1), { requireAttestation: false })).ok).toBe(true);
    // the release is revoked: authorization of the same deal now fails closed; so would any new lock
    await revokeRelease(prisma, { releaseId: rel.id, actor: APP, reason: "defect", keys });
    const s2 = await loadDetectorSnapshot(prisma, registry);
    expect(await authorizeDeal(prisma, deal.id, deps(s2), { requireAttestation: false })).toMatchObject({ ok: false, reason: "DETECTOR_NOT_PERMITTED" });
    await expect(attempt(id, s2)).rejects.toBeInstanceOf(DetectorNotReleasedError);
  });
  it("the shipped detector's real identity can be registered and its evaluation report validates end to end", async () => {
    // (the real triple is unique in the test database, so a previous run may already have registered it: both outcomes are legitimate)
    const real = shippedDetector();
    const outcome = await reg(real).then((r) => r.status, (e: unknown) => code(e));
    expect(["DRAFT", "DUPLICATE_RELEASE"]).toContain(outcome);
    if (outcome === "DRAFT") {
      const r = await prisma.detectorRelease.findFirstOrThrow({ where: { detectorId: real.id, vocabularyHash: real.vocabularyHash } });
      expect(await recordEvaluation(prisma, { releaseId: r.id, report: buildReport({ tuning, heldOut, mutation: CLEAN, previous: null, previousReleaseLabel: null, knownGaps: GAPS, languageCoverage: ["en", "fr", "zh"] }), actor: P("evaluator"), keys })).toMatchObject({ passed: true });
    }
  });
});
