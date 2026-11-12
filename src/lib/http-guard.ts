/**
 * HTTP request guards (P5): bounded body reading and a sliding-window rate limiter. PURE apart from the injected clock: no database, no network.
 *
 * The rate limiter is PER PROCESS (an in-memory map): it bounds a single instance and is NOT a distributed limit. A multi-instance deployment needs a shared store;
 * that is documented as a residual risk, not claimed here. Keys are caller-chosen (for example a hashed client address); the map is size-capped so it cannot be used to
 * exhaust memory.
 */

import { parseStrictJson } from "./strict-json";

export class BodyTooLargeError extends Error {}

/** Read a JSON request body without ever buffering more than `maxBytes`. A missing, oversized or malformed body is a typed failure. */
export async function readJsonBounded(req: Request, maxBytes = 8_192): Promise<{ ok: true; value: unknown } | { ok: false; code: "BODY_TOO_LARGE" | "BODY_INVALID" }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: "BODY_TOO_LARGE" };
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, code: "BODY_INVALID" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, code: "BODY_TOO_LARGE" };
    }
    chunks.push(value);
  }
  // strict parser: duplicate keys, __proto__ and over-deep documents are refused here, not discovered later
  const parsed = parseStrictJson(Buffer.concat(chunks).toString("utf8"), { maxBytes });
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, code: "BODY_INVALID" };
}

export interface RateLimiter {
  /** true = allowed (and counted); false = over the limit */
  take(key: string): boolean;
  /** seconds until the oldest counted request leaves the window (for Retry-After) */
  retryAfterSeconds(key: string): number;
}

export function createRateLimiter(o: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const now = o.now ?? Date.now;
  const maxKeys = o.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => {
    const arr = (hits.get(key) ?? []).filter((x) => t - x < o.windowMs);
    if (arr.length === 0) hits.delete(key);
    else hits.set(key, arr);
    return arr;
  };
  return {
    take(key) {
      const t = now();
      const arr = live(key, t);
      if (arr.length >= o.limit) return false;
      if (!hits.has(key) && hits.size >= maxKeys) {
        // under key-flooding pressure, evict the oldest key rather than grow without bound
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      arr.push(t);
      hits.set(key, arr);
      return true;
    },
    retryAfterSeconds(key) {
      const t = now();
      const arr = live(key, t);
      return arr.length === 0 ? 0 : Math.max(1, Math.ceil((arr[0]! + o.windowMs - t) / 1000));
    },
  };
}
