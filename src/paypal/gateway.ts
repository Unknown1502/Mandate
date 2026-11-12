import { PayPalClient, type PayPalResponse } from "./client";
import { PayPalError, classifyHttpError, isDefinitiveRejection, type PayPalErrorCode } from "./errors";

/**
 * The Settlement Engine's only door to PayPal. Results are a closed union so the engine cannot confuse
 * "PayPal said no" (rejected: nothing happened) with "we do not know" (unknown: must reconcile by GET).
 */
export type GwResult =
  | { kind: "ok"; status: number; debugId?: string; body: unknown }
  | { kind: "rejected"; status: number; debugId?: string; code: PayPalErrorCode; body: unknown }
  | { kind: "unknown"; code: PayPalErrorCode; message: string; status?: number; debugId?: string };

export type WriteType = "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID" | "REAUTHORIZE";

export interface PayPalGateway {
  /** POST with a caller-supplied, stable PayPal-Request-Id. The same id MUST be reused for retries of the same operation. */
  write(type: WriteType, a: { requestId: string; path: string; body?: unknown; timeoutMs?: number }): Promise<GwResult>;
  getOrder(id: string): Promise<GwResult>;
  getAuthorization(id: string): Promise<GwResult>;
  getCapture(id: string): Promise<GwResult>;
}

function toResult(res: PayPalResponse): GwResult {
  if (res.ok) return { kind: "ok", status: res.status, debugId: res.debugId, body: res.body };
  if (isDefinitiveRejection(res.status)) {
    return { kind: "rejected", status: res.status, debugId: res.debugId, code: classifyHttpError(res.status, res.body), body: res.body };
  }
  // 429 / 5xx: PayPal may or may not have applied the write.
  return { kind: "unknown", code: classifyHttpError(res.status, res.body), message: `HTTP ${res.status}`, status: res.status, debugId: res.debugId };
}

/** Real Sandbox gateway. NOT exercised against Sandbox yet: its write paths are UNVERIFIED. */
export class RestPayPalGateway implements PayPalGateway {
  constructor(private readonly client: PayPalClient) {}

  private async run(f: () => Promise<PayPalResponse>): Promise<GwResult> {
    try {
      return toResult(await f());
    } catch (e) {
      if (e instanceof PayPalError) {
        // Only timeouts / network failures are ambiguous. Validation and auth failures are raised BEFORE anything is sent.
        if (e.code === "PAYPAL_TIMEOUT" || e.code === "PAYPAL_UNAVAILABLE") return { kind: "unknown", code: e.code, message: e.message };
        return { kind: "rejected", status: 0, code: e.code, body: { message: e.message } };
      }
      throw e;
    }
  }

  write(type: WriteType, a: { requestId: string; path: string; body?: unknown; timeoutMs?: number }): Promise<GwResult> {
    return this.run(() =>
      this.client.request({
        method: "POST",
        path: a.path,
        body: a.body,
        requestId: a.requestId,
        timeoutMs: a.timeoutMs,
        // Observed: create-order with return=representation answers 200 with the full order.
        prefer: type === "CREATE_ORDER" || type === "AUTHORIZE" || type === "CAPTURE" ? "return=representation" : undefined,
      }),
    );
  }
  getOrder(id: string) {
    return this.run(() => this.client.request({ method: "GET", path: `/v2/checkout/orders/${id}` }));
  }
  getAuthorization(id: string) {
    return this.run(() => this.client.request({ method: "GET", path: `/v2/payments/authorizations/${id}` }));
  }
  getCapture(id: string) {
    return this.run(() => this.client.request({ method: "GET", path: `/v2/payments/captures/${id}` }));
  }
}
