# Sources

## Checked 5 Nov 2026 while writing this pack
- PayPal "Authorize a payment and capture funds later" / "Authorization and capture" docs: intent AUTHORIZE; hold valid 29 days; capture recommended within 3-day honor period; capture subject to risk/fund availability; reauthorize creates new auth ID and new honor period; partial capture example; authorization ID path `purchase_units[0].payments.authorizations[0].id`; void and reauthorize endpoints.
  - https://developer.paypal.com/docs/checkout/standard/customize/authorization
  - https://docs.paypal.ai/payments/methods/paypal/delayed-capture
  - https://developer.paypal.com/studio/checkout/standard/customize/authorization
- PayPal Agent Toolkit tool list (orders, invoices, disputes, transactions, etc.):
  - https://github.com/paypal/agent-toolkit/
  - https://developer.paypal.com/tools/agent-toolkit

## NOT verified (confirm yourself)
Exact request/response fields for create-order `experience_context`, approval link `rel`, void success code, webhook event names, verify-webhook-signature request shape, Disputes API sandbox flow, `final_capture` remainder behavior, `PayPal-Request-Id` idempotency windows, any behavior differences between sandbox and production.

Start from: https://developer.paypal.com/api/rest/ and https://docs.paypal.ai/
