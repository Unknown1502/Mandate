/**
 * SETTLEMENT ENGINE: the only module permitted to cause PayPal write operations (AGENTS.md invariant 2).
 *
 * Financial operation lifecycle (PayPalOperation.status):
 *   PLANNED --claim(CAS, attempt++)--> SENT --gateway.write-->
 *       ok        : status stays SENT until a FRESH GET confirms the outcome, then CONFIRMED (or FAILED if the resource
 *                   shows the money did not move, e.g. capture DECLINED)
 *       rejected  : FAILED   (PayPal definitively refused; nothing happened; a human may plan seq+1)
 *       unknown   : UNKNOWN  (timeout / 5xx / 429 / unparseable) -> reconcile: GET the resource first; resend ONLY with
 *                   the SAME PayPal-Request-Id and only if the resource proves the write did not apply.
 * The row is committed BEFORE the network call. A partial unique index allows one live CAPTURE/VOID per deal.
 */
import { Prisma, type PayPalOperation, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { convertReservation, releaseReservation } from "../domain/budget";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { StaleStateError, transitionDeal, type PolicyDeps } from "../domain/deals";
import { appendEvent } from "../domain/ledger";
import { NotFoundError, openMandateRow } from "../domain/mandates";
import { authorizeLoadedDeal, type AuthorizationReason } from "../domain/authorization";
import { D, fmt, parseMoney, type Money } from "../domain/money";
import { decideSettlement, verificationSchema, type CriterionResult } from "../domain/settlement";
import type { DealState } from "../domain/statemachine";
import { readLockedTerms, readLockedTermsOrThrow, termsMatchLockAny } from "../domain/terms-v2";
import { captureBody, createOrderBody } from "../paypal/payloads";
import type { PayPalGateway } from "../paypal/gateway";
import { authorizationSchema, captureSchema, orderSchema, type Authorization, type Order } from "../paypal/schemas";
import { AUTH_STATUS, CAPTURE_STATUS, ORDER_STATUS } from "../paypal/statuses";

const SYS = "settlement-engine";

/** authorization failures that mean "the locked terms are no longer what was approved": the deal is blocked and its reservation released (as before P3) */
const TERMS_FAILURES = new Set<AuthorizationReason>(["TERMS_NOT_LOCKED", "TERMS_INVALID", "TERMS_VERSION_UNSUPPORTED", "TERMS_DRIFT"]);

export interface EngineConfig {
  appUrl: string;
  /** Flip to true ONLY after partial capture is demonstrated in Sandbox (Gate 9). Default false. */
  partialCaptureVerified: boolean;
  maxOperationAttempts: number;
  staleSentMs: number;
  authExpiryMarginMs: number;
  /** After a verification passes, capture is held this long so the principal can CHALLENGE it. 0 disables the hold. */
  challengeWindowMs: number;
  /** A challenge unresolved after this long moves to NEEDS_HUMAN (never to capture/void). */
  reviewTimeoutMs: number;
}
export const defaultEngineConfig = (appUrl: string): EngineConfig => ({
  appUrl,
  partialCaptureVerified: false,
  maxOperationAttempts: 3,
  staleSentMs: 60_000,
  authExpiryMarginMs: 5 * 60_000,
  challengeWindowMs: 15 * 60_000,
  reviewTimeoutMs: 72 * 60 * 60_000,
});

export interface EngineContext {
  db: PrismaClient;
  gateway: PayPalGateway;
  deps: PolicyDeps;
  config: EngineConfig;
  now: () => Date;
}

export type EngineStatus = "DONE" | "WAITING" | "REFUSED" | "UNRESOLVED" | "NEEDS_HUMAN";
export interface EngineResult {
  status: EngineStatus;
  reason?: string;
  state: DealState;
}

async function result(ctx: EngineContext, dealId: string, status: EngineStatus, reason?: string): Promise<EngineResult> {
  const d = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId }, select: { state: true } });
  return { status, reason, state: d.state as DealState };
}

const ledger = (ctx: EngineContext, dealId: string, type: string, payload: Record<string, unknown>, actor: string = SYS) =>
  ctx.db.$transaction((tx) => appendEvent(tx, dealId, type, actor, payload));

// ---------------------------------------------------------------------------------------------------------------------
// Strict authorization validation (pure)
// ---------------------------------------------------------------------------------------------------------------------
export type AuthValidation = { ok: true; amount: Money } | { ok: false; reason: string };

export function validateAuthorization(
  auth: Authorization,
  expected: { authId: string | null; fallbackExpiry?: Date | null },
  now: Date,
  marginMs: number,
): AuthValidation {
  if (!expected.authId || auth.id !== expected.authId) return { ok: false, reason: "AUTH_ID_MISMATCH" };
  if (auth.status !== AUTH_STATUS.CREATED) return { ok: false, reason: `AUTH_STATUS_${auth.status}` };
  if (!auth.amount || auth.amount.currency_code !== "USD") return { ok: false, reason: "AUTH_CURRENCY_NOT_USD" };
  let amount: Money;
  try {
    amount = parseMoney(auth.amount.value);
  } catch {
    return { ok: false, reason: "AUTH_AMOUNT_INVALID" };
  }
  const exp = auth.expiration_time ? new Date(auth.expiration_time) : (expected.fallbackExpiry ?? null);
  if (!exp || Number.isNaN(exp.getTime())) return { ok: false, reason: "AUTH_EXPIRY_UNKNOWN" };
  if (exp.getTime() <= now.getTime() + marginMs) return { ok: false, reason: "AUTH_EXPIRED_OR_EXPIRING" };
  return { ok: true, amount };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fresh reads (every one is ledgered)
// ---------------------------------------------------------------------------------------------------------------------
type Read<T> = { ok: true; data: T } | { ok: false; reason: string };

async function readResource<T extends { status: string }>(
  ctx: EngineContext,
  dealId: string,
  kind: "order" | "authorization" | "capture",
  id: string,
  schema: z.ZodType<T>,
): Promise<Read<T>> {
  const r = await (kind === "order" ? ctx.gateway.getOrder(id) : kind === "authorization" ? ctx.gateway.getAuthorization(id) : ctx.gateway.getCapture(id));
  if (r.kind !== "ok") {
    await ledger(ctx, dealId, "PAYPAL_READ_FAILED", { kind, id, outcome: r.kind, code: "code" in r ? r.code : undefined });
    return { ok: false, reason: `READ_${r.kind.toUpperCase()}` };
  }
  const parsed = schema.safeParse(r.body);
  if (!parsed.success) {
    await ledger(ctx, dealId, "PAYPAL_READ_FAILED", { kind, id, outcome: "unparseable" });
    return { ok: false, reason: "READ_UNPARSEABLE" };
  }
  await ledger(ctx, dealId, "PAYPAL_READ", { kind, id, httpStatus: r.status, debugId: r.debugId ?? null, resourceStatus: parsed.data.status });
  return { ok: true, data: parsed.data };
}
const readOrder = (c: EngineContext, d: string, id: string) => readResource(c, d, "order", id, orderSchema);
const readAuth = (c: EngineContext, d: string, id: string) => readResource(c, d, "authorization", id, authorizationSchema);
const readCapture = (c: EngineContext, d: string, id: string) => readResource(c, d, "capture", id, captureSchema);

// ---------------------------------------------------------------------------------------------------------------------
// Operation persistence and sending
// ---------------------------------------------------------------------------------------------------------------------
type Tx = Prisma.TransactionClient;
type OpType = PayPalOperation["type"];

/** Insert a PLANNED operation with a deterministic request id. Runs inside the caller's transaction. */
async function planOp(tx: Tx, dealId: string, type: OpType, path: string, build: (seq: number) => unknown): Promise<PayPalOperation> {
  const last = await tx.payPalOperation.findFirst({ where: { dealId, type }, orderBy: { seq: "desc" } });
  const seq = (last?.seq ?? 0) + 1;
  const body = build(seq);
  return tx.payPalOperation.create({
    data: {
      dealId,
      type,
      seq,
      requestId: `${dealId}-${type}-${seq}`,
      path,
      requestBody: body === undefined ? Prisma.DbNull : (body as Prisma.InputJsonValue),
      requestBodyHash: sha256Hex(canonicalJson(body ?? null)),
      status: "PLANNED",
    },
  });
}

/** Compare-and-set into SENT (attempt++). Returns null if another worker owns it or attempts are exhausted. */
async function claim(ctx: EngineContext, opId: string, from: PayPalOperation["status"][]): Promise<PayPalOperation | null> {
  const r = await ctx.db.payPalOperation.updateMany({
    where: { id: opId, status: { in: from }, attemptCount: { lt: ctx.config.maxOperationAttempts } },
    data: { status: "SENT", attemptCount: { increment: 1 }, lastAttemptAt: ctx.now() },
  });
  return r.count === 1 ? ctx.db.payPalOperation.findUniqueOrThrow({ where: { id: opId } }) : null;
}

type SendOutcome =
  | { kind: "not_claimed" }
  | { kind: "ok"; op: PayPalOperation }
  | { kind: "rejected"; op: PayPalOperation; code: string }
  | { kind: "unknown"; op: PayPalOperation; code: string };

async function sendOp(ctx: EngineContext, opId: string, from: PayPalOperation["status"][]): Promise<SendOutcome> {
  const op = await claim(ctx, opId, from); // committed as SENT BEFORE the network call
  if (!op) return { kind: "not_claimed" };
  const res = await ctx.gateway.write(op.type, { requestId: op.requestId, path: op.path, body: op.requestBody ?? undefined });
  await ledger(ctx, op.dealId, "PAYPAL_WRITE", {
    type: op.type,
    seq: op.seq,
    attempt: op.attemptCount,
    requestId: op.requestId,
    outcome: res.kind,
    httpStatus: "status" in res ? (res.status ?? null) : null,
    debugId: "debugId" in res ? (res.debugId ?? null) : null,
  });
  if (res.kind === "ok") {
    const rid = (res.body as { id?: unknown } | null)?.id;
    const updated = await ctx.db.payPalOperation.update({
      where: { id: op.id },
      data: { responseStatus: res.status, debugId: res.debugId ?? null, paypalResourceId: typeof rid === "string" ? rid : null },
    });
    return { kind: "ok", op: updated };
  }
  if (res.kind === "rejected") {
    const updated = await ctx.db.payPalOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", responseStatus: res.status, debugId: res.debugId ?? null, lastError: res.code },
    });
    return { kind: "rejected", op: updated, code: res.code };
  }
  const updated = await ctx.db.payPalOperation.update({
    where: { id: op.id },
    data: { status: "UNKNOWN", lastError: res.code, responseStatus: res.status ?? null, debugId: res.debugId ?? null },
  });
  return { kind: "unknown", op: updated, code: res.code };
}

