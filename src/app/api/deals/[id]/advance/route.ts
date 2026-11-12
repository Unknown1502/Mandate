import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const body = z.strictObject({});

/**
 * Drive the deal as far as it can go without a human: policy, budget reservation, PayPal order creation, buyer-approval refresh, verification and settlement. This is the
 * payment-adjacent door, so it needs the session principal AND ownership. The engine still decides every money action (a failed or unverifiable result never captures).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  try {
    return NextResponse.json(await getRuntime().orchestrator.advance(deal.id));
  } catch (e) {
    return errorResponse(e);
  }
}
