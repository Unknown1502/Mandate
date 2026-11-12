/**
 * Settlement Engine: DB-tested on real PostgreSQL (mandate_test) against a MOCKED PayPal.
 * NOTHING here touches PayPal Sandbox; results prove our orchestration, not PayPal's behaviour.
 */
import { describe, expect, it } from "vitest";
import { checkPolicy, createDeal, beginNegotiation, lockTerms, resolvePreAuthReview, StaleStateError } from "@/domain/deals";
import { NotFoundError } from "@/domain/mandates";
import { verifyChain } from "@/domain/ledger";
import { committedFor } from "@/domain/budget";
import { cancelAuthorization, createPayPalOrder, reconcileAll, reconcileOperation, refreshBuyerApproval, resolvePostAuthReview, resolveSettlementPending, settleDeal } from "@/settlement/engine";
import { MockPayPal } from "../helpers/mockPayPal";
import { allMet, authorizedDeal, det, deps, keys, llm, makeCtx, policyCheckedDeal, prisma, verifyingDeal } from "./engineFixtures";
import { makeMandate, makePrincipal, termsFor } from "./fixtures";

const row = (dealId: string) => prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
const ops = (dealId: string, type?: "CAPTURE" | "VOID") => prisma.payPalOperation.findMany({ where: { dealId, ...(type ? { type } : {}) }, orderBy: { seq: "asc" } });
const reservation = (dealId: string) => prisma.budgetReservation.findUniqueOrThrow({ where: { dealId } });
const ALL = allMet(["schema", "dupes"]);

describe("order creation", () => {
  it("persists the operation (SENT, attempt 1) BEFORE the PayPal request, with a deterministic request id", async () => {
    const mock = new MockPayPal();
    let seen: { status: string; attempts: number } | undefined;
    mock.onWrite = async ({ requestId }) => {
      const op = await prisma.payPalOperation.findUnique({ where: { requestId } });
      seen = { status: op!.status, attempts: op!.attemptCount };
    };
    const base = await policyCheckedDeal();
    const res = await createPayPalOrder(makeCtx(mock), base.dealId);
    expect(res).toMatchObject({ status: "DONE", state: "AWAITING_BUYER_APPROVAL" });
    expect(seen).toEqual({ status: "SENT", attempts: 1 });
    const [op] = await ops(base.dealId);
    expect(op).toMatchObject({ requestId: `${base.dealId}-CREATE_ORDER-1`, status: "CONFIRMED", path: "/v2/checkout/orders" });
    expect((await row(base.dealId)).approvalUrl).toContain("token=");
  });

  it("refuses without an ACTIVE budget reservation, and blocks on terms drift; neither sends anything", async () => {
    const mock = new MockPayPal();
    const a = await policyCheckedDeal();
    await prisma.budgetReservation.update({ where: { dealId: a.dealId }, data: { status: "RELEASED" } });
    expect(await createPayPalOrder(makeCtx(mock), a.dealId)).toMatchObject({ status: "REFUSED", reason: "NO_ACTIVE_BUDGET_RESERVATION" });

    const b = await policyCheckedDeal();
    const d = await row(b.dealId);
    await prisma.deal.update({ where: { id: b.dealId }, data: { termsJson: { ...(d.termsJson as object), price: "21.00" } } });
    expect(await createPayPalOrder(makeCtx(mock), b.dealId)).toMatchObject({ status: "REFUSED", reason: "TERMS_DRIFT", state: "BLOCKED" });
    expect((await reservation(b.dealId)).status).toBe("RELEASED");
    expect(mock.writes).toHaveLength(0);
  });

  it("a deal needing pre-authorization human review cannot create an order until a human approves", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const p = await makePrincipal();
    const m = await makeMandate(p, { requireHumanAbove: "30" });
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
    await beginNegotiation(prisma, deal.id, "buyer", p.id);
    await lockTerms(prisma, { dealId: deal.id, terms: termsFor(m.id, { price: "45.00" }), actor: "buyer", principalId: p.id });
    expect((await checkPolicy(prisma, { dealId: deal.id, deps })).outcome).toBe("NEEDS_HUMAN");
    expect(await createPayPalOrder(ctx, deal.id)).toMatchObject({ status: "REFUSED", reason: "STATE_NEEDS_HUMAN" });
    expect(mock.writes).toHaveLength(0);
    await resolvePreAuthReview(prisma, { dealId: deal.id, principalId: p.id, principalEmail: p.email, decision: "approve", deps });
    expect(await createPayPalOrder(ctx, deal.id)).toMatchObject({ status: "DONE", state: "AWAITING_BUYER_APPROVAL" });
  });
});

