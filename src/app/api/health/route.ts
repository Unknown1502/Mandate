import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { AUTHORIZATION_READERS } from "@/domain/compat";

export const dynamic = "force-dynamic";

/** Liveness + DB reachability + which authorization-document versions this build reads (P1 rollout check). Exposes no configuration or secrets. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok", mode: "sandbox-only", authorizationReaders: AUTHORIZATION_READERS });
  } catch {
    return NextResponse.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
