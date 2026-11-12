import { NextResponse } from "next/server";
import { z } from "zod";
import { approveMandate, openMandateRow } from "@/domain/mandates";
import { errorResponse, parseBody, requirePrincipalMutation, requirePrincipalRead } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";
import { mandateView } from "@/lib/views";

export const dynamic = "force-dynamic";

const body = z.strictObject({ draft: z.unknown(), confirmDigest: z.string().regex(/^[0-9a-f]{64}$/) });

/** Step 2: the human echoes the digest of the exact previewed document; only then is it sealed. The mandate belongs to the session's principal. */
export async function POST(req: Request) {
  const auth = await requirePrincipalMutation(req);
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(req, body);
  if (!parsed.ok) return parsed.response;
  try {
    const rt = getRuntime();
    const row = await approveMandate(rt.db, { principalId: auth.principal.principalId, principalEmail: auth.principal.email, draft: parsed.data.draft, confirmDigest: parsed.data.confirmDigest, keys: rt.keys });
    return NextResponse.json({ mandate: mandateView(row, openMandateRow(row, { publicKeyB64: rt.keys.publicKeyB64 }) !== null) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** The session principal's own mandates, each with a live seal check. */
export async function GET(req: Request) {
  const auth = await requirePrincipalRead(req);
  if (!auth.ok) return auth.response;
  const rt = getRuntime();
  const rows = await rt.db.mandate.findMany({ where: { principalId: auth.principal.principalId }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ mandates: rows.map((m) => mandateView(m, openMandateRow(m, { publicKeyB64: rt.keys.publicKeyB64 }) !== null)) });
}