describe("buyer approval is not authorization", () => {
  it("WAITING while PayPal says PAYER_ACTION_REQUIRED; no authorize write is sent", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await policyCheckedDeal();
    await createPayPalOrder(ctx, base.dealId);
    expect(await refreshBuyerApproval(ctx, base.dealId)).toMatchObject({ status: "WAITING", reason: "ORDER_PAYER_ACTION_REQUIRED", state: "AWAITING_BUYER_APPROVAL" });
    expect(mock.writesOf("AUTHORIZE")).toHaveLength(0);
  });

  it("after fresh APPROVED -> authorize -> fresh authorization GET, the deal is AUTHORIZED and awaiting delivery", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx);
    const d = await row(base.dealId);
    expect(d.state).toBe("AWAITING_DELIVERY");
    expect(d.paypalAuthId).toMatch(/^AUTH/);
    expect(d.paypalAuthStatus).toBe("CREATED");
    expect(mock.writesOf("AUTHORIZE")).toHaveLength(1);
    const types = (await prisma.dealEvent.findMany({ where: { dealId: base.dealId } })).map((e) => e.type);
    expect(types).toContain("PAYPAL_READ");
    expect(types).toContain("PAYPAL_WRITE");
  });

  it("an authorization whose amount differs from the locked price is voided, never used", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await policyCheckedDeal();
    await createPayPalOrder(ctx, base.dealId);
    const d = await row(base.dealId);
    // the order passes the order-level binding check at approval time; PayPal then authorizes a DIFFERENT amount (tampered at the moment of the AUTHORIZE write), which only the
    // authorization-level check can catch (defence in depth; the order-level refusal is covered by the next test)
    mock.onWrite = ({ type }) => {
      if (type === "AUTHORIZE") mock.orders.get(d.paypalOrderId!)!.amount = "19.00";
    };
    mock.buyerApprove(d.paypalOrderId!);
    await refreshBuyerApproval(ctx, base.dealId);
    expect((await row(base.dealId)).state).toBe("VOIDED");
    expect(mock.writesOf("VOID")).toHaveLength(1);
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
  });

  it("an order whose amount or deal id no longer matches the locked deal is refused BEFORE authorization: nothing is authorized, nothing is voided", async () => {
    for (const tamper of [(o: { amount: string; referenceId?: string }) => (o.amount = "19.00"), (o: { amount: string; referenceId?: string }) => (o.referenceId = "another-deal")]) {
      const mock = new MockPayPal();
      const ctx = makeCtx(mock);
      const base = await policyCheckedDeal();
      await createPayPalOrder(ctx, base.dealId);
      const d = await row(base.dealId);
      tamper(mock.orders.get(d.paypalOrderId!)!);
      mock.buyerApprove(d.paypalOrderId!);
      expect(await refreshBuyerApproval(ctx, base.dealId)).toMatchObject({ status: "REFUSED" });
      expect((await row(base.dealId)).state).toBe("AWAITING_BUYER_APPROVAL");
      expect(mock.writesOf("AUTHORIZE")).toHaveLength(0);
      expect(mock.writesOf("VOID")).toHaveLength(0);
      expect(mock.writesOf("CAPTURE")).toHaveLength(0);
    }
  });

  it("approval after the deal deadline expires the deal and releases the reservation", async () => {
    const mock = new MockPayPal();
    const base = await policyCheckedDeal();
    await createPayPalOrder(makeCtx(mock), base.dealId);
    const late = makeCtx(mock, { now: () => new Date("2029-06-01T00:00:00Z") });
    expect(await refreshBuyerApproval(late, base.dealId)).toMatchObject({ status: "DONE", state: "EXPIRED" });
    expect((await reservation(base.dealId)).status).toBe("RELEASED");
  });

  it("an unreadable order leaves everything unchanged", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await policyCheckedDeal();
    await createPayPalOrder(ctx, base.dealId);
    mock.injectReadFault("order");
    expect(await refreshBuyerApproval(ctx, base.dealId)).toMatchObject({ status: "WAITING", state: "AWAITING_BUYER_APPROVAL" });
  });
});

