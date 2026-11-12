import { NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Returns the principal and the CSRF token bound to the current session. */
export async function GET(req: Request) {
  const auth = requireAuthenticated(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ email: auth.session.email, csrfToken: auth.session.csrf });
}
