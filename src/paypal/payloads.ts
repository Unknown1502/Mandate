import { usd } from "./amount";

/** Deterministic request payloads for PayPal writes. Same inputs => byte-identical JSON. */

export function createOrderBody(a: {
  referenceId: string;
  description: string;
  amount: string;
  returnUrl: string;
  cancelUrl: string;
}) {
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: a.referenceId,
        custom_id: a.referenceId,
        description: a.description,
        amount: { currency_code: "USD", value: usd(a.amount) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: a.returnUrl,
          cancel_url: a.cancelUrl,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };
}

export function captureBody(a: { amount: string; finalCapture: boolean; invoiceId: string }) {
  return {
    amount: { currency_code: "USD", value: usd(a.amount) },
    final_capture: a.finalCapture,
    invoice_id: a.invoiceId,
  };
}
