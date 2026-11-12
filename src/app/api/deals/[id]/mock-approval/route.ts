import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const body = z.strictObject({});

/**
 * MOCK PayPal only: stands in for the buyer completing PayPal checkout, which in PAYPAL_MODE=sandbox happens on PayPal's own approval page. It acts solely on the in-memory
 * mock gateway object, so it cannot approve, authorize or capture anything at PayPal; in sandbox mode this route answers 404 and does nothing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  const rt = getRuntime();
  if (!rt.mockPayPal) return notFound();
  if (!deal.paypalOrderId || !rt.mockPayPal.orders.has(deal.paypalOrderId)) return NextResponse.json({ error: "NO_MOCK_ORDER", state: deal.state }, { status: 409 });
  try {
    rt.mockPayPal.buyerApprove(deal.paypalOrderId);
    return NextResponse.json(await rt.orchestrator.advance(deal.id));
  } catch (e) {
    return errorResponse(e);
  }
}
