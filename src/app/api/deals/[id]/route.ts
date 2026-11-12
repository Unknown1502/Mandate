import { NextResponse } from "next/server";
import { notFound, ownedDeal, requirePrincipalRead } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";
import { dealView, eventView } from "@/lib/views";

export const dynamic = "force-dynamic";

/**
 * One of the session principal's deals with everything the dashboard shows: negotiation transcript, Buyer-Agent model runs (empty unless a real model ran), the delivery
 * and its evidence, the latest deterministic verification, the settlement decision, PayPal operations and the audit ledger. Another principal's deal and a missing deal
 * are the same 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalRead(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  const rt = getRuntime();
  const [events, messages, runs, delivery, verification, settlement, ops] = await Promise.all([
    rt.db.dealEvent.findMany({ where: { dealId: deal.id }, orderBy: { seq: "asc" }, take: 500 }),
    rt.db.negotiationMessage.findMany({ where: { dealId: deal.id }, orderBy: [{ round: "asc" }, { createdAt: "asc" }], take: 100 }),
    rt.db.agentRun.findMany({ where: { dealId: deal.id }, orderBy: { createdAt: "asc" }, take: 50 }),
    rt.db.delivery.findUnique({ where: { dealId: deal.id } }),
    rt.db.verificationRun.findFirst({ where: { dealId: deal.id }, orderBy: { sequence: "desc" } }),
    rt.db.settlement.findUnique({ where: { dealId: deal.id } }),
    rt.db.payPalOperation.findMany({ where: { dealId: deal.id }, orderBy: { createdAt: "asc" }, take: 50 }),
  ]);
  return NextResponse.json({
    /** the server's clock at the moment of this answer, so the page can show a challenge-window countdown without trusting the browser clock */
    serverTime: new Date().toISOString(),
    deal: dealView(deal),
    events: events.map(eventView),
    negotiation: messages.map((m) => ({ round: m.round, sender: m.sender, kind: m.kind, payload: m.payload, createdAt: m.createdAt.toISOString() })),
    modelRuns: runs.map((r) => ({ role: r.role, model: r.model, latencyMs: r.latencyMs, promptHash: r.promptHash, output: r.outputJson, createdAt: r.createdAt.toISOString() })),
    delivery: delivery
      ? {
          id: delivery.id,
          reference: delivery.artifactReference,
          sha256: delivery.artifactSha256,
          size: delivery.artifactSize,
          mediaType: delivery.mediaType,
          submittedAt: delivery.submittedAt?.toISOString() ?? null,
          sellerPrincipalId: delivery.sellerPrincipalId,
          preview: delivery.artifactText.split("\n").slice(0, 25).join("\n"),
          flags: delivery.flagsJson,
        }
      : null,
    verification: verification
      ? { id: verification.verificationId, overall: verification.overall, verifierVersion: verification.verifierVersion, result: verification.resultJson, createdAt: verification.createdAt.toISOString() }
      : null,
    settlement: settlement ? { decision: settlement.decision, earned: settlement.earned, amount: settlement.amount.toString(), reasonCodes: settlement.reasonCodes } : null,
    paypalOperations: ops.map((o) => ({ type: o.type, seq: o.seq, status: o.status, resourceStatus: o.resourceStatus, resourceId: o.paypalResourceId, responseStatus: o.responseStatus, attempts: o.attemptCount, createdAt: o.createdAt.toISOString() })),
  });
}