// ---------------------------------------------------------------------------------------------------------------------
// Operation routing
// ---------------------------------------------------------------------------------------------------------------------
async function driveOp(ctx: EngineContext, opId: string, from: PayPalOperation["status"][]): Promise<EngineResult> {
  const pre = await ctx.db.payPalOperation.findUniqueOrThrow({ where: { id: opId } });
  if ((pre.type === "CAPTURE" || pre.type === "VOID") && pre.attemptCount === 0) {
    const guard = await preflightMoneyOp(ctx, pre);
    if (guard) return guard;
  }
  const out = await sendOp(ctx, opId, from);
  if (out.kind === "not_claimed") return result(ctx, pre.dealId, "UNRESOLVED", "OPERATION_NOT_CLAIMABLE");
  const dealId = out.op.dealId;
  if (out.kind === "unknown") return result(ctx, dealId, "UNRESOLVED", `PAYPAL_OUTCOME_UNKNOWN:${out.code}`);
  if (out.kind === "rejected") return onRejected(ctx, out.op, out.code);
  return finalizeOp(ctx, out.op.id);
}

async function onRejected(ctx: EngineContext, op: PayPalOperation, code: string): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: op.dealId } });
  if (op.type === "CAPTURE" || op.type === "VOID") {
    if (deal.state === "SETTLING" || deal.state === "SETTLEMENT_PENDING") {
      await ctx.db.$transaction((tx) => transitionDeal(tx, op.dealId, "NEEDS_HUMAN", SYS, { reason: `PAYPAL_REJECTED:${code}`, op: op.type }));
      return result(ctx, op.dealId, "NEEDS_HUMAN", `PAYPAL_REJECTED:${code}`);
    }
    return result(ctx, op.dealId, "REFUSED", `PAYPAL_REJECTED:${code}`);
  }
  return result(ctx, op.dealId, "REFUSED", `PAYPAL_REJECTED:${code}`);
}

async function finalizeOp(ctx: EngineContext, opId: string): Promise<EngineResult> {
  const op = await ctx.db.payPalOperation.findUniqueOrThrow({ where: { id: opId } });
  try {
    return await finalizeByType(ctx, op);
  } catch (e) {
    // Two finalizers raced; the compare-and-set on deal state protected the outcome and the loser yields.
    if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, op.dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
    throw e;
  }
}