describe("settlement outcomes (mock PayPal)", () => {
  it("full capture: CAPTURED only after a fresh GET; reservation converted; ledger intact", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    const res = await settleDeal(ctx, base.dealId);
    expect(res).toMatchObject({ status: "DONE", state: "CAPTURED" });
    const d = await row(base.dealId);
    expect(d.capturedAmount?.toString()).toBe("20");
    expect(d.paypalCaptureId).toMatch(/^CAP/);
    const [cap] = mock.writesOf("CAPTURE");
    expect(cap!.body).toMatchObject({ amount: { currency_code: "USD", value: "20.00" }, final_capture: true });
    expect(mock.reads.some((r) => r.kind === "capture")).toBe(true); // fresh GET of the capture happened
    expect(await reservation(base.dealId)).toMatchObject({ status: "CONVERTED" });
    expect(await prisma.settlement.findUniqueOrThrow({ where: { dealId: base.dealId } })).toMatchObject({ decision: "FULL_CAPTURE", earned: 100 });
    expect(await verifyChain(prisma, base.dealId)).toMatchObject({ ok: true });
  });

  it("required deterministic failure -> VOID; authorization voided and budget released", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, [{ criterionId: "schema", status: "not_met", source: "deterministic" }, ...allMet(["dupes"])]);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "VOIDED" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
    expect([...mock.auths.values()][0]!.status).toBe("VOIDED");
    expect((await reservation(base.dealId)).status).toBe("RELEASED");
  });

  it("injection flag + failed required validator -> VOID because the CONTRACT failed (not because of the flag)", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const flags = [{ code: "INSTR_OVERRIDE", severity: "HIGH", source: "llm" }];
    const base = await verifyingDeal(mock, ctx, [{ criterionId: "schema", status: "not_met", source: "deterministic" }, ...allMet(["dupes"])], {}, flags);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ state: "VOIDED" });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { dealId: base.dealId } })).reasonCodes).toEqual(["REQUIRED_DETERMINISTIC_FAILED:schema"]);
  });

  it("a HIGH LLM flag on an otherwise perfect delivery escalates to a human and sends NOTHING", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL, {}, [{ code: "INSTR_OVERRIDE", severity: "HIGH", source: "llm" }]);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", state: "NEEDS_HUMAN" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
    expect(mock.writesOf("VOID")).toHaveLength(0);
    expect([...mock.auths.values()][0]!.status).toBe("CREATED"); // authorization untouched
  });

  describe("partial capture requires BOTH the signed mandate permission AND Sandbox-verified support", () => {
    const partialResults = [{ criterionId: "schema", status: "met", source: "deterministic" }, { criterionId: "dupes", status: "not_met", source: "deterministic" }];
    it.each([
      ["neither", false, false],
      ["mandate only", true, false],
      ["config only", false, true],
    ])("%s -> NEEDS_HUMAN PARTIAL_SETTLEMENT_NOT_AVAILABLE, no capture", async (_n, allowPartial, verified) => {
      const mock = new MockPayPal();
      const ctx = makeCtx(mock, { partialCaptureVerified: verified });
      const base = await verifyingDeal(mock, ctx, partialResults, { allowPartial });
      expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "PARTIAL_SETTLEMENT_NOT_AVAILABLE" });
      expect(mock.writesOf("CAPTURE")).toHaveLength(0);
      expect(await prisma.settlement.count({ where: { dealId: base.dealId } })).toBe(0);
    });
    it("both gates open -> PARTIALLY_CAPTURED for price*earned/100 (14.00), budget committed = 14.00", async () => {
      const mock = new MockPayPal();
      const ctx = makeCtx(mock, { partialCaptureVerified: true });
      const base = await verifyingDeal(mock, ctx, partialResults, { allowPartial: true });
      expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "PARTIALLY_CAPTURED" });
      expect(mock.writesOf("CAPTURE")[0]!.body).toMatchObject({ amount: { value: "14.00" }, final_capture: true });
      expect((await row(base.dealId)).capturedAmount?.toString()).toBe("14");
      const m = await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } });
      expect((await prisma.$transaction((tx) => committedFor(tx, m.mandateId))).toFixed(2)).toBe("14.00");
    });
  });
});

