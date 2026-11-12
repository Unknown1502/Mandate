Phase 1 — PayPal spike. Build only server-side scripts and the paypal/ client; no UI.

FIRST: confirm partial capture is enabled for the sandbox merchant account (try a partial capture on a test authorization; if rejected, report the exact error and how to enable it). Also record what `final_capture` true/false does to the unused authorization amount.

Implement and run against Sandbox (credentials from .env.local):
1. OAuth token client with in-memory cache and expiry margin.
2. createAuthorizeOrder(dealId, amount): POST /v2/checkout/orders with intent AUTHORIZE, header PayPal-Request-Id, custom_id/reference_id = dealId. Print the buyer approval link (note its `rel`).
3. After I approve in the sandbox buyer account, authorizeOrder(orderId); extract and print the authorization id from purchase_units[0].payments.authorizations[0].id.
4. captureAuthorization(authId, amount, finalCapture) with PayPal-Request-Id; getAuthorization(authId); voidAuthorization(authId).
5. Scenarios (run each on a fresh order): full capture; partial capture with final_capture true then GET authorization; void; repeat capture with same request id; capture after void.
6. Normalize errors into the typed set in docs/03 §3.11; log endpoint, status, debug_id, request id, duration — never tokens.
7. Write every real response (secrets redacted) to docs/sandbox-observations.md with the exact status strings and codes.

Exit gate: real IDs for one full capture, one partial capture (remainder behavior documented), one void, and idempotent repeat. Report what differs from docs/03 and update docs/03 accordingly. Do not proceed to Phase 2.