async function finalizeByType(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult> {
  switch (op.type) {
    case "CREATE_ORDER":
      return finalizeCreateOrder(ctx, op);
    case "AUTHORIZE":
      return finalizeAuthorize(ctx, op);
    case "CAPTURE":
      return finalizeCapture(ctx, op);
    case "VOID":
      return finalizeVoid(ctx, op);
    default:
      return result(ctx, op.dealId, "REFUSED", `UNSUPPORTED_OPERATION_${op.type}`);
  }
}

async function authorizeDealForCapture(ctx: EngineContext, dealId: string): Promise<string | null> {
  const d = await ctx.db.deal.findUnique({ where: { id: dealId }, include: { mandate: true, reservations: true, attestation: true } });
  if (!d) return "DEAL_NOT_FOUND";
  const a = authorizeLoadedDeal(d, { ...ctx.deps, now: ctx.now() }, { requireActiveReservation: true });
  return a.ok ? null : a.detail ? a.reason + ":" + a.detail : a.reason;
}

/** Fresh authorization check before a first money write. Returns a result if the write must NOT be sent. */
async function preflightMoneyOp(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult | null> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: op.dealId } });
  const fail = async (reason: string) => {
    await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { status: "FAILED", lastError: `PREFLIGHT:${reason}` } });
    if (deal.state === "SETTLING") {
      await ctx.db.$transaction((tx) => transitionDeal(tx, op.dealId, "NEEDS_HUMAN", SYS, { reason: `PREFLIGHT:${reason}` }));
      return result(ctx, op.dealId, "NEEDS_HUMAN", `PREFLIGHT:${reason}`);
    }
    return result(ctx, op.dealId, "REFUSED", `PREFLIGHT:${reason}`);
  };
  if (!deal.paypalAuthId) return fail("NO_AUTHORIZATION");
  // P5: the money-moving direction re-derives the WHOLE authorization immediately before the first send (a plan made earlier, or by a crashed worker, is not trusted).
  // VOID is the safe direction and is never blocked by it.
  if (op.type === "CAPTURE") {
    const full = await authorizeDealForCapture(ctx, op.dealId);
    if (full) return fail("AUTHORIZATION:" + full);
  }
  const a = await readAuth(ctx, op.dealId, deal.paypalAuthId);
  if (!a.ok) return result(ctx, op.dealId, "UNRESOLVED", a.reason); // nothing sent; op stays PLANNED
  if (op.type === "VOID" && a.data.status === AUTH_STATUS.VOIDED) {
    // Already voided on PayPal: nothing to send. Confirm via the normal finalizer.
    await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { status: "SENT", attemptCount: 1, lastAttemptAt: ctx.now() } });
    return finalizeVoid(ctx, await ctx.db.payPalOperation.findUniqueOrThrow({ where: { id: op.id } }));
  }
  const v = validateAuthorization(a.data, { authId: deal.paypalAuthId, fallbackExpiry: deal.authExpiresAt }, ctx.now(), ctx.config.authExpiryMarginMs);
  if (!v.ok) return fail(v.reason);
  if (op.type === "CAPTURE") {
    const amt = (op.requestBody as { amount?: { value?: string } } | null)?.amount?.value;
    if (!amt || parseMoney(amt).gt(v.amount) || (deal.price && parseMoney(amt).gt(new D(deal.price.toString())))) return fail("CAPTURE_EXCEEDS_AUTHORIZATION_OR_PRICE");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Create order
// ---------------------------------------------------------------------------------------------------------------------
export async function createPayPalOrder(ctx: EngineContext, dealId: string): Promise<EngineResult> {
  const planned = await ctx.db
    .$transaction(async (tx) => {
      const deal = await tx.deal.findUniqueOrThrow({ where: { id: dealId }, include: { reservations: true, mandate: true, attestation: true } });
      const preAuthHumanOk =
        deal.state === "NEEDS_HUMAN" &&
        deal.needsHumanFrom === "POLICY_CHECKED" &&
        (await tx.dealEvent.findMany({ where: { dealId, type: "HUMAN_REVIEW_DECISION" } })).some((e) => {
          const p = e.payload as { phase?: string; decision?: string };
          return p.phase === "PRE_AUTH" && p.decision === "approve";
        });
      if (deal.state !== "POLICY_CHECKED" && !preAuthHumanOk) return { kind: "refuse", reason: `STATE_${deal.state}` } as const;
      if (!deal.reservations.some((r) => r.status === "ACTIVE")) return { kind: "refuse", reason: "NO_ACTIVE_BUDGET_RESERVATION" } as const;
      // P3/P5: the full authorization is re-derived from the stored records (mandate seal, identity, expiry, terms hash, counterparty, language policy, V2 attestation)
      const auth = authorizeLoadedDeal(deal, { ...ctx.deps, now: ctx.now() }, { checkExpiry: true });
      if (!auth.ok && !TERMS_FAILURES.has(auth.reason)) return { kind: "refuse", reason: auth.reason } as const; // nothing is changed; a human can look
      if (!auth.ok || !deal.price) {
        await transitionDeal(tx, dealId, "BLOCKED", SYS, { reason: "TERMS_DRIFT_BEFORE_ORDER" });
        await releaseReservation(tx, dealId);
        return { kind: "refuse", reason: "TERMS_DRIFT" } as const;
      }
      const existing = await tx.payPalOperation.findFirst({ where: { dealId, type: "CREATE_ORDER" }, orderBy: { seq: "desc" } });
      if (existing && existing.status !== "FAILED") return { kind: "resume", id: existing.id } as const;
      const op = await planOp(tx, dealId, "CREATE_ORDER", "/v2/checkout/orders", () =>
        createOrderBody({
          referenceId: dealId,
          description: `Mandate deal ${dealId} terms:${deal.termsHash!.slice(0, 12)}`,
          amount: deal.price!.toString(),
          returnUrl: `${ctx.config.appUrl}/paypal/return`,
          cancelUrl: `${ctx.config.appUrl}/paypal/cancel`,
        }),
      );
      await appendEvent(tx, dealId, "PAYPAL_OPERATION_PLANNED", SYS, { type: "CREATE_ORDER", requestId: op.requestId, bodyHash: op.requestBodyHash });
      return { kind: "op", id: op.id } as const;
    });
  if (planned.kind === "refuse") return result(ctx, dealId, "REFUSED", planned.reason);
  if (planned.kind === "resume") return reconcileOperation(ctx, planned.id);
  return driveOp(ctx, planned.id, ["PLANNED"]);
}

/**
 * The PayPal order we hold must be THIS deal's order for THIS deal's locked price: the order must carry the deal id (reference and custom id, both set by createOrderBody) and
 * an amount equal to the locked price in USD. Anything else (a swapped id, a tampered amount, an order from another deal) is refused before any further money step. Fail closed:
 * a missing field is a mismatch. Pure.
 */
export function orderBindingIssue(order: Order, deal: { id: string; price: { toString(): string } | null }): string | null {
  const pu = order.purchase_units?.[0];
  if (!pu) return "ORDER_HAS_NO_PURCHASE_UNIT";
  if (pu.reference_id !== deal.id || pu.custom_id !== deal.id) return "ORDER_NOT_BOUND_TO_DEAL";
  if (!pu.amount || pu.amount.currency_code !== "USD" || deal.price === null) return "ORDER_AMOUNT_MISSING";
  try {
    if (!parseMoney(pu.amount.value).eq(new D(deal.price.toString()))) return "ORDER_AMOUNT_MISMATCH";
  } catch {
    return "ORDER_AMOUNT_MISMATCH";
  }
  return null;
}

async function finalizeCreateOrder(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: op.dealId } });
  if (deal.paypalOrderId && deal.state === "AWAITING_BUYER_APPROVAL") return result(ctx, op.dealId, "DONE");
  if (!op.paypalResourceId) return result(ctx, op.dealId, "UNRESOLVED", "CREATE_ORDER_NO_ID");
  const o = await readOrder(ctx, op.dealId, op.paypalResourceId);
  if (!o.ok) return result(ctx, op.dealId, "UNRESOLVED", o.reason);
  const bindingNew = orderBindingIssue(o.data, deal);
  if (bindingNew) {
    await ledger(ctx, op.dealId, "ORDER_BINDING_MISMATCH", { stage: "create", reason: bindingNew });
    return result(ctx, op.dealId, "REFUSED", bindingNew);
  }
  if (o.data.status !== ORDER_STATUS.PAYER_ACTION_REQUIRED && o.data.status !== ORDER_STATUS.CREATED) {
    return result(ctx, op.dealId, "REFUSED", `UNEXPECTED_ORDER_STATUS_${o.data.status}`);
  }
  const link = o.data.links?.find((l) => l.rel === "payer-action") ?? o.data.links?.find((l) => l.rel === "approve");
  if (!link) return result(ctx, op.dealId, "REFUSED", "NO_BUYER_APPROVAL_LINK");
  await ctx.db.$transaction(async (tx) => {
    await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: o.data.status } });
    await transitionDeal(tx, op.dealId, "ORDER_CREATED", SYS, { orderId: op.paypalResourceId, orderStatus: o.data.status }, { paypalOrderId: op.paypalResourceId, approvalUrl: link.href });
    await transitionDeal(tx, op.dealId, "AWAITING_BUYER_APPROVAL", SYS, { approvalLinkRel: link.rel });
  });
  return result(ctx, op.dealId, "DONE");
}

// ---------------------------------------------------------------------------------------------------------------------
// Buyer approval -> authorization. Buyer approval is NOT authorization: only a fresh GET showing a usable authorization is.
// ---------------------------------------------------------------------------------------------------------------------
export async function refreshBuyerApproval(ctx: EngineContext, dealId: string): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });
  if (deal.state !== "AWAITING_BUYER_APPROVAL" || !deal.paypalOrderId) return result(ctx, dealId, "REFUSED", `STATE_${deal.state}`);
  if (deal.deadline && deal.deadline <= ctx.now()) {
    await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "EXPIRED", SYS, { reason: "BUYER_APPROVAL_AFTER_DEADLINE" }));
    await ctx.db.$transaction((tx) => releaseReservation(tx, dealId));
    return result(ctx, dealId, "DONE", "EXPIRED");
  }
  const o = await readOrder(ctx, dealId, deal.paypalOrderId);
  if (!o.ok) return result(ctx, dealId, "WAITING", o.reason);
  if (o.data.status !== ORDER_STATUS.APPROVED) return result(ctx, dealId, "WAITING", `ORDER_${o.data.status}`);
  // browser approval proves nothing by itself: the provider's own record must still be this deal's order for the locked price before we authorize
  const binding = orderBindingIssue(o.data, deal);
  if (binding) {
    await ledger(ctx, dealId, "ORDER_BINDING_MISMATCH", { stage: "approval", reason: binding });
    return result(ctx, dealId, "REFUSED", binding);
  }

  const existing = await ctx.db.payPalOperation.findFirst({ where: { dealId, type: "AUTHORIZE" }, orderBy: { seq: "desc" } });
  if (existing && existing.status !== "FAILED") return reconcileOperation(ctx, existing.id);
  const op = await ctx.db.$transaction((tx) => planOp(tx, dealId, "AUTHORIZE", `/v2/checkout/orders/${deal.paypalOrderId}/authorize`, () => undefined));
  return driveOp(ctx, op.id, ["PLANNED"]);
}