describe("duplicate settlement is impossible", () => {
  it("5 concurrent settleDeal calls produce exactly one capture write and no crash", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    const out = await Promise.allSettled(Array.from({ length: 5 }, () => settleDeal(ctx, base.dealId)));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect(mock.writesOf("CAPTURE")).toHaveLength(1);
    expect(mock.captures.size).toBe(1);
    const statuses = out.map((o) => (o as PromiseFulfilledResult<{ status: string }>).value.status);
    expect(statuses.filter((s) => s === "DONE")).toHaveLength(1);
    expect(await prisma.settlement.count({ where: { dealId: base.dealId } })).toBe(1);
    expect((await row(base.dealId)).state).toBe("CAPTURED");
  });

  it("replaying settlement after completion is refused and sends nothing", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await settleDeal(ctx, base.dealId);
    const before = mock.writes.length;
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "REFUSED", reason: "STATE_CAPTURED" });
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "X", actor: "t" })).toMatchObject({ status: "REFUSED" });
    expect(mock.writes.length).toBe(before);
  });

  it("the database itself allows only one live CAPTURE/VOID operation per deal (FAILED ones are exempt)", async () => {
    const mock = new MockPayPal();
    const base = await authorizedDeal(mock, makeCtx(mock));
    const mk = (seq: number, type: "CAPTURE" | "VOID", status: "PLANNED" | "FAILED") =>
      prisma.payPalOperation.create({ data: { dealId: base.dealId, type, seq, requestId: `${base.dealId}-${type}-${seq}`, requestBodyHash: "h", status } });
    await mk(1, "CAPTURE", "PLANNED");
    await expect(mk(2, "CAPTURE", "PLANNED")).rejects.toThrow();
    await expect(mk(1, "VOID", "PLANNED")).rejects.toThrow(); // a live VOID alongside a live CAPTURE is also refused
    await prisma.payPalOperation.update({ where: { requestId: `${base.dealId}-CAPTURE-1` }, data: { status: "FAILED" } });
    await expect(mk(2, "CAPTURE", "PLANNED")).resolves.toBeTruthy();
  });
});

