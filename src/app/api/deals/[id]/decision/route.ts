import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const body = z.strictObject({ decision: z.enum(["approve", "reject"]) });

/** The pre-authorization human decision on a deal the policy engine escalated. Only the owner can decide; the orchestrator re-checks ownership and the deal state. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  try {
    const out = await getRuntime().orchestrator.preAuthDecision({ principalId: auth.principal.principalId, email: auth.principal.email }, deal.id, parsed.data.decision);
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
