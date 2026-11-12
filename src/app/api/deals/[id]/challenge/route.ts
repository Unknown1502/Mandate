import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** "Request review": challenge ONE passed criterion with a reason and evidence references. It pauses settlement; re-verification against the ORIGINAL locked terms decides. */
const body = z.strictObject({ criterionId: z.string().min(1).max(64), reason: z.string().trim().min(10).max(1000), evidenceRefs: z.array(z.string().max(320)).min(1).max(10) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  try {
    return NextResponse.json(await getRuntime().orchestrator.challenge({ principalId: auth.principal.principalId, email: auth.principal.email }, deal.id, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}