describe("timeouts and unknown outcomes: reconcile, never blindly retry", () => {
  it.each(["timeout_after", "http500_after"] as const)("%s: capture applied but unconfirmed -> UNRESOLVED; replay refused; reconcile finds it WITHOUT resending", async (fault) => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", fault);
    const first = await settleDeal(ctx, base.dealId);
    expect(first).toMatchObject({ status: "UNRESOLVED", state: "SETTLING" });
    const [op] = await ops(base.dealId, "CAPTURE");
    expect(op!.status).toBe("UNKNOWN");
    expect((await row(base.dealId)).capturedAmount).toBeNull(); // never claim a capture we have not confirmed

    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "REFUSED" }); // no second attempt
    expect(mock.writesOf("CAPTURE")).toHaveLength(1);

    expect(await reconcileOperation(ctx, op!.id)).toMatchObject({ status: "DONE", state: "CAPTURED" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(1); // reconciled by GET, not by resending
    expect(mock.captures.size).toBe(1);
    expect((await ops(base.dealId, "CAPTURE"))[0]!.status).toBe("CONFIRMED");
  });

  it("timeout_before: reconcile proves nothing was applied, then resends with the SAME request id exactly once", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    expect(mock.captures.size).toBe(0);
    const [op] = await ops(base.dealId, "CAPTURE");
    expect(await reconcileOperation(ctx, op!.id)).toMatchObject({ status: "DONE", state: "CAPTURED" });
    const caps = mock.writesOf("CAPTURE");
    expect(caps).toHaveLength(2);
    expect(caps[1]!.requestId).toBe(caps[0]!.requestId);
    expect(caps[0]!.body).toEqual(caps[1]!.body); // byte-identical payload
    expect(mock.captures.size).toBe(1);
    expect((await ops(base.dealId, "CAPTURE"))[0]).toMatchObject({ attemptCount: 2, status: "CONFIRMED" });
  });

  it("an in-flight SENT operation is left alone until it is stale", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    await prisma.payPalOperation.update({ where: { id: op!.id }, data: { status: "SENT", lastAttemptAt: new Date() } }); // pretend another worker is mid-send
    expect(await reconcileOperation(ctx, op!.id)).toMatchObject({ status: "WAITING", reason: "OPERATION_IN_FLIGHT" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(1);
  });

  it("two reconcilers racing on the same UNKNOWN operation produce exactly ONE resend", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    const out = await Promise.allSettled(Array.from({ length: 4 }, () => reconcileOperation(ctx, op!.id)));
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect(mock.writesOf("CAPTURE")).toHaveLength(2); // the original + exactly one resend
    expect(mock.captures.size).toBe(1);
    expect((await row(base.dealId)).state).toBe("CAPTURED");
  });

  it("a stale SENT operation (crashed worker) is demoted to UNKNOWN atomically and then reconciled", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    await prisma.payPalOperation.update({ where: { id: op!.id }, data: { status: "SENT", responseStatus: null, lastAttemptAt: new Date(Date.now() - 10 * 60_000) } });
    const out = await Promise.allSettled([reconcileOperation(ctx, op!.id), reconcileOperation(ctx, op!.id)]);
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
    expect(mock.writesOf("CAPTURE")).toHaveLength(2);
    expect(mock.captures.size).toBe(1);
    expect((await row(base.dealId)).state).toBe("CAPTURED");
  });

  it("attempts are capped: after 3 sends the deal goes to a human and no further request is made", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    for (let i = 0; i < 3; i++) mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    await reconcileOperation(ctx, op!.id);
    await reconcileOperation(ctx, op!.id);
    expect(await reconcileOperation(ctx, op!.id)).toMatchObject({ status: "NEEDS_HUMAN", state: "NEEDS_HUMAN" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(3);
    expect(new Set(mock.writesOf("CAPTURE").map((w) => w.requestId)).size).toBe(1);
    expect((await ops(base.dealId, "CAPTURE"))[0]!.status).toBe("UNKNOWN"); // still live: blocks any new capture
    expect(mock.captures.size).toBe(0);
  });

  it("an unreadable order during reconcile changes nothing (no blind resend)", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_after");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    mock.injectReadFault("order");
    expect(await reconcileOperation(ctx, op!.id)).toMatchObject({ status: "UNRESOLVED" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(1);
  });

  it("reconcileAll sweeps stuck operations", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_after");
    await settleDeal(ctx, base.dealId);
    await reconcileAll(ctx);
    expect((await row(base.dealId)).state).toBe("CAPTURED");
  });
});

