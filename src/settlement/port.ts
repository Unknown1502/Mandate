/**
 * Adapter that implements the orchestrator's SettlementPort on top of the Gate 2 engine. This is the only place the orchestration layer
 * reaches the engine; every money decision, PayPal call, request id and operation record stays inside the engine. Instructions are
 * re-validated here against what the engine actually holds, so a stale or forged instruction cannot trigger settlement.
 */
import type { PortResult, SettlementPort } from "../orchestration/ports";
import { settlementInstructionSchema } from "../orchestration/ports";
import {
  cancelAuthorization,
  acceptVerification,
  challengeVerification,
  createPayPalOrder,
  expireOverdueReviews,
  reconcileOperation,
  refreshBuyerApproval,
  resolvePostAuthReview,
  resolveSettlementPending,
  settleDeal,
  type EngineContext,
  type EngineResult,
} from "./engine";
import { submitVerificationToSettlement } from "./verification-intake";

export function createSettlementPort(ctx: EngineContext): SettlementPort {
  const stateOf = async (dealId: string) => (await ctx.db.deal.findUnique({ where: { id: dealId }, select: { state: true } }))?.state ?? "UNKNOWN";
  const wrap = async (dealId: string, r: EngineResult | { status: string; reason?: string }): Promise<PortResult> => ({ status: r.status, reason: r.reason, state: (r as EngineResult).state ?? (await stateOf(dealId)) });

  return {
    createOrder: async (dealId) => wrap(dealId, await createPayPalOrder(ctx, dealId)),
    refreshApproval: async (dealId) => wrap(dealId, await refreshBuyerApproval(ctx, dealId)),
    submitVerification: async (i) => wrap(i.dealId, await submitVerificationToSettlement(ctx, i)),

    async requestSettlement(raw) {
      const parsed = settlementInstructionSchema.safeParse(raw);
      if (!parsed.success) return { status: "REFUSED", reason: "INSTRUCTION_INVALID", state: "UNKNOWN" };
      const ins = parsed.data;
      const deal = await ctx.db.deal.findUnique({ where: { id: ins.dealId }, select: { termsHash: true, state: true } });
      if (!deal) return { status: "REFUSED", reason: "UNKNOWN_DEAL", state: "UNKNOWN" };
      if (deal.termsHash !== ins.termsHash) return { status: "REFUSED", reason: "STALE_INSTRUCTION", state: deal.state };
      // The instruction must refer to the verification the ENGINE currently holds (the latest one handed over).
      const last = (await ctx.db.dealEvent.findMany({ where: { dealId: ins.dealId, type: "VERIFICATION_SUBMITTED" }, orderBy: { seq: "desc" }, take: 1 }))[0];
      const p = last?.payload as { verificationId?: string; resultHash?: string } | undefined;
      if (!p || p.verificationId !== ins.verificationId || p.resultHash !== ins.resultHash) return { status: "REFUSED", reason: "STALE_INSTRUCTION", state: deal.state };
      return wrap(ins.dealId, await settleDeal(ctx, ins.dealId, "orchestrator"));
    },

    acceptVerification: async (i) => wrap(i.dealId, await acceptVerification(ctx, i)),
    submitChallenge: async (i) => wrap(i.dealId, await challengeVerification(ctx, i)),
    submitReviewDecision: async (i) => wrap(i.dealId, await resolvePostAuthReview(ctx, i)),
    expireOverdueReviews: () => expireOverdueReviews(ctx),

    /** Drive any in-doubt money operation for ONE deal to a conclusion via the engine's GET-first reconciliation. Never re-plans an operation. */
    async reconcileDeal(dealId) {
      const ops = await ctx.db.payPalOperation.findMany({ where: { dealId, status: { in: ["PLANNED", "SENT", "UNKNOWN"] } }, orderBy: { createdAt: "asc" } });
      let last: EngineResult | undefined;
      for (const op of ops) last = await reconcileOperation(ctx, op.id);
      if ((await stateOf(dealId)) === "SETTLEMENT_PENDING") last = await resolveSettlementPending(ctx, dealId);
      return wrap(dealId, last ?? { status: "DONE", reason: "NOTHING_TO_RECONCILE" });
    },

    /** System cancel (not a human cancel) once the delivery deadline has passed with no delivery. */
    async cancelForDeadline(dealId) {
      const deal = await ctx.db.deal.findUnique({ where: { id: dealId }, select: { deadline: true } });
      if (!deal?.deadline || ctx.now() <= deal.deadline) return { status: "WAITING", reason: "DEADLINE_NOT_REACHED", state: await stateOf(dealId) };
      return wrap(dealId, await cancelAuthorization(ctx, { dealId, reason: "DELIVERY_DEADLINE_PASSED", actor: "orchestrator" }));
    },
  };
}
