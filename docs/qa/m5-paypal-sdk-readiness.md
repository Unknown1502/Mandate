# Milestone 5 – PayPal SDK readiness and negotiation quality

Written for: the project owner, who must approve every external PayPal operation and decide whether to run another real model negotiation.

**Status in one paragraph.** The PayPal Sandbox gateway on the official PayPal Server SDK and the browser checkout button (PayPal JavaScript SDK v6) are implemented and tested against **fake SDK controllers only**. **No PayPal API call was made. No Groq call was made.** PayPal is still mock by default, Sandbox writes remain locked, V2 is disabled, production is NO-GO. The negotiation prompt was tightened and tested offline with a fake model. Nothing in this report is evidence of real PayPal behaviour.

## 1. Source identity

| | |
|---|---|
| New source digest (117 files: `src`, `prisma/migrations`, `schema.prisma`, `package.json`, `package-lock.json`; same method as the earlier digests) | `2335ef46826e7c9c5830999e38c9225b83be88d0c613a04f8817ea0f1170cbed` |
| Previous digest | `0c2e3b3578cec0f12db27c0d6fe423b23a06f8392a5c500ef4de5a2adbbc92c0` |
| Backup taken before any change | `../mandate-backups/m5-before-20261109-211505` |
| `.spike/state.json` (the four spike orders) | unchanged, sha256 `a47b3ae2…7113d` (also pinned by a test) |

Preserved and not rewritten: the first real Groq negotiation (`docs/qa/ai-smoke-20261109150054.json`, `docs/qa/live-groq/`), the four-call Groq run that ended `NO_AGREEMENT_WITHIN_ROUNDS` (`docs/qa/negotiation-m4/live-groq/`, it did **not** reach an agreement), the rule-based agreement run (`docs/qa/negotiation-m4/rule-based-haggler/`), the mock implementation, and all historical QA reports. Every change is in `docs/DEMO-CHANGELOG.md`.

## 2. Negotiation prompt changes (offline only)

Prompt guidance only; `src/domain/negotiation-policy.ts` is unchanged and remains the final authority (opening ≤ target, counter only after a seller price, no retreat, ≤ half the remaining gap per round, ≤ ceiling, round limit, seller-message confidentiality, schema validation, safe stop).
* Opening: "open at <about 90% of your target> (never above your target)" – the number is computed from the actual mandate target.
* Counter: the model is told the allowed range and to "move decisively … counter at <the highest price allowed this round> or within a few cents of it; do not make tiny concessions that waste rounds". The suggested value is the policy's own maximum for that round.
* Unchanged: accept only at or below target (or in the last round within the limit), no dollar amounts in `message`, speak as the buyer.

Offline tests (`tests/db/negotiation-prompt-sim.db.test.ts`, 14 tests, **fake model client, no Groq**): the fake model reads only the prompt text and answers as the prompt instructs, through the real `LlmBuyerBrain` + schema validation + `runNegotiation` + policy, against the real simulator logic. Covered: (1) near-target seller counter, (2) attainable floor (converges in 3 rounds, all offers inside the policy range), (3) floor above the ceiling (stops, nothing locked, no offer above the ceiling), (4) seller that refuses to move or declines, (5) illegal model offers (above target, above ceiling, over-large concession, below own last offer, smuggled fields) all blocked, (6) a model that tries to disclose the ceiling/target (message stripped, seller never receives it). **This shows the pipeline and prompt are consistent; it does not show how a real model behaves. No real negotiation was run.**

## 3. SDKs and versions

| Package | Version | Where |
|---|---|---|
| `@paypal/paypal-server-sdk` (official PayPal Server SDK) | **2.5.0** (exact pin; released 2026-08-21) | server only; imported **only** by `src/paypal/sdk-gateway.ts` |
| PayPal JavaScript SDK **v6** (browser) | loaded at runtime from `https://www.sandbox.paypal.com/web-sdk/v6/core` (not an npm dependency) | `src/app/ui/paypal-checkout.tsx` |