async function finalizeAuthorize(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: op.dealId } });
  if (deal.paypalAuthId && deal.state !== "AWAITING_BUYER_APPROVAL") return result(ctx, op.dealId, "DONE");
  const o = await readOrder(ctx, op.dealId, deal.paypalOrderId!);
  if (!o.ok) return result(ctx, op.dealId, "UNRESOLVED", o.reason);
  const authz = o.data.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authz) return result(ctx, op.dealId, "UNRESOLVED", "ORDER_HAS_NO_AUTHORIZATION_YET");
  const a = await readAuth(ctx, op.dealId, authz.id);
  if (!a.ok) return result(ctx, op.dealId, "UNRESOLVED", a.reason);

  if (a.data.status !== AUTH_STATUS.CREATED) {
    await ctx.db.$transaction(async (tx) => {
      await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: a.data.status } });
      await transitionDeal(tx, op.dealId, "EXPIRED", SYS, { reason: `AUTHORIZATION_STATUS_${a.data.status}`, authId: authz.id });
      await releaseReservation(tx, op.dealId);
    });
    return result(ctx, op.dealId, "DONE", `AUTHORIZATION_STATUS_${a.data.status}`);
  }
  const v = validateAuthorization(a.data, { authId: authz.id }, ctx.now(), ctx.config.authExpiryMarginMs);
  const priceOk = v.ok && deal.price !== null && v.amount.eq(new D(deal.price.toString()));
  await ctx.db.$transaction(async (tx) => {
    await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: a.data.status } });
    await transitionDeal(
      tx,
      op.dealId,
      "AUTHORIZED",
      SYS,
      { authId: authz.id, authStatus: a.data.status },
      { paypalAuthId: authz.id, paypalAuthStatus: a.data.status, authorizedAt: ctx.now(), authExpiresAt: a.data.expiration_time ? new Date(a.data.expiration_time) : null },
    );
    if (priceOk) await transitionDeal(tx, op.dealId, "AWAITING_DELIVERY", SYS);
    else await appendEvent(tx, op.dealId, "AUTHORIZATION_VALIDATION_FAILED", SYS, { reason: v.ok ? "AMOUNT_NOT_EQUAL_PRICE" : v.reason });
  });
  if (!priceOk) return cancelAuthorization(ctx, { dealId: op.dealId, reason: "AUTHORIZATION_VALIDATION_FAILED", actor: SYS });
  return result(ctx, op.dealId, "DONE");
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification input (Gate 4 will produce it) and settlement
// ---------------------------------------------------------------------------------------------------------------------
export async function recordVerification(ctx: EngineContext, dealId: string, input: unknown): Promise<EngineResult> {
  const ver = verificationSchema.parse(input);
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });
  if (!deal.termsJson) return result(ctx, dealId, "REFUSED", "NO_TERMS");
  const locked = readLockedTerms(deal.termsJson);
  if (!locked.ok) return result(ctx, dealId, "REFUSED", locked.code);
  const ids = new Set(locked.terms.criteria.map((c) => c.id));
  if (ver.results.some((r) => !ids.has(r.criterionId))) return result(ctx, dealId, "REFUSED", "RESULT_FOR_UNKNOWN_CRITERION");
  try {
    await ctx.db.$transaction(async (tx) => {
      await transitionDeal(tx, dealId, "VERIFYING", SYS, { results: ver.results.map((r) => ({ id: r.criterionId, status: r.status, source: r.source })), flags: ver.flags }, { verificationJson: ver as unknown as Prisma.InputJsonValue, challengeWindowEndsAt: new Date(ctx.now().getTime() + ctx.config.challengeWindowMs) });
    });
  } catch (e) {
    if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, dealId, "REFUSED", "STATE_NOT_DELIVERED");
    throw e;
  }
  return result(ctx, dealId, "DONE");
}


