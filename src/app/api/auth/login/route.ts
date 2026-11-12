import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createRateLimiter, readJsonBounded } from "@/lib/http-guard";
import { SESSION_COOKIE, createSession, safeEqual, sessionTtlSeconds, verifyOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";

const body = z.object({ email: z.email(), secret: z.string().min(1).max(256) });

// P5: per-process limits (NOT a distributed limit): a few attempts per client per minute and a global ceiling, counted before any credential is compared.
const perClient = createRateLimiter({ limit: 5, windowMs: 60_000 });
const globalLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const clientKey = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown").slice(0, 64);

/**
 * Phase 0 placeholder login: a single principal configured via env (hackathon scope).
 * Not a production identity system.
 */
export async function POST(req: Request) {
  const env = getEnv();
  if (!verifyOrigin(req.headers.get("origin"), env.APP_URL)) {
    return NextResponse.json({ error: "BAD_ORIGIN" }, { status: 403 });
  }
  const key = clientKey(req);
  if (!globalLimiter.take("*") || !perClient.take(key)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(Math.max(perClient.retryAfterSeconds(key), globalLimiter.retryAfterSeconds("*"), 1)) } });
  }
  const raw = await readJsonBounded(req, 4_096);
  if (!raw.ok) return NextResponse.json({ error: raw.code === "BODY_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST" }, { status: raw.code === "BODY_TOO_LARGE" ? 413 : 400 });
  const parsed = body.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });

  // Evaluate both comparisons unconditionally so neither short-circuits.
  const emailOk = safeEqual(parsed.data.email.toLowerCase(), env.PRINCIPAL_EMAIL.toLowerCase());
  const secretOk = safeEqual(parsed.data.secret, env.PRINCIPAL_LOGIN_SECRET);
  if (!(emailOk && secretOk)) return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });

  const email = env.PRINCIPAL_EMAIL.toLowerCase();
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
  const { token, payload } = createSession(user, env.SESSION_SECRET);
  const res = NextResponse.json({ ok: true, csrfToken: payload.csrf });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionTtlSeconds,
  });
  return res;
}
