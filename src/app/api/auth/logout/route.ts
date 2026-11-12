import { NextResponse } from "next/server";
import { requireAuthenticatedMutation } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = requireAuthenticatedMutation(req);
  if (!auth.ok) return auth.response;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