/** Decide from locked terms + recorded verification (+ human verdicts) and, if money-moving, commit it atomically. */
export async function settleDeal(ctx: EngineContext, dealId: string, actor = SYS): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUnique({ where: { id: dealId }, include: { mandate: true, settlement: true, reservations: true, attestation: true } });
  if (!deal) throw new NotFoundError("Deal not found");
  const fromVerifying = deal.state === "VERIFYING";
  const fromHuman = deal.state === "NEEDS_HUMAN" && deal.needsHumanFrom === "VERIFYING";
  if (!fromVerifying && !fromHuman) return result(ctx, dealId, "REFUSED", `STATE_${deal.state}`);
  if (deal.settlement) return result(ctx, dealId, "REFUSED", "SETTLEMENT_ALREADY_DECIDED");

  const toHuman = async (reasons: string[]) => {
    try {
      if (fromVerifying) await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "NEEDS_HUMAN", actor, { reason: reasons.join(","), reasons }));
      else await ledger(ctx, dealId, "HUMAN_REVIEW_STILL_OPEN", { reasons });
    } catch (e) {
      // A concurrent settlement moved the deal first; the compare-and-set protected the state.
      if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
      throw e;
    }
    return result(ctx, dealId, "NEEDS_HUMAN", reasons.join(","));
  };

  // P3/P5: every consequential action re-derives the whole authorization (expiry is not re-checked here: the authorization pre-dates delivery)
  const authz = authorizeLoadedDeal(deal, { ...ctx.deps, now: ctx.now() });
  if (!authz.ok) return toHuman([TERMS_FAILURES.has(authz.reason) ? "TERMS_DRIFT" : authz.reason]);
  const terms = authz.auth.terms.terms;
  const ver = verificationSchema.safeParse(deal.verificationJson);
  if (!ver.success) return toHuman(["VERIFICATION_MISSING"]);
  const doc = authz.auth.mandate.doc;
  if (!deal.paypalAuthId || !deal.price) return toHuman(["NO_AUTHORIZATION"]);

  const verdicts = verdictSchema.safeParse(deal.humanVerdictsJson ?? []);
  const overridden = new Set(verdicts.success ? verdicts.data.map((v) => v.criterionId) : []);
  const results: CriterionResult[] = [
    ...ver.data.results.filter((r) => !overridden.has(r.criterionId)),
    ...(verdicts.success ? verdicts.data.map((v) => ({ criterionId: v.criterionId, status: v.status, source: "human" as const })) : []),
  ];

  const a = await readAuth(ctx, dealId, deal.paypalAuthId);
  if (!a.ok) return result(ctx, dealId, "WAITING", a.reason); // cannot decide without a fresh authorization; no state change
  const v = validateAuthorization(a.data, { authId: deal.paypalAuthId, fallbackExpiry: deal.authExpiresAt }, ctx.now(), ctx.config.authExpiryMarginMs);
  const price = new D(deal.price.toString());
  const decision = decideSettlement({
    price,
    authorizedAmount: v.ok ? v.amount : new D(0),
    criteria: terms.criteria,
    results,
    flags: ver.data.flags,
    injectionPolicy: doc.injectionPolicy,
    authorizationOk: v.ok,
    partialAllowed: doc.allowPartialSettlement === true && ctx.config.partialCaptureVerified,
  });
  if (decision.decision === "NEEDS_HUMAN") return toHuman(v.ok ? decision.reasons : [...decision.reasons, v.reason]);
  // Payment to the seller waits for the challenge window; a VOID (the contract failed) does not.
  if (decision.decision !== "VOID" && deal.challengeWindowEndsAt && ctx.now() < deal.challengeWindowEndsAt) {
    return result(ctx, dealId, "WAITING", "CHALLENGE_WINDOW_OPEN");
  }

  try {
    const op = await ctx.db.$transaction(async (tx) => {
      await tx.settlement.create({
        data: { dealId, decision: decision.decision, earned: decision.earned, amount: fmt(decision.amount), reasonCodes: decision.reasons },
      });
      const moneyOp =
        decision.decision === "VOID"
          ? await planOp(tx, dealId, "VOID", `/v2/payments/authorizations/${deal.paypalAuthId}/void`, () => undefined)
          : await planOp(tx, dealId, "CAPTURE", `/v2/payments/authorizations/${deal.paypalAuthId}/capture`, (seq) =>
              captureBody({ amount: fmt(decision.amount), finalCapture: true, invoiceId: `${dealId}-settle-${seq}` }),
            );
      await transitionDeal(tx, dealId, "SETTLING", actor, { decision: decision.decision, earned: decision.earned, amount: fmt(decision.amount), reasons: decision.reasons });
      await appendEvent(tx, dealId, "PAYPAL_OPERATION_PLANNED", SYS, { type: moneyOp.type, requestId: moneyOp.requestId, bodyHash: moneyOp.requestBodyHash });
      return moneyOp;
    });
    return driveOp(ctx, op.id, ["PLANNED"]);
  } catch (e) {
    if ((e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") {
      return result(ctx, dealId, "REFUSED", "DUPLICATE_SETTLEMENT_PREVENTED");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pre-delivery cancel (revocation / deadline / human cancel / invalid authorization)
// ---------------------------------------------------------------------------------------------------------------------
export async function cancelAuthorization(ctx: EngineContext, p: { dealId: string; reason: string; actor: string; principalId?: string }): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: p.dealId }, include: { settlement: true, mandate: true } });
  if (p.principalId !== undefined) {
    // Human cancellation is governed by the SIGNED mandate. System cancels (invalid authorization, deadline) skip this.
    if (deal.mandate.principalId !== p.principalId) throw new NotFoundError("Deal not found");
    const doc = openMandateRow(deal.mandate, ctx.deps)?.doc;
    if (!doc || doc.allowPreDeliveryCancellation !== true) return result(ctx, p.dealId, "REFUSED", "CANCELLATION_NOT_PERMITTED_BY_MANDATE");
  }
  if ((deal.state !== "AUTHORIZED" && deal.state !== "AWAITING_DELIVERY") || !deal.paypalAuthId) return result(ctx, p.dealId, "REFUSED", `STATE_${deal.state}`);
  if (deal.settlement) return result(ctx, p.dealId, "REFUSED", "SETTLEMENT_ALREADY_DECIDED");
  try {
    const op = await ctx.db.$transaction(async (tx) => {
      await tx.settlement.create({ data: { dealId: p.dealId, decision: "VOID", earned: 0, amount: "0.00", reasonCodes: [p.reason] } });
      const o = await planOp(tx, p.dealId, "VOID", `/v2/payments/authorizations/${deal.paypalAuthId}/void`, () => undefined);
      await appendEvent(tx, p.dealId, "SETTLEMENT_DECIDED", p.actor, { decision: "VOID", reason: p.reason, requestId: o.requestId });
      return o;
    });
    return driveOp(ctx, op.id, ["PLANNED"]);
  } catch (e) {
    if ((e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") {
      return result(ctx, p.dealId, "REFUSED", "DUPLICATE_SETTLEMENT_PREVENTED");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Finalizers: only a FRESH GET decides what happened. Never a POST response, never a webhook body.
// ---------------------------------------------------------------------------------------------------------------------
async function finalizeCapture(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult> {
  const dealId = op.dealId;
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { settlement: true } });
  if (["CAPTURED", "PARTIALLY_CAPTURED"].includes(deal.state)) return result(ctx, dealId, "DONE");
  if (!op.paypalResourceId) return result(ctx, dealId, "UNRESOLVED", "CAPTURE_RESPONSE_HAD_NO_ID");
  const c = await readCapture(ctx, dealId, op.paypalResourceId);
  if (!c.ok) return result(ctx, dealId, "UNRESOLVED", c.reason);
  const st = c.data.status;
  const inFlight = deal.state === "SETTLING" || deal.state === "SETTLEMENT_PENDING";

  if (st === CAPTURE_STATUS.COMPLETED) {
    const planned = deal.settlement ? new D(deal.settlement.amount.toString()) : null;
    const got = c.data.amount && c.data.amount.currency_code === "USD" ? parseMoney(c.data.amount.value) : null;
    if (!planned || !got || !got.eq(planned) || !inFlight) {
      await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { status: "UNKNOWN", resourceStatus: st, lastError: "CAPTURE_AMOUNT_MISMATCH" } });
      if (inFlight) await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "NEEDS_HUMAN", SYS, { reason: "CAPTURE_AMOUNT_MISMATCH", planned: planned?.toFixed(2) ?? null, got: got?.toFixed(2) ?? null }));
      return result(ctx, dealId, "NEEDS_HUMAN", "CAPTURE_AMOUNT_MISMATCH");
    }
    const authAfter = deal.paypalAuthId ? await readAuth(ctx, dealId, deal.paypalAuthId) : null;
    const price = new D(deal.price!.toString());
    const to: DealState = got.eq(price) ? "CAPTURED" : "PARTIALLY_CAPTURED";
    await ctx.db.$transaction(async (tx) => {
      await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: st } });
      await transitionDeal(tx, dealId, to, SYS, { captureId: c.data.id, captured: fmt(got), authStatusAfter: authAfter?.ok ? authAfter.data.status : "UNREAD" }, {
        capturedAmount: fmt(got),
        paypalCaptureId: c.data.id,
        paypalAuthStatus: authAfter?.ok ? authAfter.data.status : deal.paypalAuthStatus,
      });
      const res = await tx.budgetReservation.findUnique({ where: { dealId } });
      if (res?.status === "ACTIVE") await convertReservation(tx, dealId, got);
    });
    return result(ctx, dealId, "DONE");
  }
  if (st === CAPTURE_STATUS.PENDING) {
    await ctx.db.$transaction(async (tx) => {
      await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: st } });
      if (deal.state === "SETTLING") await transitionDeal(tx, dealId, "SETTLEMENT_PENDING", SYS, { captureId: c.data.id });
    });
    return result(ctx, dealId, "UNRESOLVED", "SETTLEMENT_PENDING");
  }
  if (st === CAPTURE_STATUS.DECLINED || st === CAPTURE_STATUS.FAILED) {
    // Money did not move: the operation is definitively FAILED and a human may plan seq+1.
    await ctx.db.$transaction(async (tx) => {
      await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "FAILED", resourceStatus: st, lastError: `CAPTURE_${st}` } });
      if (inFlight) await transitionDeal(tx, dealId, "NEEDS_HUMAN", SYS, { reason: `CAPTURE_${st}`, captureId: c.data.id });
    });
    return result(ctx, dealId, "NEEDS_HUMAN", `CAPTURE_${st}`);
  }
  // Unknown capture status: we cannot say whether money moved. Keep the operation live (UNKNOWN) so no second capture can start.
  await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { status: "UNKNOWN", resourceStatus: st, lastError: "UNEXPECTED_CAPTURE_STATUS" } });
  if (inFlight) await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "NEEDS_HUMAN", SYS, { reason: `UNEXPECTED_CAPTURE_STATUS_${st}` }));
  return result(ctx, dealId, "NEEDS_HUMAN", `UNEXPECTED_CAPTURE_STATUS_${st}`);
}