describe("SETTLEMENT_PENDING and declined/rejected captures", () => {
  it("PENDING is not captured: SETTLEMENT_PENDING, budget still reserved, resolved only by a fresh GET", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "pending");
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ state: "SETTLEMENT_PENDING" });
    let d = await row(base.dealId);
    expect(d.capturedAmount).toBeNull();
    expect((await reservation(base.dealId)).status).toBe("ACTIVE");
    expect(await resolveSettlementPending(ctx, base.dealId)).toMatchObject({ state: "SETTLEMENT_PENDING" }); // still pending
    mock.completePending(d.paypalCaptureId ?? [...mock.captures.keys()][0]!, "COMPLETED");
    expect(await resolveSettlementPending(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
    d = await row(base.dealId);
    expect(d.capturedAmount?.toString()).toBe("20");
    expect((await reservation(base.dealId)).status).toBe("CONVERTED");
  });

  it("PENDING that later turns DECLINED -> NEEDS_HUMAN with the operation FAILED", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "pending");
    await settleDeal(ctx, base.dealId);
    mock.completePending([...mock.captures.keys()][0]!, "DECLINED");
    expect(await resolveSettlementPending(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", state: "NEEDS_HUMAN" });
    expect((await ops(base.dealId, "CAPTURE"))[0]!.status).toBe("FAILED");
  });

  it("a POST body claiming COMPLETED is ignored when the fresh GET says DECLINED", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "lie_completed");
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "CAPTURE_DECLINED" });
    const d = await row(base.dealId);
    expect(d.state).toBe("NEEDS_HUMAN");
    expect(d.capturedAmount).toBeNull();
    expect((await reservation(base.dealId)).status).toBe("ACTIVE");
  });

  it("declined capture: human retry plans a NEW operation (seq 2, new request id) for the SAME pre-agreed amount", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "declined");
    await settleDeal(ctx, base.dealId);
    expect((await ops(base.dealId, "CAPTURE"))[0]!.status).toBe("FAILED");
    expect([...mock.auths.values()][0]!.status).toBe("CREATED"); // authorization intact

    await expect(resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "retry", amount: "999.00" } })).rejects.toThrow(); // amounts are not accepted
    expect(await resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "retry" } })).toMatchObject({ status: "DONE", state: "CAPTURED" });
    const caps = await ops(base.dealId, "CAPTURE");
    expect(caps.map((c) => c.seq)).toEqual([1, 2]);
    expect(caps[1]!.requestId).not.toBe(caps[0]!.requestId);
    expect(mock.writesOf("CAPTURE").map((w) => (w.body as { amount: { value: string } }).amount.value)).toEqual(["20.00", "20.00"]);
  });

  it("declined capture: a human can only RETRY the pre-decided settlement; 'reject' (void) is no longer accepted", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "declined");
    await settleDeal(ctx, base.dealId);
    await expect(resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "reject" } })).rejects.toThrow();
    expect((await row(base.dealId)).state).toBe("NEEDS_HUMAN");
    expect(mock.writesOf("VOID")).toHaveLength(0);
    expect([...mock.auths.values()][0]!.status).toBe("CREATED");
  });

  it("PayPal refusing the capture (422) -> NEEDS_HUMAN, operation FAILED, authorization untouched", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "reject422");
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    expect((await ops(base.dealId, "CAPTURE"))[0]).toMatchObject({ status: "FAILED", responseStatus: 422 });
    expect([...mock.auths.values()][0]!.status).toBe("CREATED");
  });

  it("a human cannot retry while a money operation is still live or unresolved", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectWriteFault("CAPTURE", "timeout_before");
    for (let i = 0; i < 2; i++) mock.injectWriteFault("CAPTURE", "timeout_before");
    await settleDeal(ctx, base.dealId);
    const [op] = await ops(base.dealId, "CAPTURE");
    await reconcileOperation(ctx, op!.id);
    await reconcileOperation(ctx, op!.id);
    await reconcileOperation(ctx, op!.id); // -> NEEDS_HUMAN, op still UNKNOWN
    expect(await resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, decision: { kind: "retry" } })).toMatchObject({ status: "REFUSED", reason: "LIVE_OR_UNRESOLVED_MONEY_OPERATION" });
  });
});

describe("strict authorization-state validation before any money moves", () => {
  it("expired authorization -> NEEDS_HUMAN, nothing sent, no settlement row", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.expireAuthorization((await row(base.dealId)).paypalAuthId!);
    const r = await settleDeal(ctx, base.dealId);
    expect(r).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(r.reason).toContain("AUTHORIZATION_NOT_VALID");
    expect(r.reason).toContain("AUTH_EXPIRED_OR_EXPIRING");
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
    expect(await prisma.settlement.count({ where: { dealId: base.dealId } })).toBe(0);
  });

  it("an authorization that is no longer CREATED (voided elsewhere) is never captured", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.voidExternally((await row(base.dealId)).paypalAuthId!);
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
  });

  it("if the authorization cannot be read, the deal stays VERIFYING (WAITING) and can be retried safely", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    mock.injectReadFault("authorization");
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "WAITING", state: "VERIFYING" });
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "DONE", state: "CAPTURED" });
  });

  it("terms edited after verification -> NEEDS_HUMAN TERMS_DRIFT, nothing sent", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    const d = await row(base.dealId);
    await prisma.deal.update({ where: { id: base.dealId }, data: { termsJson: { ...(d.termsJson as object), price: "200.00" } } });
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN", reason: "TERMS_DRIFT" });
    expect(mock.writes.filter((w) => w.type === "CAPTURE")).toHaveLength(0);
  });

  it("a capture whose authorization shrinks below the price is blocked at preflight", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    [...mock.auths.values()][0]!.amount = "10.00";
    expect(await settleDeal(ctx, base.dealId)).toMatchObject({ status: "NEEDS_HUMAN" });
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
  });
});

