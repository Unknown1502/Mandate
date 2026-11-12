import { NextResponse } from "next/server";
import { z } from "zod";
import { MONEY_RE, specCriterionSchema } from "@/agents/contracts";
import { errorResponse, parseBody, requirePrincipalMutation, requirePrincipalRead } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";
import { dealView } from "@/lib/views";

export const dynamic = "force-dynamic";

/** The principal-authored brief (V1 terms only: there is no `v2` key, and a strict schema refuses one). Neither agent can change it. */
const brief = z.strictObject({
  description: z.string().min(1).max(2000),
  criteria: z.array(specCriterionSchema).min(1).max(20),
  deadline: z.iso.datetime(),
  targetPrice: z.string().regex(MONEY_RE),
});
const body = z.strictObject({ mandateId: z.string().min(1).max(64), sellerId: z.string().min(1).max(64), brief });

/**
 * Open a deal under the session principal's own mandate and negotiate. Ownership of the mandate is verified inside createDeal (a foreign or missing mandate is a 404).
 * This route cannot create a PayPal order by itself beyond what the policy engine, the budget reservation and the settlement engine allow.
 */
export async function POST(req: Request) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  try {
    const rt = getRuntime();
    const out = await rt.orchestrator.openDeal({ principalId: auth.principal.principalId, mandateId: parsed.data.mandateId, sellerId: parsed.data.sellerId, brief: parsed.data.brief });
    return NextResponse.json({ dealId: out.dealId, negotiation: out.negotiation, advance: out.advance ?? null, buyerBrain: rt.info.buyerBrain }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(req: Request) {
  const auth = await requirePrincipalRead(req);
  if (!auth.ok) return auth.response;
  const rt = getRuntime();
  const rows = await rt.db.deal.findMany({ where: { mandate: { principalId: auth.principal.principalId } }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ deals: rows.map(dealView) });
}
