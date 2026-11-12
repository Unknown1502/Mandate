# MANDATE: the real PayPal Sandbox transaction (evidence timeline)

Written for: hackathon judges and reviewers who want to verify what MANDATE actually did with the PayPal Developer Platform.

**What this is.** One real transaction on the **PayPal Sandbox** (test money, no real funds), made through real PayPal REST APIs (Orders v2 and Payments v2) with the official **PayPal Server SDK**. The buyer approved on **PayPal's hosted Sandbox approval page** for the order. (The app also contains a **PayPal JavaScript SDK v6** checkout button; it is covered by tests against fakes, and it was deliberately *not* used for this real transaction because its approval callback triggers the server-side authorization, which needed its own approval step.) It was run in five separately approved stages, each guarded by a network-level allow-list that refused any request outside the approved list before it was sent.

**What it is not.**
* Not production money. Production is not enabled and is a documented NO-GO.
* Not a continuous run with the Groq negotiation. The Buyer Agent for this deal was the **rule-based** buyer (the transcript says "rule-based (no AI)"). The live Groq negotiations are separate, earlier runs against a mock-PayPal throwaway database (see `GROQ-EVIDENCE.md`).
* The seller is a **local simulator** with synthetic data, not an external merchant.
* **No explicit buyer acceptance event was recorded.** Payment followed the engine's expired-window rule: verification passed, the buyer's challenge window ended without a review request, and the deterministic settlement decision was a full capture. The dashboard states this in plain words ("Paid under the expired-window rule ... No explicit acceptance was recorded for this deal").
* Not escrow. PayPal authorized (held) the funds; the capture was a separate, later, deterministic decision.

## The identifiers

| Item | Value |
|---|---|
| PayPal order | `4YJ97804H20584006` (intent `AUTHORIZE`, 20.00 USD) |
| PayPal authorization | `19070882T8512554U` (expires 2026-12-08T21:01:21Z) |
| PayPal capture | `02U8827748683101W` (status `COMPLETED`, `final_capture: true`) |
| Amount / currency | 20.00 USD |
| Seller receivable | gross 20.00, PayPal fee 1.19, net 18.81 USD (as reported by PayPal) |
| Local deal | `cmw9owm800004vfoshymk7yir` (reference id and custom id on the order) |
| Capture `invoice_id` | `cmw9owm800004vfoshymk7yir-settle-1` |
| Capture `PayPal-Request-Id` | `cmw9owm800004vfoshymk7yir-CAPTURE-1` (stable idempotency key) |

## Timeline (all times UTC)

