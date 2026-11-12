/** Typed error set from docs/03 §3.11. Errors never imply a financial outcome. */
export type PayPalErrorCode =
  | "PAYPAL_AUTH_FAILED"
  | "PAYPAL_VALIDATION"
  | "PAYPAL_NOT_FOUND"
  | "PAYPAL_RATE_LIMITED"
  | "PAYPAL_UNAVAILABLE"
  | "PAYPAL_TIMEOUT"
  | "PAYPAL_DECLINED_CAPTURE"
  | "PAYPAL_UNKNOWN";

export class PayPalError extends Error {
  constructor(
    public readonly code: PayPalErrorCode,
    message: string,
    public readonly details: { status?: number; debugId?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

function issuesOf(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const details = (body as { details?: unknown }).details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((d) =>
    typeof d === "object" && d !== null && typeof (d as { issue?: unknown }).issue === "string"
      ? [(d as { issue: string }).issue]
      : [],
  );
}

/**
 * Map an HTTP error response to the typed set. The DECLINED heuristic (422 + an issue
 * containing "DECLINED") is an ASSUMPTION to be checked against captured Sandbox errors.
 */
export function classifyHttpError(status: number, body: unknown): PayPalErrorCode {
  if (status === 401 || status === 403) return "PAYPAL_AUTH_FAILED";
  if (status === 404) return "PAYPAL_NOT_FOUND";
  if (status === 429) return "PAYPAL_RATE_LIMITED";
  if (status >= 500) return "PAYPAL_UNAVAILABLE";
  if (status === 400 || status === 422 || status === 409) {
    return issuesOf(body).some((i) => i.includes("DECLINED")) ? "PAYPAL_DECLINED_CAPTURE" : "PAYPAL_VALIDATION";
  }
  return "PAYPAL_UNKNOWN";
}

/** True when the HTTP status proves PayPal did NOT apply the write (safe to treat as failed). */
export function isDefinitiveRejection(status: number): boolean {
  return [400, 401, 403, 404, 409, 422].includes(status);
}
