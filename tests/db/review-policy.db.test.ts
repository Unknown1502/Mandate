/**
 * Post-verification policy: DB-tested on real PostgreSQL against a MOCKED PayPal. No Sandbox, no real PayPal calls.
 */
import { describe, expect, it } from "vitest";
import { StaleStateError } from "@/domain/deals";
import { NotFoundError } from "@/domain/mandates";
import { verifyChain } from "@/domain/ledger";
import {
  cancelAuthorization,
  challengeVerification,
  expireOverdueReviews,
  reconcileAll,
  recordReverification,
  resolvePostAuthReview,
  settleDeal,
} from "@/settlement/engine";
import { MockPayPal } from "../helpers/mockPayPal";
import { allMet, authorizedDeal, makeCtx, prisma, verifyingDeal } from "./engineFixtures";
import { makePrincipal } from "./fixtures";

const row = (id: string) => prisma.deal.findUniqueOrThrow({ where: { id } });
const ALL = allMet(["schema", "dupes"]);
const GOOD = { criterionId: "schema", reason: "The seller's file still contains duplicated customer ids.", evidenceRefs: ["ledger:1"] };
const MIN = 60_000;

type Base = { dealId: string; p: { id: string; email: string } };
const challenge = (ctx: ReturnType<typeof makeCtx>, b: Base, c: unknown) =>
  challengeVerification(ctx, { dealId: b.dealId, principalId: b.p.id, principalEmail: b.p.email, challenge: c });
const noMoney = (mock: MockPayPal) => mock.writes.filter((w) => w.type === "CAPTURE" || w.type === "VOID");

describe("100% verified delivery follows the signed mandate", () => {
  it("captures the full price; there is no human 'reject' and no human cancel once delivery has happened", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    // before settlement: a human cannot cancel a delivered/verifying deal either
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "changed my mind", actor: "human:x", principalId: base.p.id })).toMatchObject({ status: "REFUSED", reason: "STATE_VERIFYING" });
    await expect(resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "reject" } })).rejects.toThrow();
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
    expect(mock.writesOf("CAPTURE")[0]!.body).toMatchObject({ amount: { value: "20.00" } });
    expect(noMoney(mock).filter((w) => w.type === "VOID")).toHaveLength(0);
  });

  it("an AI-only HIGH risk flag on a perfect delivery does not void; it pauses for a human who still cannot void", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL, {}, [{ code: "INSTR_OVERRIDE", severity: "HIGH", source: "llm" }]);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    await expect(resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "reject" } })).rejects.toThrow();
    expect(noMoney(mock)).toHaveLength(0);
    expect([...mock.auths.values()][0]!.status).toBe("CREATED");
  });

  it("the challenge window holds payment to the seller; a failed contract (VOID) is not delayed", async () => {
    const mock = new MockPayPal();
    let t = Date.now();
    const ctx = makeCtx(mock, { now: () => new Date(t), config: { challengeWindowMs: 10 * MIN } });
    const ok = await verifyingDeal(mock, ctx, ALL);
    expect(await settleDeal(ctx, ok.dealId)).toMatchObject({ status: "WAITING", reason: "CHALLENGE_WINDOW_OPEN", state: "VERIFYING" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
    t += 11 * MIN;
    expect(await settleDeal(ctx, ok.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });

    const bad = await verifyingDeal(mock, ctx, [{ criterionId: "schema", status: "not_met", source: "deterministic" }, ...allMet(["dupes"])]);
    expect(await settleDeal(ctx, bad.dealId)).toMatchObject({ state: "VOIDED" }); // no waiting for the seller-favouring window
  });
});

