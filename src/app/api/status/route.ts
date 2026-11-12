import { NextResponse } from "next/server";
import { requirePrincipalRead } from "@/lib/principal";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** What is live and what is simulated in this server process, so the UI can label every integration truthfully. Authenticated; exposes no configuration values. */
export async function GET(req: Request) {
  const auth = await requirePrincipalRead(req);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ principal: auth.principal.email, ...getRuntime().info });
  } catch (e) {
    return NextResponse.json({ error: "NOT_CONFIGURED", detail: e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "runtime could not start" }, { status: 503 });
  }
}