describe("post-authorization human review", () => {
  const criteria = [det("schema", 50, true), llm("quality", 50, true)];
  const results = [
    { criterionId: "schema", status: "met", source: "deterministic" },
    { criterionId: "quality", status: "unverifiable", source: "verifier" },
  ];
  async function needsHuman() {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, results, { criteria });
    const r = await settleDeal(ctx, base.dealId);
    expect(r).toMatchObject({ status: "NEEDS_HUMAN", state: "NEEDS_HUMAN" });
    return { mock, ctx, base };
  }
  const review = (ctx: ReturnType<typeof makeCtx>, b: { dealId: string; p: { id: string; email: string } }, decision: unknown) =>
    resolvePostAuthReview(ctx, { dealId: b.dealId, principalId: b.p.id, principalEmail: b.p.email, decision });

  it("unverifiable criterion pauses at NEEDS_HUMAN with its origin and sends nothing", async () => {
    const { mock, base } = await needsHuman();
    const d = await row(base.dealId);
    expect(d.needsHumanFrom).toBe("VERIFYING");
    expect(d.needsHumanReason).toContain("UNVERIFIABLE:quality");
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
  });

  it("approve with a verdict on the unverifiable criterion -> amount still computed from weights (full 20.00)", async () => {
    const { mock, ctx, base } = await needsHuman();
    const r = await review(ctx, base, { kind: "approve", verdicts: [{ criterionId: "quality", status: "met" }] });
    expect(r).toMatchObject({ status: "DONE", state: "CAPTURED" });
    expect(mock.writesOf("CAPTURE")[0]!.body).toMatchObject({ amount: { value: "20.00" } });
    const ev = await prisma.dealEvent.findFirstOrThrow({ where: { dealId: base.dealId, type: "HUMAN_REVIEW_DECISION" } });
    expect(JSON.stringify(ev.payload)).not.toMatch(/amount/i); // a human decision carries no money
    expect(ev.actor).toBe(`human:${base.p.email}`);
  });

  it("a human cannot supply an amount, cannot overturn a deterministic result, and other principals cannot act", async () => {
    const { mock, ctx, base } = await needsHuman();
    await expect(review(ctx, base, { kind: "approve", amount: "20.00" })).rejects.toThrow();
    await expect(review(ctx, base, { kind: "approve", verdicts: [{ criterionId: "quality", status: "met" }], captureAmount: "5" })).rejects.toThrow();
    expect(await review(ctx, base, { kind: "approve", verdicts: [{ criterionId: "schema", status: "not_met" }] })).toMatchObject({ status: "REFUSED" });
    const intruder = await makePrincipal();
    await expect(resolvePostAuthReview(ctx, { dealId: base.dealId, principalId: intruder.id, principalEmail: intruder.email, decision: { kind: "retry" } })).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.writes.filter((w) => w.type === "CAPTURE" || w.type === "VOID")).toHaveLength(0);
    expect((await row(base.dealId)).state).toBe("NEEDS_HUMAN");
  });

  it("a human verdict of not_met on a REQUIRED criterion the machines could not resolve -> the ENGINE computes VOID", async () => {
    const { mock, ctx, base } = await needsHuman();
    expect(await review(ctx, base, { kind: "approve", verdicts: [{ criterionId: "quality", status: "not_met" }] })).toMatchObject({ status: "DONE", state: "VOIDED" });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { dealId: base.dealId } })).reasonCodes).toEqual(["REQUIRED_CRITERION_FAILED_BY_HUMAN_VERDICT:quality"]);
    expect(mock.writesOf("CAPTURE")).toHaveLength(0);
  });

  it("'reject' no longer exists as a review decision (no unrestricted rejection)", async () => {
    const { mock, ctx, base } = await needsHuman();
    await expect(review(ctx, base, { kind: "reject" })).rejects.toThrow();
    expect((await row(base.dealId)).state).toBe("NEEDS_HUMAN");
    expect(mock.writes.filter((w) => w.type === "VOID" || w.type === "CAPTURE")).toHaveLength(0);
  });

  it("'retry' has nothing to retry before a settlement exists; reviewing a non-review deal is refused", async () => {
    const { ctx, base } = await needsHuman();
    expect(await review(ctx, base, { kind: "retry" })).toMatchObject({ status: "REFUSED", reason: "NOTHING_TO_RETRY" });
    const mock2 = new MockPayPal();
    const ctx2 = makeCtx(mock2);
    const done = await verifyingDeal(mock2, ctx2, ALL);
    await settleDeal(ctx2, done.dealId);
    await expect(review(ctx2, done, { kind: "retry" })).rejects.toBeInstanceOf(StaleStateError);
  });
});

