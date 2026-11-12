/**
 * The orchestrator's only channel to the Seller Agent: one fixed, pre-configured URL (no arbitrary hosts), JSON in/out,
 * bounded size and time. It returns UNKNOWN data; the caller must parse it with sellerResponseSchema.
 */
import type { DeliverRequest, NegotiateRequest } from "./contracts";

export interface SellerClient {
  negotiate(req: NegotiateRequest): Promise<{ ok: true; body: unknown } | { ok: false; error: string }>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DELIVERY_RESPONSE_BYTES = 256 * 1024;

export type SellerCallResult = { ok: true; body: unknown } | { ok: false; error: string };

/** The simulated seller's delivery endpoint (demo). Returns UNKNOWN data; the caller must parse it with deliverResponseSchema. */
export interface SellerDelivery {
  deliver(req: DeliverRequest): Promise<SellerCallResult>;
}

export class HttpSellerClient implements SellerClient, SellerDelivery {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly opts: { timeoutMs?: number; allowedHosts?: string[] } = {}) {
    const u = new URL(baseUrl);
    const allowed = new Set(["127.0.0.1", "localhost", ...(opts.allowedHosts ?? [])]);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Seller URL must be http(s)");
    if (!allowed.has(u.hostname)) throw new Error(`Seller host ${u.hostname} is not on the allow-list`);
    this.base = u;
  }

  negotiate(req: NegotiateRequest) {
    return this.post("/negotiate", req);
  }

  deliver(req: DeliverRequest) {
    return this.post("/deliver", req);
  }

  private async post(path: "/negotiate" | "/deliver", req: unknown): Promise<SellerCallResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(new URL(path, this.base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: ac.signal });
      const text = await res.text();
      if (text.length > (path === "/deliver" ? MAX_DELIVERY_RESPONSE_BYTES : MAX_RESPONSE_BYTES)) return { ok: false as const, error: "SELLER_RESPONSE_TOO_LARGE" };
      if (!res.ok) return { ok: false as const, error: `SELLER_HTTP_${res.status}` };
      try {
        return { ok: true as const, body: JSON.parse(text) as unknown };
      } catch {
        return { ok: false as const, error: "SELLER_RESPONSE_NOT_JSON" };
      }
    } catch {
      return { ok: false as const, error: ac.signal.aborted ? "SELLER_TIMEOUT" : "SELLER_UNREACHABLE" };
    } finally {
      clearTimeout(timer);
    }
  }
}
