import { NextResponse } from "next/server";
import { z } from "zod";
import { previewMandate } from "@/domain/mandates";
import { errorResponse, parseBody, requirePrincipalMutation } from "@/lib/principal";

export const dynamic = "force-dynamic";

const body = z.strictObject({ draft: z.unknown() });

/** Step 1 of mandate approval: exactly what the human will be asked to confirm. The principal is the session's, never the request's. Pure: no database, no PayPal. */
export async function POST(req: Request) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  try {
    const { document, digest } = previewMandate(auth.principal.principalId, parsed.data.draft);
    return NextResponse.json({ document, digest });
  } catch (e) {
    return errorResponse(e);
  }
}