describe("evidence-backed challenge pauses settlement", () => {
  it("a valid challenge moves to SETTLEMENT_REVIEW, records who/why/evidence, and nothing can settle", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    expect(await challenge(ctx, base, GOOD)).toMatchObject({ status: "DONE", state: "SETTLEMENT_REVIEW" });
    const d = await row(base.dealId);
    expect(d.reviewDeadline).toBeTruthy();
    expect(d.challengesJson).toMatchObject([{ criterionId: "schema", evidenceRefs: ["ledger:1"], by: base.p.email }]);
    const ev = await prisma.dealEvent.findFirstOrThrow({ where: { dealId: base.dealId, type: "STATE_TRANSITION", payload: { path: ["to"], equals: "SETTLEMENT_REVIEW" } } });
    expect(ev.actor).toBe(`human:${base.p.email}`);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "REFUSED", reason: "STATE_SETTLEMENT_REVIEW" });
    expect(await reconcileAll(ctx)).toBeDefined();
    expect(noMoney(mock)).toHaveLength(0);
    expect(await verifyChain(prisma, base.dealId)).toMatchObject({ ok: true });
  });

  it.each([
    ["no reason", { ...GOOD, reason: "" }],
    ["a one-word reason", { ...GOOD, reason: "bad" }],
    ["no evidence", { ...GOOD, evidenceRefs: [] }],
    ["malformed evidence reference", { ...GOOD, evidenceRefs: ["http://insecure.example/x"] }],
    ["an evidence reference that is not a known scheme", { ...GOOD, evidenceRefs: ["trust-me"] }],
    ["a smuggled amount", { ...GOOD, amount: "0.00" }],
    ["a smuggled settlement decision", { ...GOOD, decision: "VOID" }],
  ])("rejects a challenge with %s", async (_n, payload) => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await expect(challenge(ctx, base, payload)).rejects.toThrow();
    expect((await row(base.dealId)).state).toBe("VERIFYING");
  });

  it("refuses unknown criteria, criteria that did not pass, and evidence that does not exist for THIS deal", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, [{ criterionId: "schema", status: "met", source: "deterministic" }, { criterionId: "dupes", status: "not_met", source: "deterministic" }]);
    expect(await challenge(ctx, base, { ...GOOD, criterionId: "nope" })).toMatchObject({ status: "REFUSED", reason: "UNKNOWN_CRITERION" });
    expect(await challenge(ctx, base, { ...GOOD, criterionId: "dupes" })).toMatchObject({ status: "REFUSED", reason: "CRITERION_NOT_PASSED" });
    expect(await challenge(ctx, base, { ...GOOD, evidenceRefs: ["ledger:9999"] })).toMatchObject({ status: "REFUSED", reason: "EVIDENCE_NOT_FOUND:ledger:9999" });
    expect(await challenge(ctx, base, { ...GOOD, evidenceRefs: ["delivery:doesnotexist1"] })).toMatchObject({ status: "REFUSED" });
    const other = await verifyingDeal(mock, ctx, ALL);
    const foreign = await prisma.delivery.create({ data: { dealId: other.dealId, artifactSha256: "x", artifactText: "y" } });
    expect(await challenge(ctx, base, { ...GOOD, evidenceRefs: [`delivery:${foreign.id}`] })).toMatchObject({ status: "REFUSED" }); // another deal's evidence
    expect((await row(base.dealId)).state).toBe("VERIFYING");
    const own = await prisma.delivery.create({ data: { dealId: base.dealId, artifactSha256: "x", artifactText: "y" } });
    expect(await challenge(ctx, base, { ...GOOD, evidenceRefs: [`delivery:${own.id}`, "external:https://evidence.example/report"] })).toMatchObject({ status: "DONE", state: "SETTLEMENT_REVIEW" });
  });

  it("only the owning principal can challenge", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    const intruder = await makePrincipal();
    await expect(challenge(ctx, { dealId: base.dealId, p: intruder }, GOOD)).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(base.dealId)).state).toBe("VERIFYING");
  });

  it("duplicate review submissions: sequential repeat is refused; 4 concurrent identical submissions produce exactly one review", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const a = await verifyingDeal(mock, ctx, ALL);
    expect(await challenge(ctx, a, GOOD)).toMatchObject({ status: "DONE" });
    expect(await challenge(ctx, a, GOOD)).toMatchObject({ status: "REFUSED", reason: "STATE_SETTLEMENT_REVIEW" });

    const b = await verifyingDeal(mock, ctx, ALL);
    const out = await Promise.allSettled(Array.from({ length: 4 }, () => challenge(ctx, b, GOOD)));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    const statuses = out.map((o) => (o as PromiseFulfilledResult<{ status: string }>).value.status);
    expect(statuses.filter((s) => s === "DONE")).toHaveLength(1);
    expect(((await row(b.dealId)).challengesJson as unknown[]).length).toBe(1);
    expect(noMoney(mock)).toHaveLength(0);
  });

  it("a challenge racing a settlement can never produce both a capture and a review", async () => {
    for (let i = 0; i < 4; i++) {
      const mock = new MockPayPal();
      const ctx = makeCtx(mock);
      const base = await verifyingDeal(mock, ctx, ALL);
      const [s, c] = await Promise.allSettled([settleDeal(ctx, base.dealId), challenge(ctx, base, GOOD)]);
      expect(s.status).toBe("fulfilled");
      expect(c.status).toBe("fulfilled");
      const d = await row(base.dealId);
      const captures = mock.writesOf("CAPTURE").length;
      if (d.state === "CAPTURED") {
        expect(captures).toBe(1);
        expect((c as PromiseFulfilledResult<{ status: string }>).value.status).toBe("REFUSED");
      } else {
        expect(d.state).toBe("SETTLEMENT_REVIEW");
        expect(captures).toBe(0);
        expect(await prisma.settlement.count({ where: { dealId: base.dealId } })).toBe(0);
      }
    }
  });
});

