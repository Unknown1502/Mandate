import { prisma, deps, keys, makeMandate, makePrincipal, termsFor } from "./fixtures";
import { beginNegotiation, checkPolicy, createDeal, lockTerms, reserveForDeal, transitionDeal } from "@/domain/deals";
import { defaultEngineConfig, createPayPalOrder, recordVerification, refreshBuyerApproval, type EngineContext } from "@/settlement/engine";
import { MockPayPal } from "../helpers/mockPayPal";
import type { Criterion, TermsV1 } from "@/domain/terms";

export { prisma, deps, keys };

export function makeCtx(mock: MockPayPal, over: { partialCaptureVerified?: boolean; now?: () => Date; config?: Partial<EngineContext["config"]> } = {}): EngineContext {
  return {
    db: prisma,
    gateway: mock,
    deps,
    config: { ...defaultEngineConfig("http://localhost:3000"), challengeWindowMs: 0, partialCaptureVerified: over.partialCaptureVerified ?? false, ...over.config },
    now: over.now ?? (() => new Date()),
  };
}

export const det = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "deterministic", validator: "no_duplicate_rows", params: {}, required, weight });
export const llm = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "llm_judged", required, weight });

export interface Setup {
  allowPartial?: boolean;
  criteria?: Criterion[];
  price?: string;
  mandateOver?: Record<string, unknown>;
}

/** Principal + sealed mandate + deal with locked terms, policy-checked and budget-reserved (state POLICY_CHECKED). */
export async function policyCheckedDeal(s: Setup = {}) {
  const p = await makePrincipal();
  const m = await makeMandate(p, { allowPartialSettlement: s.allowPartial ?? false, ...s.mandateOver });
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
  const over: Partial<TermsV1> = { price: s.price ?? "20.00", ...(s.criteria ? { criteria: s.criteria } : {}) };
  await lockTerms(prisma, { dealId: deal.id, terms: termsFor(m.id, over), actor: "buyer-agent", principalId: p.id });
  const pol = await checkPolicy(prisma, { dealId: deal.id, deps });
  if (pol.outcome !== "OK") throw new Error(`fixture policy ${pol.outcome} ${pol.reasons}`);
  const rsv = await reserveForDeal(prisma, { dealId: deal.id, deps });
  if (!rsv.ok) throw new Error("fixture reservation failed");
  return { p, m, dealId: deal.id };
}

/** ...through order creation, mock buyer approval and authorization: state AWAITING_DELIVERY. */
export async function authorizedDeal(mock: MockPayPal, ctx: EngineContext, s: Setup = {}) {
  const base = await policyCheckedDeal(s);
  const created = await createPayPalOrder(ctx, base.dealId);
  if (created.status !== "DONE") throw new Error(`fixture createOrder: ${created.status} ${created.reason}`);
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } });
  mock.buyerApprove(deal.paypalOrderId!); // test helper standing in for the human checkout. MOCK.
  const auth = await refreshBuyerApproval(ctx, base.dealId);
  if (auth.status !== "DONE") throw new Error(`fixture authorize: ${auth.status} ${auth.reason}`);
  return base;
}

/** ...through delivery and a recorded verification: state VERIFYING. */
export async function verifyingDeal(mock: MockPayPal, ctx: EngineContext, results: unknown, s: Setup = {}, flags: unknown[] = []) {
  const base = await authorizedDeal(mock, ctx, s);
  await prisma.$transaction((tx) => transitionDeal(tx, base.dealId, "DELIVERED", "seller-sim", { note: "test delivery" }));
  const r = await recordVerification(ctx, base.dealId, { results, flags });
  if (r.status !== "DONE") throw new Error(`fixture verification: ${r.status} ${r.reason}`);
  return base;
}

export const allMet = (ids: string[]) => ids.map((criterionId) => ({ criterionId, status: "met", source: "deterministic" }));
