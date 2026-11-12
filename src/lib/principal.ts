/**
 * The authenticated-principal guard for every route that touches a mandate, a deal or a payment operation.
 *
 * The principal is derived ONLY from the signed server-side session (HMAC cookie) and then re-checked against the database: a request can never name its own
 * principal, owner or actor. Order of checks for a mutation: same Origin (403) -> valid session (401) -> CSRF token (403) -> the session's user exists with that
 * email (401) -> per-principal rate limit (429). Nothing after this guard (runtime, database writes, PayPal) runs for a request that fails it.
 */
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { prisma } from "@/db/client";
import { ForbiddenError, StaleStateError } from "@/domain/deals";
import { ConfirmationMismatchError, NotFoundError } from "@/domain/mandates";
import { requireAuthenticated, requireAuthenticatedMutation } from "./auth";
import { createRateLimiter, readJsonBounded } from "./http-guard";
import type { SessionPayload } from "./session";

export interface Principal {
  principalId: string;
  email: string;
}
export type PrincipalResult = { ok: true; principal: Principal } | { ok: false; response: NextResponse };

const perPrincipal = createRateLimiter({ limit: 60, windowMs: 60_000 });

export const notFound = () => NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
const unauthenticated = () => NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

async function resolve(session: SessionPayload): Promise<PrincipalResult> {
  const user = await prisma.user.findUnique({ where: { id: session.uid } });
  if (!user || user.email.toLowerCase() !== session.email.toLowerCase()) return { ok: false, response: unauthenticated() };
  return { ok: true, principal: { principalId: user.id, email: user.email } };
}

/** For POST/PUT/PATCH/DELETE: origin + session + CSRF + known user + rate limit. */
export async function requirePrincipalMutation(req: Request): Promise<PrincipalResult> {
  const a = requireAuthenticatedMutation(req);
  if (!a.ok) return a;
  const who = await resolve(a.session);
  if (!who.ok) return who;
  if (!perPrincipal.take(who.principal.principalId)) {
    return { ok: false, response: NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(Math.max(perPrincipal.retryAfterSeconds(who.principal.principalId), 1)) } }) };
  }
  return who;
}

/** For GET: session + known user (no CSRF token is needed for a read; the response is never cached). */
export async function requirePrincipalRead(req: Request): Promise<PrincipalResult> {
  const a = requireAuthenticated(req);
  if (!a.ok) return a;
  return resolve(a.session);
}

/** Bounded, strict-JSON, schema-validated request body. A schema must be strict: an unknown key (for example a principalId) is a 400. */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>, maxBytes = 16_384): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const raw = await readJsonBounded(req, maxBytes);
  if (!raw.ok) return { ok: false, response: NextResponse.json({ error: raw.code === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST" }, { status: raw.code === "BODY_TOO_LARGE" ? 413 : 400 }) };
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, response: NextResponse.json({ error: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 }) };
  return { ok: true, data: parsed.data };
}

/** Map a domain error to a response that reveals no internals. A foreign object and a missing one are both a plain 404. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof NotFoundError) return notFound();
  if (e instanceof ZodError) return NextResponse.json({ error: "BAD_REQUEST", issues: e.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  if (e instanceof ConfirmationMismatchError) return NextResponse.json({ error: "DIGEST_MISMATCH" }, { status: 409 });
  if (e instanceof ForbiddenError) return NextResponse.json({ error: "MANDATE_NOT_USABLE" }, { status: 409 });
  if (e instanceof StaleStateError) return NextResponse.json({ error: "STALE_STATE" }, { status: 409 });
  if (e instanceof Error && /expiry must be in the future/i.test(e.message)) return NextResponse.json({ error: "MANDATE_EXPIRY_IN_PAST" }, { status: 400 });
  if (e instanceof Error && /^Invalid money string/.test(e.message)) return NextResponse.json({ error: "BAD_REQUEST", issues: [{ path: "amount", message: "invalid money amount" }] }, { status: 400 });
  // server-side log only (name and message, never the request); the client gets no detail
  console.error("[api] unhandled error:", e instanceof Error ? `${e.name}: ${e.message}` : "non-error value");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

/** The deal if (and only if) it belongs to the principal. */
export async function ownedDeal(principal: Principal, dealId: string) {
  return prisma.deal.findFirst({ where: { id: dealId, mandate: { principalId: principal.principalId } } });
}
