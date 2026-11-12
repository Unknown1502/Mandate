import { NextResponse } from "next/server";
import { getEnv } from "./env";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  verifyCsrf,
  verifyOrigin,
  verifySession,
  type SessionPayload,
} from "./session";

export type AuthResult = { ok: true; session: SessionPayload } | { ok: false; response: NextResponse };

function readSession(req: Request): SessionPayload | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const token = match ? match.slice(SESSION_COOKIE.length + 1) : undefined;
  return verifySession(token, getEnv().SESSION_SECRET);
}

/**
 * Guard for every state-changing route: authenticated session + same Origin + CSRF token.
 * Returns a ready-made error response on failure; no state may change before ok === true.
 */
export function requireAuthenticatedMutation(req: Request): AuthResult {
  const env = getEnv();
  if (!verifyOrigin(req.headers.get("origin"), env.APP_URL)) {
    return { ok: false, response: NextResponse.json({ error: "BAD_ORIGIN" }, { status: 403 }) };
  }
  const session = readSession(req);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  if (!verifyCsrf(session, req.headers.get(CSRF_HEADER))) {
    return { ok: false, response: NextResponse.json({ error: "BAD_CSRF" }, { status: 403 }) };
  }
  return { ok: true, session };
}

/** Guard for authenticated reads (no CSRF needed). */
export function requireAuthenticated(req: Request): AuthResult {
  const session = readSession(req);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  return { ok: true, session };
}
