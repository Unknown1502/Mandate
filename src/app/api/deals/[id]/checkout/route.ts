import { NextResponse } from "next/server";
import { notFound, ownedDeal, requirePrincipalRead } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";
import { checkoutView } from "@/paypal/checkout";

export const dynamic = "force-dynamic";

/**
 * What the dashboard needs to show the buyer's PayPal Sandbox checkout button for THIS deal. Read-only: it creates, authorizes and captures nothing and calls PayPal never.
 * The principal comes from the session and must own the deal (a foreign or missing deal is a 404). Every value in the answer (order id, amount, currency) is read from the
 * server's own deal record; the browser sends nothing but the deal id in the path. The client id is PayPal's public browser identifier; the secret never leaves the server.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePrincipalRead(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const deal = await ownedDeal(auth.principal, id);
  if (!deal) return notFound();
  const rt = getRuntime();
  return NextResponse.json(
    checkoutView({
      mode: rt.info.paypal === "sandbox-live" ? "sandbox" : "mock",
      checkout: rt.checkout,
      sandboxWritesAuthorized: rt.info.sandboxWritesAuthorized,
      deal: { state: deal.state, paypalOrderId: deal.paypalOrderId, price: deal.price },
    }),
  );
}
