import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { parseStrictJson } from "./strict-json";

export const SESSION_COOKIE = "mandate_session";
export const CSRF_HEADER = "x-csrf-token";
export const sessionTtlSeconds = 8 * 60 * 60;

export interface SessionPayload {
  uid: string;
  email: string;
  exp: number; // unix seconds
  csrf: string;
}

/** STRICT: exactly these four fields (P1). A token carrying anything else is refused, not trimmed. */
const sessionPayloadSchema = z.strictObject({ uid: z.string(), email: z.string(), exp: z.number(), csrf: z.string() });

const b64u = (b: Buffer) => b.toString("base64url");

function sign(body: string, secret: string): string {
  return b64u(createHmac("sha256", secret).update(body).digest());
}

/** Constant-time equality for arbitrary-length strings. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createSession(
  user: { id: string; email: string },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = {
    uid: user.id,
    email: user.email,
    exp: nowSeconds + sessionTtlSeconds,
    csrf: b64u(randomBytes(32)),
  };
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  return { token: `${body}.${sign(body, secret)}`, payload };
}

export function verifySession(
  token: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!safeEqual(sig, sign(body, secret))) return null;
  try {
    // P1: the token body is authorization-bearing. Strict JSON (no duplicate keys) and a strict schema (no unknown or missing key, no cast).
    const json = parseStrictJson(Buffer.from(body, "base64url").toString("utf8"));
    if (!json.ok) return null;
    const checked = sessionPayloadSchema.safeParse(json.value);
    if (!checked.success || checked.data.exp <= nowSeconds) return null;
    return checked.data;
  } catch {
    return null;
  }
}

/** Synchronizer-token CSRF check: header must equal the token bound to the session. */
export function verifyCsrf(session: SessionPayload, headerValue: string | null | undefined): boolean {
  return typeof headerValue === "string" && headerValue.length > 0 && safeEqual(headerValue, session.csrf);
}

/** Same-origin check on the Origin header for state-changing requests. Missing Origin is rejected. */
export function verifyOrigin(originHeader: string | null | undefined, appUrl: string): boolean {
  if (!originHeader) return false;
  try {
    return new URL(originHeader).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