async function finalizeVoid(ctx: EngineContext, op: PayPalOperation): Promise<EngineResult> {
  const dealId = op.dealId;
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });
  if (deal.state === "VOIDED") return result(ctx, dealId, "DONE");
  const a = await readAuth(ctx, dealId, deal.paypalAuthId!);
  if (!a.ok) return result(ctx, dealId, "UNRESOLVED", a.reason);
  if (a.data.status === AUTH_STATUS.VOIDED) {
    await ctx.db.$transaction(async (tx) => {
      await tx.payPalOperation.update({ where: { id: op.id }, data: { status: "CONFIRMED", resourceStatus: a.data.status } });
      await transitionDeal(tx, dealId, "VOIDED", SYS, { authId: a.data.id, authStatus: a.data.status }, { paypalAuthStatus: a.data.status });
      await releaseReservation(tx, dealId);
    });
    return result(ctx, dealId, "DONE");
  }
  // The POST was accepted but the authorization does not read VOIDED: do not claim a void.
  await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { status: "UNKNOWN", resourceStatus: a.data.status, lastError: "VOID_NOT_CONFIRMED_BY_GET" } });
  if (deal.state === "SETTLING") await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "NEEDS_HUMAN", SYS, { reason: `VOID_NOT_CONFIRMED_${a.data.status}` }));
  return result(ctx, dealId, deal.state === "SETTLING" ? "NEEDS_HUMAN" : "UNRESOLVED", `VOID_NOT_CONFIRMED_${a.data.status}`);
}

/** SETTLEMENT_PENDING -> CAPTURED | PARTIALLY_CAPTURED | NEEDS_HUMAN, decided by a fresh GET only. */
export async function resolveSettlementPending(ctx: EngineContext, dealId: string): Promise<EngineResult> {
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });
  if (deal.state !== "SETTLEMENT_PENDING") return result(ctx, dealId, "REFUSED", `STATE_${deal.state}`);
  const op = await ctx.db.payPalOperation.findFirst({ where: { dealId, type: "CAPTURE" }, orderBy: { seq: "desc" } });
  if (!op) return result(ctx, dealId, "REFUSED", "NO_CAPTURE_OPERATION");
  return finalizeCapture(ctx, op);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciliation: GET first. Resend only the SAME request id, only when the resource proves the write did not apply.
// ---------------------------------------------------------------------------------------------------------------------
export async function reconcileOperation(ctx: EngineContext, opId: string): Promise<EngineResult> {
  const op = await ctx.db.payPalOperation.findUniqueOrThrow({ where: { id: opId } });
  const dealId = op.dealId;
  if (op.status === "CONFIRMED" || op.status === "FAILED") return result(ctx, dealId, "DONE", `OPERATION_${op.status}`);
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });

  if (op.status === "PLANNED") return driveOp(ctx, op.id, ["PLANNED"]); // never sent
  if (op.status === "SENT" && !op.responseStatus && ctx.now().getTime() - (op.lastAttemptAt ?? op.updatedAt).getTime() < ctx.config.staleSentMs) {
    return result(ctx, dealId, "WAITING", "OPERATION_IN_FLIGHT");
  }
  // A write that already returned 2xx just needs finalizing against a fresh GET.
  if (op.responseStatus && op.responseStatus >= 200 && op.responseStatus < 300 && (op.paypalResourceId || op.type === "VOID")) return finalizeOp(ctx, op.id);

  // A SENT operation that is stale (crashed worker) is demoted to UNKNOWN by an atomic compare-and-set, so exactly
  // one reconciler proceeds. Resends may only be claimed from UNKNOWN.
  if (op.status === "SENT" && !op.responseStatus) {
    const demoted = await ctx.db.payPalOperation.updateMany({ where: { id: op.id, status: "SENT", responseStatus: null }, data: { status: "UNKNOWN", lastError: "STALE_SENT" } });
    if (demoted.count !== 1) return result(ctx, dealId, "WAITING", "OPERATION_STATE_CHANGED");
  }
  const canResend = op.attemptCount < ctx.config.maxOperationAttempts;
  const resend = async () => {
    await ledger(ctx, dealId, "RECONCILE_RESEND_SAME_REQUEST_ID", { type: op.type, requestId: op.requestId, attempt: op.attemptCount + 1 });
    const out = await sendOp(ctx, op.id, ["UNKNOWN"]);
    if (out.kind === "not_claimed") return result(ctx, dealId, "UNRESOLVED", "OPERATION_NOT_CLAIMABLE");
    if (out.kind === "unknown") return result(ctx, dealId, "UNRESOLVED", `PAYPAL_OUTCOME_UNKNOWN:${out.code}`);
    if (out.kind === "rejected") return onRejected(ctx, out.op, out.code);
    return finalizeOp(ctx, out.op.id);
  };
  const escalate = async (reason: string) => {
    await ledger(ctx, dealId, "RECONCILE_AMBIGUOUS", { type: op.type, requestId: op.requestId, reason });
    if (deal.state === "SETTLING" || deal.state === "SETTLEMENT_PENDING") {
      await ctx.db.$transaction((tx) => transitionDeal(tx, dealId, "NEEDS_HUMAN", SYS, { reason: `RECONCILE_AMBIGUOUS:${reason}` }));
      return result(ctx, dealId, "NEEDS_HUMAN", `RECONCILE_AMBIGUOUS:${reason}`);
    }
    return result(ctx, dealId, "UNRESOLVED", `RECONCILE_AMBIGUOUS:${reason}`);
  };

  switch (op.type) {
    case "CREATE_ORDER":
      // Cannot look the order up before knowing its id. Same request id => PayPal idempotency (UNVERIFIED in Sandbox).
      return canResend ? resend() : escalate("CREATE_ORDER_ATTEMPTS_EXHAUSTED");
    case "AUTHORIZE": {
      const o = await readOrder(ctx, dealId, deal.paypalOrderId!);
      if (!o.ok) return result(ctx, dealId, "UNRESOLVED", o.reason);
      if (o.data.purchase_units?.[0]?.payments?.authorizations?.[0]) return finalizeAuthorize(ctx, op);
      if (o.data.status === ORDER_STATUS.APPROVED && canResend) return resend();
      return escalate(`ORDER_${o.data.status}`);
    }
    case "CAPTURE": {
      const o = await readOrder(ctx, dealId, deal.paypalOrderId!);
      if (!o.ok) return result(ctx, dealId, "UNRESOLVED", o.reason);
      const invoice = (op.requestBody as { invoice_id?: string } | null)?.invoice_id;
      const found = o.data.purchase_units?.[0]?.payments?.captures?.find((c) => c.invoice_id === invoice);
      if (found) {
        const linked = await ctx.db.payPalOperation.update({ where: { id: op.id }, data: { paypalResourceId: found.id } });
        return finalizeCapture(ctx, linked);
      }
      const a = await readAuth(ctx, dealId, deal.paypalAuthId!);
      if (!a.ok) return result(ctx, dealId, "UNRESOLVED", a.reason);
      const v = validateAuthorization(a.data, { authId: deal.paypalAuthId, fallbackExpiry: deal.authExpiresAt }, ctx.now(), ctx.config.authExpiryMarginMs);
      // Untouched authorization + no capture carrying our invoice id: the write provably did not apply.
      if (v.ok && canResend) return resend();
      return escalate(v.ok ? "CAPTURE_ATTEMPTS_EXHAUSTED" : v.reason);
    }
    case "VOID": {
      const a = await readAuth(ctx, dealId, deal.paypalAuthId!);
      if (!a.ok) return result(ctx, dealId, "UNRESOLVED", a.reason);
      if (a.data.status === AUTH_STATUS.VOIDED) return finalizeVoid(ctx, op);
      if (a.data.status === AUTH_STATUS.CREATED && canResend) return resend();
      return escalate(`AUTH_${a.data.status}`);
    }
    default:
      return escalate(`UNSUPPORTED_${op.type}`);
  }
}