describe("pre-delivery cancellation and void confirmation", () => {
  it("cancel voids the authorization once; a second cancel is refused", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx);
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "PRINCIPAL_CANCELLED", actor: "human:x" })).toMatchObject({ status: "DONE", state: "VOIDED" });
    expect(await cancelAuthorization(ctx, { dealId: base.dealId, reason: "AGAIN", actor: "human:x" })).toMatchObject({ status: "REFUSED" });
    expect(mock.writesOf("VOID")).toHaveLength(1);
    expect((await reservation(base.dealId)).status).toBe("RELEASED");
  });

  it("a void that PayPal accepts but the fresh GET does not show is never reported as voided", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await authorizedDeal(mock, ctx);
    mock.injectWriteFault("VOID", "void_noop");
    const r = await cancelAuthorization(ctx, { dealId: base.dealId, reason: "X", actor: "human:x" });
    expect(r).toMatchObject({ status: "UNRESOLVED", state: "AWAITING_DELIVERY" });
    expect((await ops(base.dealId, "VOID"))[0]!.status).toBe("UNKNOWN");
    expect((await reservation(base.dealId)).status).toBe("ACTIVE");
  });

  it("void timeout: reconcile sees VOIDED and does not resend; if still CREATED it resends the SAME request id", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const a = await authorizedDeal(mock, ctx);
    mock.injectWriteFault("VOID", "timeout_after");
    await cancelAuthorization(ctx, { dealId: a.dealId, reason: "X", actor: "human:x" });
    const [opA] = await ops(a.dealId, "VOID");
    expect(await reconcileOperation(ctx, opA!.id)).toMatchObject({ state: "VOIDED" });
    expect(mock.writesOf("VOID")).toHaveLength(1);

    const b = await authorizedDeal(mock, ctx);
    mock.injectWriteFault("VOID", "timeout_before");
    await cancelAuthorization(ctx, { dealId: b.dealId, reason: "X", actor: "human:x" });
    const [opB] = await ops(b.dealId, "VOID");
    expect(await reconcileOperation(ctx, opB!.id)).toMatchObject({ state: "VOIDED" });
    const voidsB = mock.writes.filter((w) => w.type === "VOID" && w.requestId === opB!.requestId);
    expect(voidsB).toHaveLength(2);
  });
});

describe("audit trail", () => {
  it("every PayPal write and fresh read is in the hash chain, with no credentials", async () => {
    const mock = new MockPayPal();
    const ctx = makeCtx(mock);
    const base = await verifyingDeal(mock, ctx, ALL);
    await settleDeal(ctx, base.dealId);
    const events = await prisma.dealEvent.findMany({ where: { dealId: base.dealId }, orderBy: { seq: "asc" } });
    const types = events.map((e) => e.type);
    for (const t of ["DEAL_CREATED", "PAYPAL_OPERATION_PLANNED", "PAYPAL_WRITE", "PAYPAL_READ", "STATE_TRANSITION"]) expect(types).toContain(t);
    expect(events.filter((e) => e.type === "PAYPAL_WRITE").length).toBe(mock.writes.length);
    expect(JSON.stringify(events)).not.toMatch(/access_token|client_secret|Bearer/i);
    expect(await verifyChain(prisma, base.dealId)).toMatchObject({ ok: true });
  });
});
