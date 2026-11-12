# 3. PayPal Integration Contract

**[VERIFIED 5 Nov 2026]** = checked against PayPal docs while writing this pack.
**[CONFIRM IN SANDBOX]** = expected behavior; verify with a real response and record it in `docs/sandbox-observations.md`.

## 3.1 Sandbox accounts
Create **US** Business (seller) and **US** Personal (buyer) sandbox accounts. Country-specific feature restrictions can affect account types; US removes that variable. **[CONFIRM IN SANDBOX]** One REST app on the Business account; credentials server-side only.

## 3.2 OAuth
`POST {base}/v1/oauth2/token`, Basic auth, `grant_type=client_credentials`. Cache the token in memory until shortly before expiry. Failure => typed error, no state change.

## 3.3 Create order (AUTHORIZE)
`POST /v2/checkout/orders` with `intent: "AUTHORIZE"` and header `PayPal-Request-Id: <dealId>-order`. **[VERIFIED]** `intent: AUTHORIZE` is the documented way to reserve funds.
Body shape: `purchase_units[0] = { reference_id: dealId, custom_id: dealId, description: "Mandate deal <dealId> terms:<termsHash first 12>", amount: { currency_code: "USD", value: "<price>" } }` plus `payment_source.paypal.experience_context` (`return_url`, `cancel_url`, user action). **[CONFIRM IN SANDBOX]** exact experience_context fields and the HATEOAS link `rel` for buyer approval (`payer-action` vs `approve`).
Human opens the link, logs in as the sandbox Personal buyer, approves, returns to `return_url`.

## 3.4 Authorize
`POST /v2/checkout/orders/{id}/authorize` after approval. **[VERIFIED]** The authorization ID is at `purchase_units[0].payments.authorizations[0].id` — store it immediately. The hold is valid **29 days**; PayPal recommends capture within the **3-day honor period**; capture success is subject to risk and availability of funds. **[VERIFIED]**

## 3.5 Capture / partial capture
`POST /v2/payments/authorizations/{authId}/capture`, body `{ amount: {currency_code, value}, final_capture: true, invoice_id: dealId }`, header `PayPal-Request-Id: <dealId>-capture`.
- Partial capture is supported: PayPal's docs test table shows authorize $100, capture $60 => $60 captured, $40 remains available. **[VERIFIED]**
- `final_capture: true` = no further captures against that authorization (remainder released); `false` = more captures may follow. Mandate uses `true` on every settlement capture. **[CONFIRM IN SANDBOX]** remainder release + resulting authorization status.
- **Partial capture may need to be enabled on the merchant account** (reported by an external review citing PayPal docs; not independently confirmed by me). Phase 1 must check this first, before any settlement code. If it cannot be enabled, redesign: settle full-or-void only and drop partial capture from the demo.
- A capture can return `PENDING`/`DECLINED`. Only `COMPLETED` (confirmed by fresh GET) counts as captured; see state `SETTLEMENT_PENDING`.
- PayPal docs describe capturing above the authorized amount (up to 115%). **Mandate never does this.** Hard cap = locked price.

## 3.6 Void
`POST /v2/payments/authorizations/{authId}/void`. **[VERIFIED endpoint exists]** **[CONFIRM IN SANDBOX]** success status (expected 204) and subsequent GET status.

## 3.7 Reauthorize (P1)
Allowed after the 3-day honor period and within 29 days; creates a **new authorization ID** with a new 3-day honor period; later captures use the new ID. **[VERIFIED]** If implemented, add state `REAUTH_NEEDED`. Otherwise keep deal deadlines short.

## 3.8 Disputes (correction)
Buyers open disputes; integrations list, read, accept, and respond with evidence. Mandate therefore does **not** open disputes. For post-capture problems it emits `DISPUTE_PREPARED`: an evidence package (terms, criteria results, ledger export) for the human. Use Agent Toolkit `list_disputes` for a dashboard panel. **[VERIFIED tool exists]**

## 3.9 Agent Toolkit / MCP — be precise
Toolkit tools seen in its repo/docs **[VERIFIED]**: `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`, `list_disputes`, `get_dispute`, `list_transactions`, invoices, subscriptions, shipment tracking. No dedicated authorize / capture-authorization / void tool appears in that list, so:
- **Writes** (create AUTHORIZE order, authorize, capture, void) => direct REST in `paypal/`.
- **Reads** (`get_order`, `list_transactions`, `list_disputes`) => `@paypal/agent-toolkit` (Vercel AI SDK flavor, or MCP via `npx @paypal/mcp`), used by the Buyer agent/dashboard for status checks.
State exactly this split in the README. Do not claim the toolkit performs authorize/capture/void.

## 3.10 Webhooks
Subscribe (PayPal's event-names page lists both `DECLINED` and `DENIED`; Payments v2 declined captures emit `DECLINED`, while some order-flow guides still reference `DENIED` — subscribe to **both** and always reconcile with a fresh GET): `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. **[VERIFIED 5 Nov 2026 that DECLINED and DENIED both exist]**. Events are delivered only for the REST app that created the transactions. PayPal retries failed deliveries (reported: up to 25 attempts over 3 days — confirm), so **persist the verified event before returning 2xx**.
`POST /api/webhooks/paypal`:
1. Verify via PayPal's verify-webhook-signature endpoint with `PAYPAL_WEBHOOK_ID`; reject invalid.
2. Dedupe by event `id` (unique constraint).
3. Find the deal via `custom_id`/resource links; **GET the resource fresh** and reconcile; never trust the event body alone.
4. Append ledger event; return 2xx quickly; processing idempotent.
Simulator/mock events are not tied to your app and cannot be verified by postback; use them for route testing only. Prove the real chain with a real sandbox payment.

## 3.10b Crash-safe PayPal writes (PayPalOperation)
Before every PayPal write: insert a `PayPalOperation` row `{dealId, type, requestId (stable, deterministic: `<dealId>:<type>:<n>`), requestBodyHash, status: PLANNED}` **in the same DB transaction as the intent**. Then call PayPal with that `PayPal-Request-Id`; then mark `SENT` -> `CONFIRMED` (after fresh GET) or `FAILED`. On restart/timeout, a reconciler finds `PLANNED/SENT` operations and **GETs the PayPal resource first**; it re-sends only with the *same* request id, and never creates a new capture request for an operation that may have succeeded. PayPal documents idempotency via `PayPal-Request-Id` (reported retention up to 45 days — confirm). Never blind-retry a capture.

## 3.11 Error normalization
`PAYPAL_AUTH_FAILED, PAYPAL_VALIDATION, PAYPAL_NOT_FOUND, PAYPAL_RATE_LIMITED, PAYPAL_UNAVAILABLE, PAYPAL_TIMEOUT, PAYPAL_DECLINED_CAPTURE, PAYPAL_UNKNOWN`. Record debug_id, endpoint, status, duration. Errors never imply an outcome: a failed capture leaves the deal in `NEEDS_HUMAN` with the authorization intact (retry capture or void).

## 3.12 Spike checklist (Phase 1) — record every real response
1. Token. 2. Create AUTHORIZE order, get approval link. 3. Approve as buyer, authorize, store auth ID. 4. Full capture. 5. Partial capture with `final_capture: true`; GET authorization status. 6. Void. 7. Repeat capture with same `PayPal-Request-Id` (idempotency). 8. Capture after void (error shape). 9. Register webhook, receive a real event, verify signature. 10. Note exact status strings and response shapes.
