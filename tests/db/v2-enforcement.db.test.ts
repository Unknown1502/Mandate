/**
 * P5 on real PostgreSQL (mandate_test): the complete V2 lifecycle on the MOCK gateway with a SCRIPTED model, plus the enforcement gates around money.
 * Nothing here is evidence about real PayPal or a real model.
 */
import { describe, expect, it } from "vitest";
import { authorizeDeal } from "@/domain/authorization";
import { verifyChain } from "@/domain/ledger";
import { sweepReservations } from "@/domain/reservations";
import { createPayPalOrder, reconcileAll, settleDeal, type EngineContext } from "@/settlement/engine";
import { submitVerificationToSettlement } from "@/settlement/verification-intake";
import { verifyDelivery } from "@/verification/pipeline";
import { MockPayPal } from "../helpers/mockPayPal";
import { csvBuf, deliverV2, detTerms, llmTerms, makeV2Ctx, prisma, RecordingModel, runnerFor, v2Approved, v2Authorized, v2Deps, v2PendingApproval, V2_HEADERS, V2_ROWS, verdictReply, type V2Terms } from "./v2Fixtures";

class TamperingGateway extends MockPayPal {
  constructor(private readonly hook: () => Promise<void>) {
    super();
  }
  private fired = false;
  /** the tamper is armed only after the fixture has finished (the fixture itself reads the authorization) */
  armed = false;
  override async getAuthorization(id: string) {
    if (this.armed && !this.fired) {
      this.fired = true;
      await this.hook();
    }
    return super.getAuthorization(id);
  }
}

async function delivered(mock: MockPayPal, o: { terms?: V2Terms; model?: RecordingModel; art?: Buffer } = {}) {
  const ctx: EngineContext = makeV2Ctx(mock);
  const base = await v2Authorized(mock, ctx, { terms: o.terms ?? llmTerms });
  const d = await deliverV2(base.dealId, o.art ?? csvBuf(V2_HEADERS, V2_ROWS.map((r) => [...r])));
  if (!d.ok) throw new Error(`delivery ${d.code}`);
  const model = o.model ?? new RecordingModel(verdictReply("met"));
  const verify = () => verifyDelivery({ db: prisma, v2: { authz: v2Deps, runner: runnerFor(model) }, claim: { waitMs: 3000 } }, { dealId: base.dealId });
  return { ctx, base, model, verify, mock };
}
const verified = async (mock: MockPayPal, o: Parameters<typeof delivered>[1] = {}) => {
  const t = await delivered(mock, o);
  const v = await t.verify();
  const intake = await submitVerificationToSettlement(t.ctx, { dealId: t.base.dealId, verificationId: v.result.verificationId });
  return { ...t, v, intake };
};
const writes = (m: MockPayPal, type: string) => m.writes.filter((w) => w.type === type);

describe("the complete V2 lifecycle (MOCK PayPal, SCRIPTED model)", () => {
  it("mandate -> terms -> policy -> preview -> attestation -> reservation -> order -> authorization -> delivery -> verification -> intake -> settlement -> capture, every step bound to the same mandate digest, terms hash and policy", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    expect(t.intake).toMatchObject({ status: "DONE" });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: t.base.dealId } })).state).toBe("VERIFYING");
    const out = await settleDeal(t.ctx, t.base.dealId);
    expect(out).toMatchObject({ status: "DONE", state: "CAPTURED" });
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: t.base.dealId } });
    expect(deal).toMatchObject({ state: "CAPTURED", termsSchemaVersion: 2 });
    expect(writes(mock, "CAPTURE")).toHaveLength(1);
    expect(writes(mock, "VOID")).toHaveLength(0);
    expect(await prisma.budgetReservation.findFirst({ where: { dealId: t.base.dealId } })).toMatchObject({ status: "CONVERTED", amount: expect.anything() });
    // one lineage: the same mandate digest, terms hash and policy hash appear in the attestation, the result binding and the ledger
    const att = await prisma.termsAttestation.findUniqueOrThrow({ where: { dealId: t.base.dealId } });
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { dealId: t.base.dealId } });
    const binding = (run.resultJson as { binding: { mandateDigest: string; termsHash: string; languagePolicyHash: string } }).binding;
    expect([att.mandateDigest, att.termsHash, att.languagePolicyHash]).toEqual([binding.mandateDigest, binding.termsHash, binding.languagePolicyHash]);
    expect(deal.termsHash).toBe(binding.termsHash);
    const events = await prisma.dealEvent.findMany({ where: { dealId: t.base.dealId }, orderBy: { seq: "asc" } });
    const types = events.map((e) => e.type);
    for (const need of ["DEAL_CREATED", "APPROVAL_PREVIEWED", "HUMAN_REVIEW_DECISION", "BUDGET_RESERVED", "DELIVERY_RECEIVED", "VERIFICATION_RECORDED", "VERIFICATION_SUBMITTED"]) expect(types, need).toContain(need);
    const created = events.find((e) => e.type === "DEAL_CREATED")!;
    expect(created.payload).toMatchObject({ mandateDigest: binding.mandateDigest, mandateSchemaVersion: 2 });
    expect((await verifyChain(prisma, t.base.dealId)).ok).toBe(true);
    expect((await authorizeDeal(prisma, t.base.dealId, v2Deps)).ok).toBe(true);
  });
  it("a deterministic-only V2 deal completes with ZERO model calls end to end", async () => {
    const mock = new MockPayPal();
    const model = new RecordingModel(verdictReply("met"));
    const t = await verified(mock, { terms: detTerms, art: csvBuf(["id"], [["1"], ["2"]]), model });
    expect(t.intake).toMatchObject({ status: "DONE" });
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ state: "CAPTURED" });
    expect(model.requests).toHaveLength(0);
    expect(await prisma.agentRun.count({ where: { dealId: t.base.dealId } })).toBe(0);
  });
  it("an AI-judged criterion the model could not verify sends the deal to a human; nothing is captured", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock, { model: new RecordingModel(verdictReply("unverifiable")) });
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
    expect(writes(mock, "VOID")).toHaveLength(0);
  });
});

