import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const body = z.strictObject({});

/**
 * The buyer accepts a verified delivery before the challenge window ends. This only waives the buyer's own waiting period: it carries no amount and no verdict, and
 * settlement is still derived deterministically (a failed, unverifiable or flagged delivery is not made payable by accepting).
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
    return NextResponse.json(await getRuntime().orchestrator.accept({ principalId: auth.principal.principalId, email: auth.principal.email }, deal.id));
  } catch (e) {
    return errorResponse(e);
  }
}