describe("re-verification against the ORIGINAL locked terms; the engine decides", () => {
  const reverify = (ctx: ReturnType<typeof makeCtx>, dealId: string, results: unknown, extra: Record<string, unknown> = {}) =>
    recordReverification(ctx, dealId, { results, flags: [], evidenceRefs: ["ledger:1"], ...extra });

  it("still passes -> the engine captures the full pre-agreed amount (no human amount); the previous verification is preserved by hash", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    expect(await reverify(ctx, base.dealId, ALL)).toMatchObject({ status: "DONE", state: "VERIFYING" });
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
    expect(mock.writesOf("CAPTURE")[0]!.body).toMatchObject({ amount: { value: "20.00" } });
    const ev = (await prisma.dealEvent.findMany({ where: { dealId: base.dealId, type: "STATE_TRANSITION" } })).find((e) => (e.payload as { reverification?: boolean }).reverification);
    expect(ev!.payload).toMatchObject({ evidenceRefs: ["ledger:1"], previousVerificationHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await row(base.dealId)).challengesJson).toHaveLength(1); // the challenge record survives
  });

  it("now fails a required deterministic criterion -> the ENGINE computes VOID", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    await reverify(ctx, base.dealId, [{ criterionId: "schema", status: "not_met", source: "deterministic" }, ...allMet(["dupes"])]);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "VOIDED" });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { dealId: base.dealId } })).reasonCodes).toEqual(["REQUIRED_DETERMINISTIC_FAILED:schema"]);
  });

  it("re-verification cannot carry an amount, cannot add criteria, and only works in SETTLEMENT_REVIEW", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    expect(await reverify(ctx, base.dealId, ALL)).toMatchObject({ status: "REFUSED", reason: "STATE_VERIFYING" });
    await challenge(ctx, base, GOOD);
    await expect(reverify(ctx, base.dealId, ALL, { amount: "1.00" })).rejects.toThrow();
    await expect(recordReverification(ctx, base.dealId, { results: ALL, flags: [] })).rejects.toThrow(); // evidence is mandatory
    expect(await reverify(ctx, base.dealId, [...ALL, { criterionId: "bonus", status: "met", source: "deterministic" }])).toMatchObject({ status: "REFUSED", reason: "RESULT_FOR_UNKNOWN_CRITERION" });
    expect((await row(base.dealId)).state).toBe("SETTLEMENT_REVIEW");
  });

  it("terms edited during the review are detected: re-verification is refused against anything but the locked terms", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    const d = await row(base.dealId);
    await prisma.deal.update({ where: { id: base.dealId }, data: { termsJson: { ...(d.termsJson as object), price: "1.00" } } });
    expect(await reverify(ctx, base.dealId, ALL)).toMatchObject({ status: "REFUSED", reason: "TERMS_DRIFT" });
  });

  it("each criterion can be challenged once and the total is capped, so a challenge cannot stall a deal forever", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    await reverify(ctx, base.dealId, ALL);
    expect(await challenge(ctx, base, GOOD)).toMatchObject({ status: "REFUSED", reason: "CHALLENGE_ALREADY_USED_FOR_CRITERION" });
    expect(await challenge(ctx, base, { ...GOOD, criterionId: "dupes" })).toMatchObject({ status: "DONE" });
    await reverify(ctx, base.dealId, ALL);
    expect(await challenge(ctx, base, { ...GOOD, criterionId: "dupes" })).toMatchObject({ status: "REFUSED" });
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
  });
});