describe("settlement re-derives the whole authorization", () => {
  it("terms changed after lock: settlement refuses to capture and routes to a human (TERMS_DRIFT)", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    await prisma.$executeRaw`UPDATE "Deal" SET "termsJson" = jsonb_set("termsJson", '{description}', '"changed"') WHERE id = ${t.base.dealId}`;
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "TERMS_DRIFT" });
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
  });
  it("a tampered attestation: settlement refuses (ATTESTATION_INVALID); a revoked mandate: settlement refuses (MANDATE_REVOKED)", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" DISABLE TRIGGER "TermsAttestation_immutable"`);
    try {
      await prisma.$executeRaw`UPDATE "TermsAttestation" SET "signature" = ${"A".repeat(86) + "=="} WHERE "dealId" = ${t.base.dealId}`;
      const r = await settleDeal(t.ctx, t.base.dealId);
      expect(r).toMatchObject({ status: "NEEDS_HUMAN" });
      expect(r.reason).toContain("ATTESTATION_INVALID");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" ENABLE TRIGGER "TermsAttestation_immutable"`);
    }
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
    const mock2 = new MockPayPal();
    const u = await verified(mock2);
    await prisma.mandate.update({ where: { id: u.base.m.id }, data: { revokedAt: new Date() } });
    expect(await settleDeal(u.ctx, u.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "MANDATE_REVOKED" });
    expect(writes(mock2, "CAPTURE")).toHaveLength(0);
  });
  it("authorization lost between the settlement decision and the first CAPTURE send: the capture is NOT sent (pre-send re-derivation), the deal goes to a human", async () => {
    let dealId = "";
    const mock = new TamperingGateway(async () => {
      await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" DISABLE TRIGGER "TermsAttestation_immutable"`);
      try {
        await prisma.$executeRaw`UPDATE "TermsAttestation" SET "signature" = ${"B".repeat(86) + "=="} WHERE "dealId" = ${dealId}`;
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "TermsAttestation" ENABLE TRIGGER "TermsAttestation_immutable"`);
      }
    });
    const t = await verified(mock);
    dealId = t.base.dealId;
    mock.armed = true;
    const r = await settleDeal(t.ctx, t.base.dealId);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(r.reason).toMatch(/PREFLIGHT:AUTHORIZATION:ATTESTATION_INVALID/);
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
    expect((await prisma.payPalOperation.findFirstOrThrow({ where: { dealId, type: "CAPTURE" } })).status).toBe("FAILED");
  });
  it("the mirrored query columns are checked against the signed / locked values: a flipped terms version or language-policy hash stops settlement", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    await prisma.$executeRaw`UPDATE "Deal" SET "termsSchemaVersion" = 1 WHERE id = ${t.base.dealId}`;
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "COLUMN_HINT_MISMATCH" });
    await prisma.$executeRaw`UPDATE "Deal" SET "termsSchemaVersion" = 2, "languagePolicyHash" = ${"f".repeat(64)} WHERE id = ${t.base.dealId}`;
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "COLUMN_HINT_MISMATCH" });
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
  });
  it("a CAPTURE is not sent without an ACTIVE or CONVERTED budget reservation (checked again at the pre-send guard)", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    await prisma.$executeRaw`UPDATE "BudgetReservation" SET status = 'RELEASED'::"ReservationStatus" WHERE "dealId" = ${t.base.dealId}`;
    const r = await settleDeal(t.ctx, t.base.dealId);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(r.reason).toMatch(/PREFLIGHT:AUTHORIZATION:NO_ACTIVE_BUDGET_RESERVATION/);
    expect(writes(mock, "CAPTURE")).toHaveLength(0);
  });
  it("order creation after the mandate expired is refused with nothing changed", async () => {
    const mock = new MockPayPal();
    const base = await v2Approved({ terms: detTerms });
    const late = makeV2Ctx(mock, { now: () => new Date("2031-06-01T00:00:00.000Z") });
    expect(await createPayPalOrder(late, base.dealId)).toMatchObject({ status: "REFUSED", reason: "MANDATE_EXPIRED" });
    expect(mock.writes).toHaveLength(0);
  });
});

describe("financial integrity", () => {
  it("concurrent settlement attempts produce exactly one capture and one settlement row", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    const rs = await Promise.all([1, 2, 3, 4].map(() => settleDeal(t.ctx, t.base.dealId)));
    expect(writes(mock, "CAPTURE")).toHaveLength(1);
    expect(await prisma.settlement.count({ where: { dealId: t.base.dealId } })).toBe(1);
    expect(rs.filter((r) => r.state === "CAPTURED").length).toBeGreaterThanOrEqual(1);
    expect(await settleDeal(t.ctx, t.base.dealId)).toMatchObject({ status: "REFUSED" }); // replay after completion
    expect(writes(mock, "CAPTURE")).toHaveLength(1);
  });
  it("a capture whose response is lost is reconciled WITHOUT a second capture, and the amount is the locked price", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    mock.injectWriteFault("CAPTURE", "timeout_after");
    const first = await settleDeal(t.ctx, t.base.dealId);
    expect(first.status).toBe("UNRESOLVED");
    await reconcileAll(t.ctx);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: t.base.dealId } })).state).toBe("CAPTURED");
    expect(writes(mock, "CAPTURE")).toHaveLength(1);
    expect(writes(mock, "CAPTURE")[0]!.body).toMatchObject({ amount: { value: "20.00", currency_code: "USD" } });
  });
  it("a verification result submitted twice is handed to settlement once", async () => {
    const mock = new MockPayPal();
    const t = await verified(mock);
    const again = await submitVerificationToSettlement(t.ctx, { dealId: t.base.dealId, verificationId: t.v.result.verificationId });
    expect(again).toMatchObject({ status: "DONE", reason: "ALREADY_SUBMITTED" });
    expect(await prisma.dealEvent.count({ where: { dealId: t.base.dealId, type: "VERIFICATION_SUBMITTED" } })).toBe(1);
  });

});

describe("reservation expiry and cleanup", () => {
  it("an idle pre-order V2 deal is BLOCKED and its reservation released after the TTL; a fresh one is untouched; a deal with an order is never touched", async () => {
    const idle = await v2Approved({ terms: detTerms });
    const fresh = await v2Approved({ terms: detTerms });
    const mock = new MockPayPal();
    const ordered = await v2Authorized(mock, makeV2Ctx(mock), { terms: detTerms });
    const old = new Date(Date.now() - 3 * 3_600_000);
    await prisma.$executeRaw`UPDATE "Deal" SET "updatedAt" = ${old} WHERE id = ${idle.dealId}`;
    const sweep = async (m: string) => (await sweepReservations(prisma, { now: new Date(), idleTtlMs: 3_600_000, mandateId: m })).blockedIdle;
    expect(await sweep(idle.m.id)).toContain(idle.dealId);
    expect(await sweep(fresh.m.id)).not.toContain(fresh.dealId);
    expect(await sweep(ordered.m.id)).not.toContain(ordered.dealId);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: idle.dealId } })).state).toBe("BLOCKED");
    expect((await prisma.budgetReservation.findFirstOrThrow({ where: { dealId: idle.dealId } })).status).toBe("RELEASED");
    expect((await prisma.budgetReservation.findFirstOrThrow({ where: { dealId: fresh.dealId } })).status).toBe("ACTIVE");
    expect((await prisma.budgetReservation.findFirstOrThrow({ where: { dealId: ordered.dealId } })).status).toBe("ACTIVE");
    expect((await verifyChain(prisma, idle.dealId)).ok).toBe(true);
  });
  it("an expired mandate frees its pre-order reservations at once; a terminal deal that still holds a reservation is cleaned up (defence in depth); the sweep is idempotent", async () => {
    const x = await v2Approved({ terms: detTerms });
    const later = new Date("2031-06-01T00:00:00.000Z");
    expect((await sweepReservations(prisma, { now: later, idleTtlMs: 10 * 365 * 86_400_000, mandateId: x.m.id })).blockedIdle).toContain(x.dealId);
    const y = await v2Approved({ terms: detTerms });
    await prisma.$executeRaw`UPDATE "Deal" SET state = 'EXPIRED'::"DealState", "needsHumanFrom" = NULL WHERE id = ${y.dealId}`;
    const r = await sweepReservations(prisma, { now: new Date(), idleTtlMs: 3_600_000, mandateId: y.m.id });
    expect(r.releasedTerminal).toContain(y.dealId);
    const again = await sweepReservations(prisma, { now: new Date(), idleTtlMs: 3_600_000, mandateId: y.m.id });
    expect([...again.releasedTerminal, ...again.blockedIdle]).not.toContain(y.dealId);
    expect((await prisma.budgetReservation.findFirstOrThrow({ where: { dealId: y.dealId } })).status).toBe("RELEASED");
  });
});