| # | When | Step | What PayPal confirmed | Evidence file |
|---|---|---|---|---|
| 1 | 2026-11-09 20:04 | **Buyer authority and locked agreement.** The signed mandate (budget 100.00, per-deal cap 60.00) and the locked terms (20.00 for cleaning a synthetic CSV, three criteria) exist before any PayPal call. The order is bound to the deal id and the locked price. | n/a (local records) | `docs/qa/paypal-e2e-stage1-20261109200433.json` |
| 2 | 2026-11-09 20:04 | **Order created** with Orders v2 (`POST /v2/checkout/orders`, intent `AUTHORIZE`), then read back: `PAYER_ACTION_REQUIRED`, 20.00 USD, bound to the deal. 3 requests (token, create, read), debug ids `f481148d44473`, `f6723441a617d`. | order exists, nothing authorized | same |
| 3 | 2026-11-09 20:10 | **Buyer approved checkout** on PayPal's hosted Sandbox approval page (opened in a clean browser window) with a dedicated Sandbox buyer account. The app learned this only by reading the order from PayPal (a fresh GET), never from the redirect: status `APPROVED`, payee and payer as expected, no authorization or capture on the order. 2 requests. | order `APPROVED` | `docs/qa/paypal-e2e-stage2-20261109201059.json` |
| 4 | 2026-11-09 21:01 | **Authorization created** (`POST /v2/checkout/orders/{id}/authorize`). Authorization `19070882T8512554U`, status `CREATED`, 20.00 USD: a hold, not a payment. 5 requests; authorize debug id `f8392841931ae`. | authorization `CREATED` | `docs/qa/paypal-e2e-stage3-20261109210116.json` |
| 5 | 2026-11-09 21:09 | **Delivery verification passed.** The seller simulator delivered `cleaned.csv`; deterministic validators (columns, duplicates, dates) all passed; `ALL_REQUIRED_PASSED`, no model call, no flags. 0 PayPal requests. | n/a (no capture yet) | `docs/qa/paypal-e2e-stage4-20261109210955.json` |
| 6 | 2026-11-09 22:09 | **Challenge window expired** with no review request. No acceptance event exists. | n/a | same (window end) |
| 7 | 2026-11-10 08:18 | **PayPal captured exactly 20.00 USD** (`POST /v2/payments/authorizations/{id}/capture`, `final_capture: true`), `201`, debug id `f47355289abf3`. The engine first re-read the authorization twice (`CREATED`, 20.00 USD, unexpired). | capture `COMPLETED` | `docs/qa/paypal-e2e-stage5-20261110081759.json` |
| 8 | 2026-11-10 08:18 | **Provider reconciliation.** Capture read-back `COMPLETED` (debug id `f493703014924`); authorization read-back `CAPTURED` (debug id `f83741925e7de`). The local deal moved `VERIFYING` to `CAPTURED`. | authorization `CAPTURED` | same |

The capture stage sent exactly six requests (token, authorization GET, fresh authorization GET, capture POST, capture GET, authorization GET). The guard permitted exactly those six, one each, in that order; none was refused.

## Why this is more than "a PayPal call"

* **Authorize first, capture later.** Funds are held at authorization; the capture waits for evidence and a deterministic decision. Capture is impossible before eligible delivery verification (tested).
* **The decision is code, not a model.** The amount captured is computed from the locked terms and the verification result. No human input and no model output can carry an amount.
* **Idempotent and reconciled.** Every PayPal write is recorded locally before it is sent, carries a stable `PayPal-Request-Id`, and an unknown outcome is resolved by reading PayPal, never assumed. A database-level rule allows at most one live capture or void per deal.
* **The order is checked.** The order must carry this deal's id and locked price, or the app refuses to authorize.
* **Writes were locked.** Sandbox writes stay refused unless the operator sets `PAYPAL_SANDBOX_WRITES=authorized` for one process; it was set only for the single stage that needed it and never written to a file.

## How to check this yourself

1. Read the five sanitized evidence files above. They contain ids, statuses, amounts, debug ids, the exact allow-listed requests and the engine's local records. They contain no token, no client secret, no approval link and no password. (In the public repository, Sandbox buyer email addresses and the payer id are masked; the private working copy keeps the originals.)
2. Open the dashboard against the stored database: the PayPal card shows the order, the authorization (`CAPTURED`) and the capture ids and `COMPLETED`; the settlement card shows the basis. Screenshots: `docs/submission/screenshots/real-sandbox/`.
3. In the PayPal Sandbox dashboard of the business account, the transaction appears as a completed payment of 20.00 USD (the owner can show this live; a screenshot is not included in this repository).

## Known honest details

* The audit ledger shows one `PAYPAL_READ_FAILED` event during Stage 4. That is the engine trying a pre-decision authorization read while the demo app's outbound network block was active (the block refused it locally; nothing left the machine). It is visible on purpose.
* An earlier attempt with a first Sandbox application failed at checkout with `UNSUPPORTED_PAYEE_CURRENCY` (the application belonged to a region that could not receive USD). A new US Sandbox application was created; the abandoned database is archived and `paypal-e2e-stage1-20261109184543.json` records that attempt.
* Four earlier spike orders from a protocol-exploration script are untouched and were never authorized or captured.
* Not exercised against real PayPal: explicit buyer acceptance, partial capture, void, refund, webhooks. Those are covered by tests against fake SDK controllers and the in-memory mock only.
