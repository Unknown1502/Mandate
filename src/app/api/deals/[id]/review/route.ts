import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/**
 * The buyer's post-verification decision, exactly as the settlement policy allows it (owner ruling 2026-11-06): give a verdict on a criterion the machines could not
 * resolve, retry a failed capture, or resume a challenge review. There is NO unrestricted reject, and no input here can carry an amount (the schema is strict and the
 * engine validates it again). The deterministic engine decides what the verdicts mean for money.
 */
const body = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("approve"), verdicts: z.array(z.strictObject({ criterionId: z.string().min(1).max(64), status: z.enum(["met", "not_met"]) })).max(50).optional() }),
  z.strictObject({ kind: z.literal("retry") }),
  z.strictObject({ kind: z.literal("resume_review") }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  try {
    return NextResponse.json(await getRuntime().orchestrator.reviewDecision({ principalId: auth.principal.principalId, email: auth.principal.email }, deal.id, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}