**Why v6 supports delayed capture (the question you asked).** In v6 the order is created on the merchant server and the browser session only receives `{ orderId }` (`paymentSession.start(options, createOrder())`); the order's `intent` is therefore whatever our server created (`AUTHORIZE`, from `createOrderBody`). PayPal's v6 reference states that `onApprove` "is where you should capture or authorize the payment on your server". The documented authorize-then-capture guide for the `&intent=authorize` script flag is v5-only and does not apply to v6. We never call capture from the browser path: `onApprove` only asks our server to advance the deal, and the server authorizes after re-reading the order from PayPal. **Caveat to verify in the approved Sandbox test:** PayPal's v6 set-up page recommends authenticating `createInstance` with a client id (used here) while its parameter table lists `clientToken` as required; if the client-id form is refused, a browser-safe client token needs one OAuth call (an approved PayPal API operation), so it was not implemented speculatively.

## 4. Gateway implementation status

| Piece | Status |
|---|---|
| `SdkPayPalGateway` (same `PayPalGateway` interface as the mock) | implemented, unit tested with fake controllers |
| Sandbox only | SDK environment is the literal `Environment.Sandbox`; `PAYPAL_ENV` must be `sandbox`, base URL exactly the Sandbox host; a test forbids any production host or `Environment.Production` in source |
| Explicit mode, no fallback | `PAYPAL_MODE=mock` (default) or `sandbox`; incomplete/placeholder/non-Sandbox configuration **throws** (names only, never values); any other mode throws; mock never builds the SDK gateway |
| Write lock | `SandboxWriteLock` still wraps the SDK gateway; writes refused unless `PAYPAL_SANDBOX_WRITES=authorized` (exact value) |
| Idempotency | every write sends the engine's stable `PayPal-Request-Id` (`<dealId>-<TYPE>-<seq>`); a lost-response capture is reconciled by GET and retried only under the same key (tested: one capture) |
| Ambiguous outcomes | timeouts, aborts, network failures, 429/5xx, unreadable 2xx bodies are `unknown` → engine reconciles; only 400/401/403/404/409/422 are definitive rejections; SDK errors (which carry the bearer token) are never stored or logged |
| Path safety | each operation accepts only its exact path shape with a strict id pattern; forged paths and bad request ids are refused before anything is sent |
| Order-to-deal binding (**new engine check**) | before authorization (and after order creation) the order read from PayPal must carry this deal's id (reference and custom id) and an amount equal to the locked price in USD, else the step is refused (`ORDER_BINDING_MISMATCH` ledger event); one existing test was updated to keep its intent (authorization-amount defence), a new test covers the earlier refusal |
| Buyer checkout | `GET /api/deals/[id]/checkout` (session + ownership; 404 for foreign deals; read-only; no PayPal call): returns order id, amount, currency, public client id and the fixed Sandbox script URL only when Sandbox mode, configured, writes unlocked and the deal awaits approval |
| Browser button | `src/app/ui/paypal-checkout.tsx`: refuses any script URL but the exact Sandbox v6 one, never sends amount/currency/order/buyer, reports an "approved" callback as *asking PayPal for the real status* |
| Displayed states | mock payment · sandbox checkout pending · buyer approval required · authorized (a hold, "not captured and not escrow") · awaiting delivery · capture permitted · captured (Sandbox vs MOCK) · voided · provider outcome unconfirmed / reconciliation required (`src/paypal/lifecycle.ts`, unit tested) |
| Webhooks | none implemented (an unsigned webhook would pretend to confirm payments); a test asserts no webhook route exists |
| CSP / COOP | CSP now allows only PayPal **Sandbox** origins (script, frame, connect) and `paypalobjects.com` images; COOP changed `same-origin` → `same-origin-allow-popups` (popup checkout). **Best-effort from public documentation, not verified; revisit in the approved test.** |

Routes: `GET /api/deals/[id]/checkout` (new); the existing `POST /api/deals/[id]/advance` performs the server-side authorize/capture/void steps; `POST /api/deals/[id]/mock-approval` exists only in mock mode (404 in Sandbox).

