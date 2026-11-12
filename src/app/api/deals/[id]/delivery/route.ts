import { NextResponse } from "next/server";
import { z } from "zod";
import { DELIVERY_QUALITIES, deliverResponseSchema, type SpecCriterion } from "@/agents/contracts";
import { readLockedTerms } from "@/domain/terms-v2";
import { errorResponse, notFound, ownedDeal, parseBody, requirePrincipalMutation } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const body = z.strictObject({ quality: z.enum(DELIVERY_QUALITIES) });

/**
 * DEMO: ask the local SELLER SIMULATOR to deliver. The artifact and the manifest are produced by the simulator process (synthetic data); the caller only chooses how the
 * simulator behaves. The request carries no artifact, no seller identity and no principal: the delivery is attributed to the deal's own seller, and the existing intake
 * (strict manifest, terms-hash binding, size/hash checks, immutability) and the deterministic verification decide what happens next. The seller cannot approve or pay.
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
  if (!rt.sellerDelivery) return NextResponse.json({ error: "SELLER_NOT_CONFIGURED" }, { status: 409 });
  if (deal.state !== "AWAITING_DELIVERY" || !deal.termsHash) return NextResponse.json({ error: "NOT_AWAITING_DELIVERY", state: deal.state }, { status: 409 });
  const lt = readLockedTerms(deal.termsJson);
  if (!lt.ok || lt.version !== 1) return NextResponse.json({ error: "TERMS_NOT_READABLE" }, { status: 409 });
  const criteria: SpecCriterion[] = lt.terms.criteria.map((c) => ({ id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight, ...("validator" in c && c.validator ? { validator: c.validator } : {}), ...("params" in c && c.params ? { params: c.params as Record<string, unknown> } : {}) }));
  try {
    const sent = await rt.sellerDelivery.deliver({ dealId: deal.id, termsHash: deal.termsHash, criteria, quality: parsed.data.quality });
    if (!sent.ok) return NextResponse.json({ error: "SELLER_UNAVAILABLE", detail: sent.error }, { status: 502 });
    const out = deliverResponseSchema.safeParse(sent.body);
    if (!out.success) return NextResponse.json({ error: "SELLER_RESPONSE_INVALID" }, { status: 502 });
    const result = await rt.orchestrator.receiveDelivery({ dealId: deal.id, authenticatedSellerId: deal.sellerId, manifest: out.data.manifest, artifact: Buffer.from(out.data.artifactText, "utf8") });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