/** Sweeper entry point: reconcile every stuck operation and every pending settlement. */
export async function reconcileAll(ctx: EngineContext): Promise<EngineResult[]> {
  const stuck = await ctx.db.payPalOperation.findMany({ where: { status: { in: ["PLANNED", "SENT", "UNKNOWN"] } }, orderBy: { createdAt: "asc" } });
  const out: EngineResult[] = [];
  for (const op of stuck) out.push(await reconcileOperation(ctx, op.id));
  const pending = await ctx.db.deal.findMany({ where: { state: "SETTLEMENT_PENDING" }, select: { id: true } });
  for (const d of pending) out.push(await resolveSettlementPending(ctx, d.id));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// POST-VERIFICATION POLICY (owner ruling, 2026-11-06)
//  * There is NO unrestricted human rejection. If mandatory criteria fail, the deterministic engine computes the outcome.
//    If they all pass, settlement follows the signed mandate.
//  * A human can only (a) give a verdict on a criterion the machines could not resolve, (b) retry a FAILED capture,
//    or (c) CHALLENGE a passed criterion with a reason and evidence references. A challenge pauses settlement
//    (SETTLEMENT_REVIEW); re-verification against the ORIGINAL locked terms returns to VERIFYING and the engine decides.
//  * A timed-out or unresolved challenge goes to NEEDS_HUMAN and can never capture or void by itself.
//  * No human input here carries an amount.
// ---------------------------------------------------------------------------------------------------------------------
const verdictSchema = z.array(z.object({ criterionId: z.string(), status: z.enum(["met", "not_met"]) }).strict()).max(50);

/** ledger:<seq> and delivery:<id> must exist for this deal; external:https://... is stored unverified. */
const EVIDENCE_REF = /^(ledger:\d{1,6}|delivery:[A-Za-z0-9_-]{5,40}|external:https:\/\/[^\s]{4,300})$/;
const evidenceRefs = z.array(z.string().regex(EVIDENCE_REF)).min(1).max(10);

export const challengeSchema = z
  .object({
    criterionId: z.string().min(1).max(64),
    reason: z.string().trim().min(10).max(1000),
    evidenceRefs,
  })
  .strict();
export type Challenge = z.infer<typeof challengeSchema>;
export const MAX_CHALLENGES = 2;

const priorChallengesSchema = z.array(z.object({ criterionId: z.string() }).passthrough());

export async function challengeVerification(
  ctx: EngineContext,
  p: { dealId: string; principalId: string; principalEmail: string; challenge: unknown },
): Promise<EngineResult> {
  const ch = challengeSchema.parse(p.challenge); // strict: an "amount" key is a validation error
  const deal = await ctx.db.deal.findFirst({ where: { id: p.dealId, mandate: { principalId: p.principalId } } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.state !== "VERIFYING") return result(ctx, p.dealId, "REFUSED", `STATE_${deal.state}`); // also what a duplicate submission sees
  const terms = readLockedTerms(deal.termsJson);
  const ver = verificationSchema.safeParse(deal.verificationJson);
  if (!terms.ok || !ver.success) return result(ctx, p.dealId, "REFUSED", "NO_VERIFICATION_TO_CHALLENGE");
  if (!terms.terms.criteria.some((c) => c.id === ch.criterionId)) return result(ctx, p.dealId, "REFUSED", "UNKNOWN_CRITERION");
  const cur = ver.data.results.find((r) => r.criterionId === ch.criterionId);
  if (!cur || cur.status !== "met") return result(ctx, p.dealId, "REFUSED", "CRITERION_NOT_PASSED"); // only a PASSED result can be disputed
  const prior = priorChallengesSchema.safeParse(deal.challengesJson ?? []);
  const priorList = prior.success ? prior.data : [];
  if (priorList.length >= MAX_CHALLENGES) return result(ctx, p.dealId, "REFUSED", "CHALLENGE_LIMIT_REACHED");
  if (priorList.some((c) => c.criterionId === ch.criterionId)) return result(ctx, p.dealId, "REFUSED", "CHALLENGE_ALREADY_USED_FOR_CRITERION");

  for (const ref of ch.evidenceRefs) {
    if (ref.startsWith("ledger:")) {
      const ok = await ctx.db.dealEvent.findFirst({ where: { dealId: p.dealId, seq: Number(ref.slice(7)) }, select: { id: true } });
      if (!ok) return result(ctx, p.dealId, "REFUSED", `EVIDENCE_NOT_FOUND:${ref}`);
    } else if (ref.startsWith("delivery:")) {
      const ok = await ctx.db.delivery.findFirst({ where: { id: ref.slice(9), dealId: p.dealId }, select: { id: true } });
      if (!ok) return result(ctx, p.dealId, "REFUSED", `EVIDENCE_NOT_FOUND:${ref}`);
    }
  }

  const actor = `human:${p.principalEmail}`;
  const entry = { criterionId: ch.criterionId, reason: ch.reason, evidenceRefs: ch.evidenceRefs, at: ctx.now().toISOString(), by: p.principalEmail };
  try {
    await ctx.db.$transaction((tx) =>
      transitionDeal(
        tx,
        p.dealId,
        "SETTLEMENT_REVIEW",
        actor,
        { challenged: ch.criterionId, reason: ch.reason, evidenceRefs: ch.evidenceRefs },
        { reviewDeadline: new Date(ctx.now().getTime() + ctx.config.reviewTimeoutMs), challengesJson: [...priorList, entry] as unknown as Prisma.InputJsonValue },
      ),
    );
  } catch (e) {
    if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, p.dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
    throw e;
  }
  return result(ctx, p.dealId, "DONE", "SETTLEMENT_PAUSED_FOR_REVIEW");
}

export const reverificationSchema = verificationSchema.extend({ evidenceRefs }).strict();

/**
 * System-side entry (the verification pipeline, Gate 4), never a human or agent: records a fresh verification of the
 * ORIGINAL locked terms plus new evidence and returns the deal to VERIFYING. The previous verification is preserved
 * in the ledger by hash. The engine then decides; the challenge window is not reopened.
 */
export async function recordReverification(ctx: EngineContext, dealId: string, input: unknown): Promise<EngineResult> {
  const re = reverificationSchema.parse(input);
  const deal = await ctx.db.deal.findUniqueOrThrow({ where: { id: dealId } });
  if (deal.state !== "SETTLEMENT_REVIEW") return result(ctx, dealId, "REFUSED", `STATE_${deal.state}`);
  const terms = readLockedTerms(deal.termsJson);
  if (!terms.ok || !deal.termsHash || !termsMatchLockAny(deal.termsJson, deal.termsHash)) return result(ctx, dealId, "REFUSED", "TERMS_DRIFT");
  const ids = new Set(terms.terms.criteria.map((c) => c.id));
  if (re.results.some((r) => !ids.has(r.criterionId))) return result(ctx, dealId, "REFUSED", "RESULT_FOR_UNKNOWN_CRITERION");
  const previousHash = sha256Hex(canonicalJson(deal.verificationJson ?? null));
  const next = { results: re.results, flags: re.flags };
  try {
    await ctx.db.$transaction((tx) =>
      transitionDeal(
        tx,
        dealId,
        "VERIFYING",
        SYS,
        { reverification: true, evidenceRefs: re.evidenceRefs, previousVerificationHash: previousHash, results: re.results.map((r) => ({ id: r.criterionId, status: r.status, source: r.source })) },
        { verificationJson: next as unknown as Prisma.InputJsonValue, challengeWindowEndsAt: null, reviewDeadline: null },
      ),
    );
  } catch (e) {
    if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
    throw e;
  }
  return result(ctx, dealId, "DONE");
}

/** Sweeper: overdue challenges pause in NEEDS_HUMAN. This function can move NOTHING to capture or void. */
export async function expireOverdueReviews(ctx: EngineContext): Promise<{ dealId: string; expired: boolean }[]> {
  const due = await ctx.db.deal.findMany({ where: { state: "SETTLEMENT_REVIEW", reviewDeadline: { lte: ctx.now() } }, select: { id: true } });
  const out: { dealId: string; expired: boolean }[] = [];
  for (const d of due) {
    try {
      await ctx.db.$transaction((tx) => transitionDeal(tx, d.id, "NEEDS_HUMAN", SYS, { reason: "REVIEW_TIMEOUT" }));
      out.push({ dealId: d.id, expired: true });
    } catch (e) {
      if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") out.push({ dealId: d.id, expired: false });
      else throw e;
    }
  }
  return out;
}

/**
 * The buyer ACCEPTS a verified delivery before the challenge window ends, i.e. waives their own waiting period. Owner only, only while the deal is VERIFYING with the window
 * still open. It changes nothing but the end of that window: no amount, no criterion, no verdict. Settlement then re-derives everything (verification hash, terms, mandate,
 * authorization, criteria, flags) exactly as it would when the window ends by itself, so a failed, unverifiable or flagged delivery is not made payable by accepting.
 */
export async function acceptVerification(ctx: EngineContext, p: { dealId: string; principalId: string; principalEmail: string }): Promise<EngineResult> {
  const deal = await ctx.db.deal.findFirst({ where: { id: p.dealId, mandate: { principalId: p.principalId } } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.state !== "VERIFYING") return result(ctx, p.dealId, "REFUSED", `STATE_${deal.state}`);
  const now = ctx.now();
  if (!deal.challengeWindowEndsAt || deal.challengeWindowEndsAt <= now) return result(ctx, p.dealId, "REFUSED", "NO_OPEN_CHALLENGE_WINDOW");
  const moved = await ctx.db.$transaction(async (tx) => {
    const r = await tx.deal.updateMany({ where: { id: p.dealId, state: "VERIFYING", challengeWindowEndsAt: deal.challengeWindowEndsAt }, data: { challengeWindowEndsAt: now } });
    if (r.count !== 1) return false;
    await appendEvent(tx, p.dealId, "HUMAN_REVIEW_DECISION", `human:${p.principalEmail}`, { phase: "POST_AUTH", decision: "accept", windowWas: deal.challengeWindowEndsAt!.toISOString() });
    return true;
  });
  return moved ? result(ctx, p.dealId, "DONE") : result(ctx, p.dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
}

export const reviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve"), verdicts: verdictSchema.optional() }).strict(),
  z.object({ kind: z.literal("retry") }).strict(),
  z.object({ kind: z.literal("resume_review") }).strict(),
]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export async function resolvePostAuthReview(
  ctx: EngineContext,
  p: { dealId: string; principalId: string; principalEmail: string; decision: unknown },
): Promise<EngineResult> {
  const decision = reviewDecisionSchema.parse(p.decision); // "reject", or any key such as "amount", is a validation error
  const deal = await ctx.db.deal.findFirst({ where: { id: p.dealId, mandate: { principalId: p.principalId } }, include: { settlement: true } });
  if (!deal) throw new NotFoundError("Deal not found");
  const origin = deal.needsHumanFrom as DealState | null;
  if (deal.state !== "NEEDS_HUMAN" || !origin || !["VERIFYING", "SETTLING", "SETTLEMENT_PENDING", "SETTLEMENT_REVIEW"].includes(origin)) {
    throw new StaleStateError("Deal is not awaiting a post-authorization review");
  }
  const actor = `human:${p.principalEmail}`;

  if (origin === "SETTLEMENT_REVIEW") {
    if (decision.kind !== "resume_review") return result(ctx, p.dealId, "REFUSED", "CHALLENGE_NEEDS_RESUME_OR_REVERIFICATION");
    await ledger(ctx, p.dealId, "HUMAN_REVIEW_DECISION", { phase: "POST_AUTH", decision: "resume_review" }, actor);
    try {
      await ctx.db.$transaction((tx) =>
        transitionDeal(tx, p.dealId, "SETTLEMENT_REVIEW", actor, { reason: "REVIEW_RESUMED" }, { reviewDeadline: new Date(ctx.now().getTime() + ctx.config.reviewTimeoutMs) }),
      );
    } catch (e) {
      if (e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") return result(ctx, p.dealId, "REFUSED", "CONCURRENT_STATE_CHANGE");
      throw e;
    }
    return result(ctx, p.dealId, "DONE");
  }
  if (decision.kind === "resume_review") return result(ctx, p.dealId, "REFUSED", "NOT_IN_CHALLENGE_REVIEW");

  if (origin === "VERIFYING") {
    if (decision.kind === "retry") return result(ctx, p.dealId, "REFUSED", "NOTHING_TO_RETRY");
    const verdicts = decision.verdicts ?? [];
    const terms = readLockedTermsOrThrow(deal.termsJson);
    const ver = verificationSchema.parse(deal.verificationJson);
    for (const v of verdicts) {
      const c = terms.criteria.find((x) => x.id === v.criterionId);
      const cur = ver.results.find((r) => r.criterionId === v.criterionId);
      // Humans resolve what machines could not: an unverifiable/missing result, or an LLM-judged failure that only a verifier
      // asserted. A criterion that already PASSED can only be disputed through challengeVerification (reason + evidence).
      const allowed = !!c && (!cur || cur.status === "unverifiable" || (c.type === "llm_judged" && cur.status === "not_met" && cur.source === "verifier"));
      if (!allowed) return result(ctx, p.dealId, "REFUSED", `VERDICT_NOT_ALLOWED:${v.criterionId}`);
    }
    await ctx.db.deal.update({ where: { id: p.dealId }, data: { humanVerdictsJson: verdicts as unknown as Prisma.InputJsonValue } });
    await ledger(ctx, p.dealId, "HUMAN_REVIEW_DECISION", { phase: "POST_AUTH", decision: "approve", verdicts }, actor);
    return settleDeal(ctx, p.dealId, actor);
  }

  // origin SETTLING / SETTLEMENT_PENDING: the settlement is already decided and immutable. The only human option is to retry it.
  if (decision.kind === "approve" && (decision.verdicts?.length ?? 0) > 0) return result(ctx, p.dealId, "REFUSED", "VERDICTS_NOT_APPLICABLE");
  if (!deal.settlement) return result(ctx, p.dealId, "REFUSED", "NO_SETTLEMENT_ROW");
  const lastMoney = await ctx.db.payPalOperation.findFirst({ where: { dealId: p.dealId, type: { in: ["CAPTURE", "VOID"] } }, orderBy: { createdAt: "desc" } });
  if (!lastMoney || lastMoney.status !== "FAILED") return result(ctx, p.dealId, "REFUSED", "LIVE_OR_UNRESOLVED_MONEY_OPERATION");
  await ledger(ctx, p.dealId, "HUMAN_REVIEW_DECISION", { phase: "POST_AUTH", decision: "retry" }, actor);
  return retrySettlement(ctx, p.dealId, actor, deal.settlement.decision === "VOID" ? "VOID" : "CAPTURE");
}

/** Re-plan the SAME pre-decided settlement as a new operation (seq+1). The amount is read from the immutable Settlement row. */
async function retrySettlement(ctx: EngineContext, dealId: string, actor: string, kind: "CAPTURE" | "VOID"): Promise<EngineResult> {
  try {
    const op = await ctx.db.$transaction(async (tx) => {
      const deal = await tx.deal.findUniqueOrThrow({ where: { id: dealId }, include: { settlement: true } });
      const settlement = deal.settlement!;
      const o =
        kind === "VOID"
          ? await planOp(tx, dealId, "VOID", `/v2/payments/authorizations/${deal.paypalAuthId}/void`, () => undefined)
          : await planOp(tx, dealId, "CAPTURE", `/v2/payments/authorizations/${deal.paypalAuthId}/capture`, (seq) =>
              captureBody({ amount: settlement.amount.toString(), finalCapture: true, invoiceId: `${dealId}-settle-${seq}` }),
            );
      await transitionDeal(tx, dealId, "SETTLING", actor, { reason: "HUMAN_RETRY", requestId: o.requestId });
      return o;
    });
    return driveOp(ctx, op.id, ["PLANNED"]);
  } catch (e) {
    if ((e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || e instanceof StaleStateError || (e as Error).name === "IllegalTransitionError") {
      return result(ctx, dealId, "REFUSED", "DUPLICATE_SETTLEMENT_PREVENTED");
    }
    throw e;
  }
}