## 5. Real PayPal API call made? **NO.** Real Groq call made? **NO.**

Tests used fake SDK controllers, the in-memory mock, a fake model, and spies proving that constructing the SDK client and building the runtime make no HTTP request. No OAuth request, order, authorization, capture, void or refund was attempted.

## 6. Test results

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | clean |
| ESLint (`eslint .`) | clean |
| Next.js build | compiled successfully (includes the new `/api/deals/[id]/checkout` route) |
| Unit suite | **1023 / 1023** (44 files). New: SDK gateway adapter 31, checkout eligibility + lifecycle wording 11, SDK architecture/static guarantees 8 |
| PostgreSQL suite (`mandate_test`) | **655 / 655** (29 files), **rerun in full** on the final source. New: SDK lifecycle through the real engine and routes with fake controllers 16, runtime/mode/config 16, negotiation prompt simulation 14; one existing engine test updated and one added (order-binding) |
| Gateway tests | covered by the SDK adapter unit tests and the lifecycle DB test (request mapping, response parsing, rejected vs unknown, timeouts, path/id validation, secret hygiene, idempotency keys) |
| Payment-state-machine / settlement tests | existing engine, lifecycle and orchestration suites ran unchanged inside the 655 (the state machine was not modified) |
| Targeted mutation (`attack-lab/mutate-m5.mjs`, **not** the full certification) | **7 / 7 killed**, source restored byte-for-byte after each (`docs/qa/m5-mutation-targeted.json`): order-binding disabled, timeout→"rejected", write lock bypassed, capture path accepted for anything, checkout offered while writes locked, checkout offered in any state, opening-above-target allowed |
| Browser, mock mode (existing audit script `scripts/ui-audit.mjs`, desktop 1366×900 + mobile 390×844, real Chrome, throwaway database, rule-based buyer, mock PayPal, no model) | 90 / 90 checks, 0 findings, no console or HTTP errors; screenshots in `docs/qa/m5-ui-audit/mock/`. The new PayPal lifecycle line was additionally checked by eye on desktop and mobile. The audit's checks do not cover the real PayPal button (it only renders in Sandbox mode, which was not run). Its three "STUBBED" Gemini screenshots are API stubs, as before |
| Throwaway databases | created and dropped; only `mandate` and `mandate_test` remain |
| Source digest after all tests | unchanged: `2335ef46…cbed` |

Known flake: `tests/unit/prescan-budget.test.ts` (a timing test) has failed in some full parallel unit runs under load earlier in this project and passes alone; it passed in the final run.

## 7. Approval boundary (nothing below is authorized yet)

**Environment variable names** (values in an untracked env file outside OneDrive; never pasted into chat): `PAYPAL_MODE=sandbox`, `PAYPAL_ENV=sandbox`, `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX_WRITES=authorized` (only while an approved step runs), `APP_URL` (used for return/cancel URLs), `SELLER_URL`, `DEMO_CHALLENGE_WINDOW_SECONDS`. `PAYPAL_WEBHOOK_ID` is not used. Note: `.env.local` already holds PayPal credentials from the earlier spike; I have not read them and do not know which Sandbox app they belong to.

**What I need from you:** (a) the alias of the dedicated Sandbox **business** account that should receive the money, (b) the alias of the dedicated Sandbox **personal (buyer)** account the human will log in with, (c) confirmation that the Sandbox app credentials in your env file belong to a *new* Sandbox app, not the one that owns the four spike orders (so test orders are not mixed with them). Credentials stay with you; the human logs in on PayPal's own page.

