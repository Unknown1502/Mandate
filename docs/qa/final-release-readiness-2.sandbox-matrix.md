# PayPal Sandbox transaction test matrix — PROPOSAL (awaiting the owner's approval)

Run label: `final-release-readiness-2`. **Status: PROPOSED. No order has been created and no PayPal state-changing call has been made.** Nothing below may be executed
until the owner (a) approves this matrix and names the dedicated accounts, and (b) separately approves each buyer approval / authorization / capture / void / refund
(order id, accounts, amount, operation) — see §5.

Written for: the project owner, who must approve or amend it.

## 1. Read-only configuration facts (verified, no PayPal call made)

| Check | Evidence |
|---|---|
| Mode | `PAYPAL_ENV=sandbox` in `.env.local`; the env schema (`src/lib/env.ts`) accepts only the literal `sandbox` |
| API base | `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`; the schema accepts only that exact literal, so a production endpoint cannot load |
| Credentials | `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` are set (values not read into this report). **Which Sandbox business account owns this REST app, and whether a dedicated buyer account exists, is NOT verified** — verifying it needs either the owner's statement or a read-only API/dashboard check the owner approves |
| Webhook | `PAYPAL_WEBHOOK_ID` is present in configuration, but no webhook route is implemented (see Stage F); webhook cases are therefore out of this matrix |
| Account aliases | **UNKNOWN — to be supplied by the owner:** `BUYER_ALIAS = <owner to name>`, `BUSINESS_ALIAS = <owner to name>`. Neither is assumed |

## 2. Hard exclusions

* The four spike orders recorded in `.spike/state.json` (run `202611051725`: `6J938166EX451764G`, `68C462760E533140P`, `5GR606463M4213332`, `81494218YG431211M`, all `PAYER_ACTION_REQUIRED`). No GET-for-mutation, approval, authorization, capture, void or cleanup. `.spike/state.json` sha256 at the start of this run: `a47b3ae205b9399ace7e72139b907cae2f9d762cf6b8d09822460c645037113d`.
* Production endpoints, production credentials, real buyers, real money.
* Webhooks, disputes, reauthorization, subscriptions, any currency other than USD.
* V2 flows (the V2 release gate stays closed; these cases exercise the V1 settlement path only).

## 3. Proposed cases (all USD, all Sandbox money, funds held at any time ≤ **USD 5.00**)

Operations are the ones the implemented integration performs (`docs/03-paypal-contract.md`): create `AUTHORIZE` order, buyer approval, authorize, capture (`final_capture: true`), void, and fresh GETs. Each write carries a deterministic `PayPal-Request-Id` and a `PayPalOperation` row.

| # | Purpose | Amount | Sequence | Expected PayPal / app state | Reversible? | Cleanup | Evidence captured |
|---|---|---|---|---|---|---|---|
| S0 | Read-only token check against Sandbox | — | `POST /v1/oauth2/token` | token returned; no order state | n/a (no state) | none | HTTP status, `debug_id`; no token stored in the report |
| S1 | Create order + idempotent re-create | 1.00 | create with request-id R; repeat create with the same R | one order, `PAYER_ACTION_REQUIRED`; second call returns the same order id | yes — an unapproved order moves nothing and expires | none | order id, both responses' ids equal |
| S2 | Buyer approves, authorize, no capture | 1.00 | buyer approval (browser, owner); `authorize`; fresh GET | authorization `CREATED`; funds held, nothing captured | yes — `void` (S3) | void in S3 | order + authorization ids, GET status |
| S3 | Void the S2 authorization; repeat void; capture after void | (S2) | `void`; `void` again; attempt capture | `VOIDED`; repeat void is rejected or idempotent (record which); capture after void is rejected and the app records no capture | void is final | none | statuses, error codes, app ledger rows |
| S4 | Partial capture, `final_capture: true` | 2.00 → capture 0.50 | approval; authorize 2.00; capture 0.50 with request-id C | capture `COMPLETED` 0.50; remainder released; authorization closed | **no** — undo only by refund | refund 0.50 (needs its own approval) | capture id, authorization status after, GET of capture |
| S5 | Duplicate capture request | (S4) | repeat the S4 capture with the same request-id C; then a different request-id | same capture returned for C; a second, different capture is rejected after `final_capture` | n/a | none | both responses, app shows exactly one captured amount |
| S6 | Full capture | 1.00 | approval; authorize; capture 1.00 `final_capture: true` | `COMPLETED` 1.00 | no — refund | refund 1.00 (own approval) | ids, GET |
| S7 | Payer cancels at the approval page | 1.00 | create; buyer chooses cancel | order stays unapproved; `cancel_url` reached; app records no authorization and no capture | yes | none | order status, app state |
| S8 | Declined / failed outcome, only if the Sandbox mock-response header is supported | 1.00 | create with a documented negative-testing header | declined/failed state; app never marks the deal paid | yes | none | response codes; marked **[CONFIRM IN SANDBOX]** — dropped if unsupported |
| S9 | Application path, mocked verification, real Sandbox money movement | 1.00 | one seeded V1 deal through order → authorization → settlement authorization re-derivation → capture | capture happens **only** after the deterministic settlement decision; a failing/unverifiable variant (no PayPal write beyond order creation) is run first | partially (refund) | refund 1.00 (own approval) | ledger events, request ids, `PayPalOperation` rows |

Funds are held only in S2 (1.00), S4 (2.00), S6 (1.00) and S9 (1.00) = at most **USD 5.00**; S1, S7 and S8 never move funds. Captured in total at most **USD 2.50** (S4 0.50, S6 1.00, S9 1.00). All Sandbox money.

## 4. Pre-conditions I will verify before the first write

1. `PAYPAL_ENV=sandbox` and the base URL again (fail-closed schema), at the time of the run.
2. The owner has named the buyer and business aliases, and I can show the business account owns the REST app (owner statement or an approved read-only check).
3. The source tree digest is recorded and unchanged since the validation baseline.

## 5. Approval boundary (two separate approvals)

1. **Matrix approval** (this document, amendments welcome): authorises only the creation of **new** orders under the named accounts at the listed amounts.
2. **Per-operation approval**, requested before the *first* buyer approval, authorization, capture, void or refund, and again for each later state-changing step if the owner prefers: I will present buyer alias, business alias, order id, amount and currency, the exact operation, expected resulting state, and reversibility. General approval of the matrix is **not** treated as approval of any payment-state transition.

## 6. Status

Configuration checks: complete (§1). Matrix: prepared (this document). Real Sandbox lifecycle validation: **NOT DONE** — waiting for matrix approval and account aliases.