describe("review timeout and unresolved challenges never move money", () => {
  it("a timed-out review pauses in NEEDS_HUMAN: no capture, no void, authorization and budget untouched, idempotent", async () => {
    const mock = new MockPayPal();
    let t = Date.now();
    const ctx = makeCtx(mock, { now: () => new Date(t), config: { reviewTimeoutMs: 60 * MIN } });
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    expect(await expireOverdueReviews(ctx)).toEqual([]); // not due yet
    t += 61 * MIN;
    expect(await expireOverdueReviews(ctx)).toEqual([{ dealId: base.dealId, expired: true }]);
    const d = await row(base.dealId);
    expect(d).toMatchObject({ state: "NEEDS_HUMAN", needsHumanFrom: "SETTLEMENT_REVIEW", needsHumanReason: "REVIEW_TIMEOUT" });
    expect(await expireOverdueReviews(ctx)).toEqual([]); // idempotent
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "REFUSED" });
    await reconcileAll(ctx);
    expect(noMoney(mock)).toHaveLength(0);
    expect([...mock.auths.values()][0]!.status).toBe("CREATED");
    expect((await prisma.budgetReservation.findUniqueOrThrow({ where: { dealId: base.dealId } })).status).toBe("ACTIVE");
  });

  it("from a timed-out review the human can only resume it; nothing else is accepted", async () => {
    const mock = new MockPayPal();
    let t = Date.now();
    const ctx = makeCtx(mock, { now: () => new Date(t), config: { reviewTimeoutMs: 60 * MIN } });
    const base = await verifyingDeal(mock, ctx, ALL);
    await challenge(ctx, base, GOOD);
    t += 61 * MIN;
    await expireOverdueReviews(ctx);
    const review = (decision: unknown, who = base.p) => resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: who.id, principalEmail: who.email, decision });
    expect(await review({ kind: "approve" })).toMatchObject({ status: "REFUSED", reason: "CHALLENGE_NEEDS_RESUME_OR_REVERIFICATION" });
    expect(await review({ kind: "retry" })).toMatchObject({ status: "REFUSED" });
    await expect(review({ kind: "reject" })).rejects.toThrow();
    await expect(review({ kind: "resume_review" }, await makePrincipal())).rejects.toBeInstanceOf(NotFoundError);
    expect(await review({ kind: "resume_review" })).toMatchObject({ status: "DONE", state: "SETTLEMENT_REVIEW" });
    expect((await row(base.dealId)).reviewDeadline!.getTime()).toBeGreaterThan(t);
    expect(noMoney(mock)).toHaveLength(0);

    // the resumed review finishes through re-verification and the engine
    await recordReverification(ctx, base.dealId, { results: ALL, flags: [], evidenceRefs: ["ledger:1"] });
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
  });

  it("'resume_review' is refused for any review that is not a timed-out challenge", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL, {}, [{ code: "X", severity: "HIGH", source: "llm" }]);
    await settleDeal(ctx, base.dealId); // -> NEEDS_HUMAN (origin VERIFYING)
    expect(await resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "resume_review" } })).toMatchObject({ status: "REFUSED", reason: "NOT_IN_CHALLENGE_REVIEW" });
    const done = await verifyingDeal(mock, ctx, ALL);
    await settleDeal(ctx, done.dealId);
    await expect(resolvePostAuthReview(ctx, { dealId: done.dealId, principalId: done.p.id, principalEmail: done.p.email, decision: { kind: "resume_review" } })).rejects.toBeInstanceOf(StaleStateError);
  });
});

describe("pre-delivery cancellation follows the signed mandate", () => {
  it("permitted by the mandate: the owner can cancel before delivery", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx);
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "PRINCIPAL_CANCELLED", actor: `human:${base.p.email}`, principalId: base.p.id })).toMatchObject({ status: "DONE", state: "VOIDED" });
  });
  it("forbidden by the mandate: the owner is refused, nothing is sent; a SYSTEM cancel (e.g. invalid authorization) still works", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx, { mandateOver: { allowPreDeliveryCancellation: false } });
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "PRINCIPAL_CANCELLED", actor: "human:x", principalId: base.p.id })).toMatchObject({ status: "REFUSED", reason: "CANCELLATION_NOT_PERMITTED_BY_MANDATE" });
    expect(mock.writesOf("VOID")).toHaveLength(0);
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "AUTHORIZATION_VALIDATION_FAILED", actor: "settlement-engine" })).toMatchObject({ status: "DONE", state: "VOIDED" });
  });
  it("another principal cannot cancel", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx);
    const intruder = await makePrincipal();
    await expect(cancelAuthorization(ctx, { dealId: base.dealId, reason: "X", actor: "human:x", principalId: intruder.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.writesOf("VOID")).toHaveLength(0);
  });
});

describe("signed mandate data is preserved", () => {
  it("the sealed mandate row is byte-identical after a full challenge/review/settlement cycle", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    const before = await prisma.mandate.findFirstOrThrow({ where: { principalId: base.p.id } });
    await challenge(ctx, base, GOOD);
    await recordReverification(ctx, base.dealId, { results: ALL, flags: [], evidenceRefs: ["ledger:1"] });
    await settleDeal(ctx, base.dealId);
    const after = await prisma.mandate.findFirstOrThrow({ where: { principalId: base.p.id } });
    expect(after).toEqual(before);
    expect(JSON.parse(after.canonicalJson)).toMatchObject({ allowPartialSettlement: false, allowPreDeliveryCancellation: true });
  });
});