**Proposed transaction matrix** (USD, Sandbox money only; every amount is the deal's locked price, which with the honest simulator and the rule-based buyer is deterministic):

| # | Scenario | Amount | PayPal operations (in order) | Expected end state |
|---|---|---|---|---|
| T1 | Happy path: clean delivery, buyer accepts | **20.00 USD** | OAuth token → create order (AUTHORIZE) → GETs → *human approves in the button* → authorize → GETs → capture 20.00 (final) → GET capture | `CAPTURED`, one capture of 20.00 |
| T2 | Failed delivery (duplicate rows) | **20.00 USD** | OAuth → create order → human approves → authorize → void → GET authorization | `VOIDED`, nothing captured |
| T3 (optional) | Buyer cancels in the PayPal window | 20.00 USD | OAuth → create order → GETs only | order left unapproved, no authorization, no money moved |

Lifecycle and cleanup: orders and authorizations are Sandbox-only and expire by themselves (authorization 29 days); no refund is planned; the app's database for the test is a throwaway one, dropped afterwards; the four spike orders are not touched.

**Operations that each need your separate approval before they happen** (the single write lock is an on/off switch, so each stage is run with `PAYPAL_SANDBOX_WRITES=authorized` set by you only for that stage, then locked again):
1. the first PayPal API operation (OAuth token + create order),
2. the buyer's checkout/approval in the PayPal window (a human action with the Sandbox buyer account),
3. the authorization (server write after approval),
4. each capture or void.

## 8. What is still unverified / risks

* Everything about real PayPal behaviour: SDK request/response mapping against the live API, the `custom_id`/`reference_id`/`amount` fields on a real GET order (the binding check is strict and **fails closed**: if PayPal omits them the deal is refused, no money moves), post-capture authorization status, idempotency replay semantics (the mock's are assumptions).
* v6 client-id authentication, CSP origins and COOP value (see sections 3–4).
* The v6 button and its popup/frame behaviour have never been rendered against PayPal; only the "not available" and mock paths were exercised in a browser.
* No external audit of these trust-boundary changes was run (offer: run `/audit` if you want one; it sends code to external reviewers, so it needs your approval).
* Production remains NO-GO. V2 remains disabled.

## 9. Update: credentials check and OAuth-only connectivity check (still no PayPal request)

* **Offline configuration check** (script outside the repo; guards on socket, http, https, dns and fetch recorded **0** network attempts): Sandbox settings correct (`PAYPAL_ENV=sandbox`, exact Sandbox base URL); both credentials present, single definition, unquoted, not placeholders, 80 characters, URL-safe, different from each other; the Sandbox runtime builds on the SDK gateway with writes **locked**, no mock object, checkout configured with the fixed Sandbox v6 URL, no secret in public info; the mock runtime still builds and its tests pass.
* **New credentials NOT on disk at check time:** `.env.local` was last saved at 20:22 and the Client ID fingerprint (first 8 hex of its SHA-256) was `6d1e77a2` both before and after the owner's message, so the file still held the previous values. Re-run the check after saving; the fingerprint should change.
* **Business account / application:** cannot be confirmed offline. Only a request to PayPal can show which application the credentials belong to (the OAuth response names the application id), and the Business-account link is visible in the Sandbox dashboard. Local configuration is consistent with Sandbox only.
* **OAuth-only check (prepared, NOT executed):** `npm run paypal:oauth-check -- --env-file <file>` prints the plan and exits 4 without `--approve-oauth-request`; exits 3 if not configured. With the flag it makes exactly one request (client-credentials token, no retry, 15 s timeout), prints status, debug id, token type, lifetime, application id and scope count, and writes `docs/qa/paypal-oauth-check-<time>.json` with no token and no credential. It creates, authorizes, captures and voids nothing, does not read or change `PAYPAL_SANDBOX_WRITES`, and does not import the payment engine or database. Order creation, buyer checkout, authorization, capture and void remain separate approval steps.
* New source digest after adding the check: `fa719ed91a4c6f2304a7e93fc2063355cb38c8ec7a7f8c9bebd12e01bbffbe23`. `.spike/state.json` unchanged.

## 10. First real PayPal request: OAuth token only (owner-authorized, exactly one)

On 2026-11-09 the owner authorized exactly one request: `npm run paypal:oauth-check -- --env-file .env.local --approve-oauth-request`. Result (sanitized evidence: `docs/qa/paypal-oauth-check-20261109175203.json`):

| | |
|---|---|
| Request | one `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` (client credentials), no retry |
| HTTP status | 200, **token issued** |
| PayPal debug id | `f80684127fa35` |
| Application id | `APP-31312543TM3482343` (to be compared by the owner with the `MANDATE-Hackathon` app in the Sandbox dashboard) |
| Token | Bearer, valid 32400 s; **never printed or stored** (the evidence file was checked: it contains neither credential value nor any token field) |
| Scopes | 26 granted, including the authorize/capture scope family (`payments/payment/authcapture`) and 3 order-related scopes |
| Latency | 2326 ms |

What this proves: the Client ID and Client Secret in `.env.local` are a valid Sandbox credential pair (a mismatched pair would have returned `invalid_client`), the machine can reach the Sandbox OAuth endpoint, and the SDK-based request path works for this call. What it does **not** prove: which Business account the app is linked to (visible in the dashboard), that orders can be created, that the buyer checkout works, or anything about authorize/capture/void. No order was created, nothing was authorized, captured, voided or refunded, `PAYPAL_SANDBOX_WRITES` is still unset (writes locked), and `.spike/state.json` is unchanged. The next step (order creation) needs a separate explicit approval.

## 11. PayPal Sandbox E2E - Stage 1 executed (create the order only)

Owner approved exactly three requests; they were enforced by a network allow-list guard (`scripts/lib/outbound-guard.ts`, refuses any other request BEFORE it is sent) and all three were sent: `POST /v1/oauth2/token` (the SDK's own), `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`. Guard refusals: 0. One TCP connection to `api-m.sandbox.paypal.com:443`. Sanitized evidence: `docs/qa/paypal-e2e-stage1-20261109184543.json`.

| | |
|---|---|
| Order id | `4R58521703025521B` |
| Status / intent | `PAYER_ACTION_REQUIRED` / `AUTHORIZE` |
| Amount | 20.00 USD (the deal's locked price) |
| Bound to the deal | yes: reference id and custom id both equal the deal id `cmw9m38nq0004vf7solxwm61x` (the engine's order-binding check passed on PayPal's own read-back) |
| Payee | `<sandbox-business-email>` (merchant `2V6GR7UPQBMY8`), equal to the expected Business account |
| Debug ids | create order `ca57ef9f5ee6f`; read order `ca57efa007fd9`; the token request's id was not captured (the SDK makes it internally) |
| Local state | deal `AWAITING_BUYER_APPROVAL`; one local operation (`CREATE_ORDER` confirmed); no authorization id; nothing captured |
| Database | `mandate_e2e` (dedicated), 1 deal, 1 operation, kept for the next stages |
| Environment | `PAYPAL_MODE=sandbox` and `PAYPAL_SANDBOX_WRITES=authorized` were temporary process-level variables for this run only; `.env.local` was not modified; the write lock is closed again |

Not done: buyer checkout, approval, authorization, capture, void, refund; the four spike orders were not referenced (state file unchanged). Buyer account `<sandbox-buyer-email>`: not verifiable yet (it is only used when the buyer logs in on PayPal's page).

## 12. New US Sandbox application "Mandate": OAuth verification (owner-authorized, exactly one request)

After the first application's checkout was refused by PayPal (`UNSUPPORTED_PAYEE_CURRENCY`: the Sandbox accounts could not transact in USD), the owner created a new US Sandbox application, `Mandate`. Pre-checks passed before any request (Client ID fingerprint `f29310d5`, both credentials present and non-placeholder, Sandbox host only, `PAYPAL_SANDBOX_WRITES` unset). One request was then made: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`.

| | |
|---|---|
| HTTP status | 200, token issued |
| PayPal debug id | `f55961963b817` |
| Application id | `APP-8PP6469227275300H` (to be compared by the owner with the `Mandate` app in the Sandbox dashboard; differs from the earlier `APP-31312543TM3482343`) |
| Token | Bearer, 32400 s; never printed or stored |
| Scopes | 28 granted, including `payments/payment/authcapture` |
| Latency | 3646 ms |
| Evidence | `docs/qa/paypal-oauth-check-20261109195952.json` (no token, no credential) |

This shows the new Client ID/Secret pair is valid and the new app exists. It does not show the Business/Buyer account linkage or that USD checkout now works; that is only proven at order creation and buyer approval. The order `4R58521703025521B` and deal in `mandate_e2e` belong to the FIRST application and must not be reused: a new order must be created with the new credentials (own approval).

## 13. US Sandbox application "Mandate" - Stage 1 executed (create the order only)

Preconditions passed offline (OAuth application `APP-8PP6469227275300H`, Client ID fingerprint `f29310d5`, Sandbox host only, write lock closed). The previous `mandate_e2e` database (holding the abandoned first-application order) was archived by renaming it to `mandate_e2e_abandoned_india_app` (data preserved, never referenced again) and a fresh `mandate_e2e` was created. Exactly three requests were permitted and sent (guard refused 0): the SDK's token request, `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`. Evidence: `docs/qa/paypal-e2e-stage1-20261109200433.json`.

| | |
|---|---|
| Order id | `4YJ97804H20584006` (new; not the abandoned `4R58521703025521B`) |
| Status / intent | `PAYER_ACTION_REQUIRED` / `AUTHORIZE` |
| Amount | 20.00 USD |
| Bound to the deal | reference id and custom id both equal the deal id `cmw9owm800004vfoshymk7yir` |
| Payee | `<sandbox-business-email>` (merchant `LGNV2YVLUDKL8`) = expected US Business account |
| Debug ids | create `f481148d44473`; read `f6723441a617d`; token request id not captured (SDK-internal) |
| Approval link | recorded on the deal and verified to be exactly the Sandbox checkout page for this order (not printed, not in the evidence file) |
| Local state | `AWAITING_BUYER_APPROVAL`; one local operation (`CREATE_ORDER` confirmed); no authorization id |
| Write lock | `PAYPAL_MODE` and `PAYPAL_SANDBOX_WRITES` were process-level for this run only; `.env.local` unchanged; lock closed |

Not done: buyer checkout, approval, authorization, capture, void, refund. Buyer `<sandbox-buyer-email>` is not verifiable until the buyer logs in on PayPal's page. Note for the next stage: `scripts/paypal-e2e-stage2.ts` still has the first order id hard-coded and must be updated to the new order id before use.

## 14. US Sandbox application "Mandate" - Stage 2 executed (buyer approval, verified by one read)

The buyer approved order `4YJ97804H20584006` on PayPal's own checkout page (clean incognito window, buyer `<sandbox-buyer-email>`); PayPal redirected to the success URL (`/paypal/return` with a `PayerID`; the connection error there is expected because no app was running). The earlier `UNSUPPORTED_PAYEE_CURRENCY` refusal did not recur with the US accounts. Verification used exactly two requests (guard-enforced, refused 0): the SDK's token request and one `GET /v2/checkout/orders/{id}`. Evidence: `docs/qa/paypal-e2e-stage2-20261109201059.json`.

| | |
|---|---|
| Order status | **`APPROVED`** (HTTP 200, read debug id `f575074856704`) |
| Intent / amount | `AUTHORIZE` / 20.00 USD |
| Payer | `<sandbox-buyer-email>` = the expected buyer |
| Still this deal | reference id and custom id equal deal `cmw9owm800004vfoshymk7yir` |
| Payee | the expected US Business account |
| Authorization / capture on the order | none |
| Local deal | unchanged: `AWAITING_BUYER_APPROVAL`, no authorization id (the script wrote nothing) |
| Write lock | closed; `.env.local` unchanged; `.spike/state.json` unchanged |

An APPROVED order is a buyer's approval, not a payment authorization and not a hold on funds. Next stage (separate approval): the server-side authorization. Note: the engine will read the order again before authorizing (a fresh GET is its rule), so that stage needs its own request budget.

## 15. US Sandbox application "Mandate" - Stage 3 executed (server-side authorization)

Owner approved exactly five requests; an ordered allow-list guard enforced them (refused 0): the SDK's token request; a fresh `GET` of the order (the engine's mandatory read: `APPROVED`, bound to the deal, 20.00 USD); `POST /v2/checkout/orders/4YJ97804H20584006/authorize` (the only write; `PayPal-Request-Id` `<dealId>-AUTHORIZE-1`, empty body); an order read-back; and a read of the authorization resource. Evidence: `docs/qa/paypal-e2e-stage3-20261109210116.json`.

| | |
|---|---|
| Authorization id | `19070882T8512554U` |
| Authorization status | `CREATED` |
| Amount | 20.00 USD (matches the locked price) |
| Expiry | 2026-12-08T21:01:21Z (29-day authorization window) |
| Order after | `COMPLETED`, 0 captures on the order |
| Debug ids | fresh read `f789210171224`; authorize POST `f8392841931ae` (HTTP 201); order read-back `f6475134e8be9`; authorization read `f647513f3da1f` |
| Local deal | `AWAITING_DELIVERY`; authorization id, status and expiry persisted; operations `CREATE_ORDER` and `AUTHORIZE` both confirmed |
| Write lock | `PAYPAL_MODE` and `PAYPAL_SANDBOX_WRITES` were process-level for this run only; `.env.local` unchanged; lock closed; the app was restarted with writes locked and an outbound-request block |

An authorization is a hold on the buyer's funds at PayPal; it is not a capture, not a payment and not escrow. Nothing has been captured, voided or refunded. Next stages (each needs its own explicit approval): delivery and verification through the dashboard (no PayPal request), then a capture (clean delivery + buyer acceptance) or a void (failed delivery).

## 16. US Sandbox application "Mandate" - Stage 4 executed (clean delivery and verification, no PayPal request)

The honest seller simulator (local loopback process) delivered one clean CSV through the app's own delivery route; the deterministic verification ran. **No PayPal request was made in this stage** (the app runs with an outbound block; it refused exactly one request, see below). Evidence: `docs/qa/paypal-e2e-stage4-20261109210955.json`; dashboard captures (view only, desktop and mobile, no mutation requests) in `docs/qa/paypal-e2e-stage4/`.

| | |
|---|---|
| Delivery | `cleaned.csv`, 171 bytes, 5 rows x 3 columns, sha256 `347bcfff6d7c3d436e66a316fab20f2645f35d0d8c969ad63eefd02f7f8d8f22` |
| Verification | `ALL_REQUIRED_PASSED` (verifier `p0-iso-1`): schema PASS (required), no duplicate rows PASS (required), date format PASS (optional); 0 flags, 0 unverifiable, 0 deterministic failures; deterministic only, 0 model calls (`NO_LLM_CRITERIA`) |
| Deal | `VERIFYING`; no settlement record; **buyer acceptance pending** (no accept request was made); the one-hour challenge window ended 2026-11-09T22:09:56Z |
| Authorization | `19070882T8512554U`, last read from PayPal as `CREATED` in Stage 3 and **not re-read** in Stage 4; no capture exists; local operations `CREATE_ORDER`, `AUTHORIZE` only |
| App | Sandbox mode, write lock closed, V2 disabled, outbound requests blocked |

Finding: after a verified delivery the engine's settlement step re-reads the authorization from PayPal before deciding. In this stage that read was refused locally by the app's outbound block (`POST /v1/oauth2/token`, the first step of the read), so the engine logged `PAYPAL_READ_FAILED` and left the deal in `VERIFYING` without a settlement decision. That read is part of the capture stage's request list.

Capture-stage request sequence, derived from the engine and pinned by a test with fake SDK controllers (offline): token request; `GET` authorization (settlement decision); `GET` authorization (pre-capture check); `POST /v2/payments/authorizations/{authorizationId}/capture` (the write: 20.00 USD, `final_capture` true, `PayPal-Request-Id` `<dealId>-CAPTURE-1`); `GET` capture; `GET` authorization. Capture needs its own explicit approval.
