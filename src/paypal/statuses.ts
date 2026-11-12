/**
 * PayPal status strings the engine relies on. Source column matters:
 *  OBSERVED  = seen in a real Sandbox response (docs/sandbox-observations.md)
 *  DOCUMENTED = from PayPal's public API reference, NOT yet observed in Sandbox (UNVERIFIED until Gate 9)
 * The engine fails closed on any other string.
 */
export const ORDER_STATUS = {
  PAYER_ACTION_REQUIRED: "PAYER_ACTION_REQUIRED", // OBSERVED (create order response)
  CREATED: "CREATED", // DOCUMENTED
  APPROVED: "APPROVED", // DOCUMENTED
} as const;

export const AUTH_STATUS = {
  CREATED: "CREATED", // DOCUMENTED: usable authorization
  VOIDED: "VOIDED", // DOCUMENTED
  CAPTURED: "CAPTURED", // DOCUMENTED
  PARTIALLY_CAPTURED: "PARTIALLY_CAPTURED", // DOCUMENTED
} as const;

export const CAPTURE_STATUS = {
  COMPLETED: "COMPLETED", // DOCUMENTED
  PENDING: "PENDING", // DOCUMENTED
  DECLINED: "DECLINED", // DOCUMENTED
  FAILED: "FAILED", // DOCUMENTED
} as const;
