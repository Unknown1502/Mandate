# MANDATE – final Playwright end-to-end validation and capture preflight

Written for: the project owner, who must decide whether to approve the final PayPal Sandbox capture, and for reviewers who want to see exactly what was tested, what is real and what is simulated.

**Bottom line.** The full browser journey passes against a mock-mode copy of the app (73/73 checks, 25 screenshots) and the read-only audit of the real Sandbox deal passes on three viewports (92/92 checks, 18 screenshots). The real deal was not changed: its database state is byte-identical before and after the audit, and the audit attempted no state-changing request. The capture preflight passes all 13 offline checks. **No PayPal request was made in this task, no model call was made, and nothing was captured, voided or refunded.** The final capture needs your separate explicit approval (section 8).

## 1. Final source digest and scope of changes

| | |
|---|---|
| Source digest (`src`, `prisma/migrations`, `schema.prisma`, `package.json`, `package-lock.json`) | `fa719ed91a4c6f2304a7e93fc2063355cb38c8ec7a7f8c9bebd12e01bbffbe23` (unchanged during this task; no production source was edited, so no rebuild was needed and the build the real app serves is still current) |
| New in this task (scripts and tests only) | `scripts/e2e-mock-journey.mjs`, `scripts/e2e-real-dashboard-audit.mjs`, `scripts/paypal-e2e-capture-preflight.ts`; the lifecycle DB test now pins the capture-stage call sequence |
| Environment | `.env.local` unchanged; `PAYPAL_SANDBOX_WRITES` unset (lock closed); `.spike/state.json` unchanged (`a47b3ae2…`); V2 disabled; production unavailable |

## 2. Phase A - environment inspection (read-only)

* Docker and the Postgres container were down when the session resumed (11:56 IST); I restarted them. The `mandate_e2e` data was intact.
* The real app runs on `http://localhost:3000` in **Sandbox mode with the write lock closed**, with a preload that refuses every non-loopback request (0 refusals during this task). The honest seller simulator runs on `127.0.0.1:4010`.
* The app is connected to `mandate_e2e`: the deal visible through the app and the database row are the same: deal `cmw9owm800004vfoshymk7yir`, state `VERIFYING`, price 20.00, order `4YJ97804H20584006`, authorization `19070882T8512554U` (`CREATED`, expires 2026-12-08 21:01:21 UTC), nothing captured, 0 settlements, 0 capture/void operations, operations `CREATE_ORDER` and `AUTHORIZE` only. Stage 3 evidence agrees (section 6).
* No order was created; the four spike orders and `.spike/state.json` were not touched.

## 3. Phase B - full journey in MOCK mode (73/73 checks, 25 screenshots)

`scripts/e2e-mock-journey.mjs`, real Chrome through Playwright, against a **disposable database** (`mandate_qa_e2e_<time>`, dropped afterwards) and its **own** app instances (port 3100) with `PAYPAL_MODE=mock` set explicitly. The real deal, port 3000 and `mandate_e2e` were never used. The Buyer Agent was the **rule-based brain** (no model call): see section 5. Screenshots: `docs/qa/final-playwright-e2e/mock/` (01-25).

| Scenario (seller simulator mode) | What was tested | Result |
|---|---|---|
| Login and logout | wrong secret shows an error; sign-out returns to login; the API answers 401 after logout | pass |
| Empty states | "No mandate yet", "No deals yet" | pass |
| Forms and validation | invalid budget refused with a visible error and no mandate; invalid target price refused and no deal created | pass |
| Mandate | preview digest, confirm and sign, "Seal verified" | pass |
| **Honest** seller: price | opening at the target, locked at 20.00 in one round, inside the ceiling | pass |
| **Honest**: payment states (MOCK) | order pending ("NOT authorized, no funds held") -> authorized ("a hold, not captured, not escrow") -> captured; every state labelled MOCK | pass |
| **Duplicate-action protection** | double-clicking the mock checkout produced exactly ONE authorization; double-clicking Accept produced exactly ONE capture of the locked price; a repeated "Check settlement" after capture did not capture again | pass |
| **Clean delivery** | 3 deterministic checks PASS, "AI assessment: none", acceptance pending, capture "not permitted yet" until accepted; accepted -> captured (MOCK) | pass |
| **Duplicate-row delivery** | required check fails -> authorization voided, nothing captured, "Voided (not paid)" | pass (void path) |
| **Hidden-instruction delivery** | scanner flags it, deal stops at "Needs your decision", no capture and no void by itself, no unrestricted reject button | pass |
| **Challenge** of one passed criterion | the challenge is recorded (who/why/criterion), the delivery is re-verified against the ORIGINAL locked terms (second verification record), at most one capture of the locked price | pass; see finding F1 |
| **Haggler** seller (counteroffers) | opening 20.00, seller counter 25.59, buyer concession 22.80, seller accepts; agreement inside the limits; simulator labels itself on every message | pass |
| **Greedy** seller (refuses the authorized range) | buyer offered 20, then 50 (the ceiling), 50, then walked away; never above the ceiling; deal BLOCKED; no PayPal order or operation; UI shows "ended without a deal" and "Ended without a payment" | pass |
| **Tamper** seller (smuggles criteria/amount) | SELLER_PROTOCOL_VIOLATION, deal BLOCKED, no payment | pass |
| **Adversarial** seller (injection in messages) | buyer disclosed nothing, accepted no injected price, seller text shown only as seller text | pass |
| Seller unreachable | deal BLOCKED (SELLER_ERROR), clear message, no payment | pass |
| Error and timeout handling | network failure ("Could not reach the server"), HTTP 500 shown as an error, a slow request disables the buttons (loading state, no double submit); none of them changed the deal | pass |
| Mobile viewport | no horizontal overflow, every control labelled | pass |
| Browser noise | no unexpected console errors, page errors, failed requests or HTTP errors (the deliberate validation 400s and injected failures are excluded) | pass |

**Truthfulness checks (29 of the 73):** at every major state the UI labelled PayPal as MOCK (never Sandbox or live), the Buyer Agent as Rule-based (never "Live AI"), V2 as Disabled, and a mock capture as "Captured (MOCK: no real money moved)". Failed negotiations showed no payment.

## 4. Phase C - real dashboard audit (92/92 checks, 18 screenshots)

`scripts/e2e-real-dashboard-audit.mjs` against `http://localhost:3000`, desktop 1366x900, tablet 768x1024, mobile 390x844 (30 checks each + 2 global). Screenshots: `docs/qa/final-playwright-e2e/real/`.

**Safety.** The script never clicks Accept, "Check settlement now", "Request review", checkout or delivery controls, and a network route aborts every non-GET browser request except sign-in/out. Result: **0 state-changing attempts**; the real deal's database fingerprint (row hash, ledger length and hash, operation and settlement counts) is **identical before and after**.

| Area | Result |
|---|---|
| Console / page / network errors | none unexpected on any viewport |
| Navigation | audit history expands, Refresh keeps the deal selected, keyboard Tab reaches a control |
| Forms | mandate and new-deal fields are labelled (opened, not submitted) |
| Empty and failure states | shown with clearly labelled STUBBED GET responses: "No mandate yet / No deals yet"; a deal-load failure is shown as an error, not as success |
| Negotiation transcript | present: rule-based buyer, local simulator, "No AI model was called for this deal" |
| Delivery evidence | `cleaned.csv`, three PASS checks, "AI assessment in this verification: none" |
| Payment-state accuracy | chip "Sandbox (writes LOCKED)"; "Authorized; delivery is being verified. Capture is not permitted yet"; Authorization CREATED; Captured "-"; operations exactly CREATE_ORDER and AUTHORIZE; no "Paid" and no "Captured (PayPal Sandbox)" |
| Buyer decision | acceptance pending: "You can accept now, or wait for the challenge window to end"; Accept offered, not taken |
| Accessibility | every control labelled, every button named, page title/language/headings present |
| Mobile and tablet overflow | none |

The audit's sign-in probes hit the app's login limiter (5 attempts per minute per client, by design) on a first run; the viewports are now paced a minute apart.

## 5. Real AI versus scripted/rule-based evidence

| Evidence | Nature | Where |
|---|---|---|
| Smoke test, 2 requests, Groq `openai/gpt-oss-20b`, synthetic data | **real model**, owner-run | `docs/qa/ai-smoke-20261109150054.json` |
| Live negotiation #1: 1 model call, proposed 25.00 (target 20.00), accepted | **real model** | `docs/qa/live-groq/` |
| Live negotiation #2 vs the haggler simulator: 4 model calls, ended `NO_AGREEMENT_WITHIN_ROUNDS` (buyer 21.50 vs floor 22.00), no payment | **real model** | `docs/qa/negotiation-m4/live-groq/` |
| 14 offline prompt/policy tests with a fake model; Gemini and Groq provider tests with fake SDK clients | **scripted/fake model** | `tests/db/negotiation-prompt-sim.db.test.ts`, `tests/unit/{gemini,groq}-provider.test.ts` |
| This task's browser journeys (mock and real-deal audit) | **rule-based brain, no model** | sections 3-4 |

The brief asked to negotiate "using the configured test model" in the mock journey. I did **not** call Groq: a live model run needs your fresh explicit authorization, which this task did not give. The mock journey exercised the same deterministic policy on the rule-based brain; the real-model behaviour is the evidence above.

## 6. Mock PayPal versus real Sandbox evidence

| | Mock (in-memory, simulated) | Real PayPal Sandbox |
|---|---|---|
| What it covers | the whole lifecycle incl. capture and void, through the real engine and routes (section 3; also `tests/db/paypal-sdk-lifecycle.db.test.ts`, 18 tests with fake SDK controllers) | create order, buyer approval, authorization (US application `Mandate`) |
| Evidence | the mock journey and tests; nothing here proves PayPal's behaviour | `docs/qa/paypal-e2e-stage1-20261109200433.json` (order created), `...stage2-20261109201059.json` (buyer approved), `...stage3-20261109210116.json` (authorization), `docs/qa/paypal-e2e-stage4-20261109210955.json` + `paypal-e2e-stage4/` (delivery verified), `docs/qa/paypal-oauth-check-20261109195952.json` |
| Never exercised against PayPal | capture, void, refund, reauthorize | same |

## 7. Phase D - exact live payment state (from stored records and evidence; no PayPal request)

| Item | Value |
|---|---|
| Deal | `cmw9owm800004vfoshymk7yir` in `mandate_e2e`, state `VERIFYING`, locked price 20.00 USD |
| PayPal order | `4YJ97804H20584006`: Stage 1 read-back showed reference id and custom id equal to the deal id; payee = the US Business account `<sandbox-business-email>` (merchant `LGNV2YVLUDKL8`) |
| Stage 2 buyer approval | order `APPROVED`; payer = `<sandbox-buyer-email>`; still bound to the deal; no authorization or capture on the order (read debug id `f575074856704`) |
| Stage 3 authorization | `19070882T8512554U`, `CREATED`, 20.00 USD, expires **2026-12-08T21:01:21Z**; order `COMPLETED` with 0 captures; persisted on the deal (authorize POST HTTP 201, debug `f8392841931ae`) |
| Stage 4 verification | delivery `cleaned.csv` (171 bytes, sha256 `347bcfff...8f22`); `ALL_REQUIRED_PASSED`: schema, no duplicates, date format all PASS; 0 flags; 0 model calls; buyer acceptance **pending**; the one-hour challenge window **ended 2026-11-09T22:09:56Z** |
| Local ledger | no captured amount, no settlement record, no capture/void operation; 2 `PAYPAL_WRITE` events (create, authorize); 1 `PAYPAL_READ_FAILED` event (the engine's pre-decision authorization read, refused locally by the app's outbound block in Stage 4; visible in the activity list) |

## 8. Phase E - capture preflight (offline) and the outstanding approval

`scripts/paypal-e2e-capture-preflight.ts` (read-only, empty outbound guard: 0 requests sent) applied the engine's own functions to the real deal. Evidence: `docs/qa/final-playwright-e2e/capture-preflight.json`. **All 13 checks pass:**

* the deal's full authorization re-derives from the stored records (mandate seal, terms hash, counterparty, attestation);
* both required criteria are met, no flag;
* the stored authorization id equals the Stage 3 provider-read id; it has **not expired** (valid 29 more days; the engine requires 5 minutes of margin); amount 20.00 USD = the locked price;
* the **deterministic settlement decision is `FULL_CAPTURE` of exactly 20.00** (earned 100%, no reasons to hold);
* the challenge window has ended, so the engine will not wait;
* no capture exists (no capture/void operation, no settlement, nothing captured, none on the order at the Stage 3 read);
* duplicate-capture protection in the live schema: unique `requestId`; unique (deal, type, seq); a partial unique index allowing at most one live CAPTURE/VOID per deal; one settlement record per deal.

**Proposed capture request plan - NOT SENT.** Six requests, in this order, no retry, under an ordered allow-list guard (the engine's sequence, pinned by an offline test):

| # | Request | Expected effect |
|---|---|---|
| 1 | `POST /v1/oauth2/token` | SDK token request; no state change |
| 2 | `GET /v2/payments/authorizations/19070882T8512554U` | settlement-decision read: the engine decides only if `CREATED`, 20.00 USD, unexpired |
| 3 | `GET /v2/payments/authorizations/19070882T8512554U` | fresh pre-capture check; a capture above the authorization or the price is refused before sending |
| 4 | `POST /v2/payments/authorizations/19070882T8512554U/capture` | **the only write**: capture 20.00 USD, `final_capture: true`, `invoice_id` `<dealId>-settle-1`, `PayPal-Request-Id` `<dealId>-CAPTURE-1` (stable across retries of the same operation), `Prefer: return=representation` |
| 5 | `GET /v2/payments/captures/{captureId}` | read-back: must be `COMPLETED` (a PENDING or DECLINED capture is not treated as success) |
| 6 | `GET /v2/payments/authorizations/19070882T8512554U` | reconciliation: authorization moves to `CAPTURED`; the deal becomes `CAPTURED` |

What the preflight cannot prove: what PayPal says right now. Requests 2 and 3 re-verify it before any capture, and the engine refuses to capture otherwise. If the capture POST's outcome is unknown, the engine reconciles with GETs and never re-sends under a new key.

**Decisions for you.**
1. **Approve the capture stage** (the six requests above, with `PAYPAL_SANDBOX_WRITES=authorized` set by you for that single run), or decline.
2. **Acceptance:** because the challenge window has ended, the engine needs no acceptance. You may either let the capture proceed on that basis, or first record an explicit "Accept delivery" (database only, no PayPal request) so the buyer's decision is on the record before payment. Both lead to the same six requests.
3. **Timing:** PayPal recommends capturing within the 3-day honor period after authorization (authorization created 2026-11-09 21:01 UTC, so about **2026-11-12 21:01 UTC**); the authorization remains valid until 2026-12-08, but after the honor period PayPal does not guarantee the funds and a reauthorization would be needed.

## 9. Failures, limitations and blockers

* **F1 (behaviour to be aware of).** A challenge on a passed criterion that re-verifies as passed **settles immediately**: the engine clears the challenge window after re-verification and then pays (documented in `tests/db/review-policy.db.test.ts`). The dashboard text for the challenge form says it "pauses payment and re-verifies" but does not say it then pays. Suggested UI wording fix; not changed (payment-adjacent text; needs your approval).
* **F2.** After a verified delivery the engine re-reads the authorization from PayPal before deciding. In the real app that read is refused locally (outbound block), leaving a `PAYPAL_READ_FAILED` ledger entry and the deal in `VERIFYING`. It is expected and is request 2 of the capture plan.
* **F3.** The real Sandbox buyer checkout used PayPal's approval page from the order's recorded link; the **v6 checkout button in the dashboard was never rendered against PayPal**, because its approval callback triggers the server-side authorization. The first checkout attempt with the earlier (India) application failed with `UNSUPPORTED_PAYEE_CURRENCY`; the US application resolved it.
* **F4.** No webhook receiver exists (an unsigned webhook would pretend to confirm payments). CSP and COOP changes for PayPal's popup are best-effort from documentation and untested against PayPal.
* **F5.** The seller is a local simulator, not a real merchant; the mock's idempotency replay and post-capture authorization status are assumptions to be verified in Sandbox.
* **F6.** The Docker interruption at session resume (restarted, data intact); the audit scripts pace logins because of the app's login limiter (a security control working as intended).
* **F7.** Mutation testing was not rerun: no production source changed in this task. Production remains NO-GO; V2 disabled.
* **Blockers.** None technical. The capture is gated only on your explicit approval.

## 10. Test results (this task)

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | clean |
| ESLint (`eslint .`) | clean |
| Next.js build | not rerun: no production source changed (digest unchanged), and rebuilding would overwrite the build the real app is serving |
| Unit suite | **1067 / 1067** (50 files) |
| PostgreSQL suite (`mandate_test`), full | **657 / 657** (29 files) |
| Lifecycle tests through the SDK gateway with fake controllers | 18 / 18, including the pinned Stage 3 sequence (order read, authorize, order read, authorization read) and the pinned capture-stage sequence (authorization read x2, capture, capture read, authorization read) |
| Mock browser journey | 73 / 73 checks, 25 screenshots (`docs/qa/final-playwright-e2e/mock/`, `report.json`) |
| Real dashboard audit (read-only), desktop + tablet + mobile | 92 / 92 checks, 18 screenshots (`docs/qa/final-playwright-e2e/real/`, `report.json`); 0 state-changing attempts; real deal database fingerprint identical before and after |
| Capture preflight (offline) | 13 / 13 checks, 0 requests sent (`docs/qa/final-playwright-e2e/capture-preflight.json`) |
| Mutation testing | not rerun: no security boundary changed in this task |

Throwaway artefacts: the disposable databases created by the journeys were dropped; only `mandate`, `mandate_e2e`, `mandate_e2e_abandoned_india_app` and `mandate_test` remain.

## 11. Addendum - Stage 4.5 (explicit buyer acceptance): not possible after the window ended

The owner asked for the authenticated buyer's explicit acceptance to be recorded. The engine's `acceptVerification` accepts only while the deal is `VERIFYING` **with the challenge window still open** and answers `NO_OPEN_CHALLENGE_WINDOW` afterwards (its only effect is to end the buyer's own waiting period early). The window ended 2026-11-09T22:09:56Z, so an acceptance can no longer be recorded through the product's mechanism. Nothing was changed: the accept route was not called (it would be refused, and the orchestrator's follow-up settlement attempt would add another locally refused PayPal read to the ledger), the database was not edited, the engine was not modified. Read-only state: 0 acceptance events (`HUMAN_REVIEW_DECISION`), deal `VERIFYING`, no settlement, no capture or void operation, 2 `PAYPAL_WRITE` events (create, authorize), the deterministic decision is `FULL_CAPTURE` of exactly 20.00 (offline), write lock closed, spike state unchanged, 0 PayPal requests.

Consequence for the capture stage: the engine needs no acceptance once the window has ended; the recorded basis for paying would be "verification passed, the buyer's challenge window ended unused", not an explicit acceptance event.

## 12. Addendum - Stage 5: the one final Sandbox capture (executed 2026-11-10)

**Basis.** Deterministic verification `ALL_REQUIRED_PASSED`, the buyer's challenge window ended unused (2026-11-09T22:09:56Z), settlement decision `FULL_CAPTURE` of 20.00. No explicit buyer acceptance event exists and none was created or fabricated; the owner approved proceeding under the existing expired-window rule.

**How.** `scripts/paypal-e2e-stage5.ts`, gated by `--approve-stage5-capture`, with `PAYPAL_MODE=sandbox` and `PAYPAL_SANDBOX_WRITES=authorized` set only in that one process (`.env.local` untouched; the write lock is closed again because the process exited). It ran the engine's own settlement path once (`Orchestrator.advance` from VERIFYING) under an ordered outbound guard of exactly six one-shot rules. Before the live run the same path was pinned offline on a fake SDK (lifecycle test: expired window, no acceptance, five gateway calls, one capture, second drive inert).

| # | Request | Result | PayPal debug id |
|---|---|---|---|
| 1 | POST /v1/oauth2/token | sent (SDK token request; the SDK does not expose a debug id) | - |
| 2 | GET authorization (settlement-decision read) | 200, CREATED | f105708d41ba0 |
| 3 | GET authorization (fresh pre-capture check) | 200, CREATED | f47355242b00d |
| 4 | POST authorization capture, 20.00 USD, `final_capture` true | 201, COMPLETED | f47355289abf3 |
| 5 | GET capture (read-back) | 200, COMPLETED | f493703014924 |
| 6 | GET authorization (reconciliation) | 200, CAPTURED | f83741925e7de |

**Outcome.** Capture `02U8827748683101W`, status `COMPLETED`, amount 20.00 USD, `final_capture` true, `invoice_id` `cmw9owm800004vfoshymk7yir-settle-1`, `PayPal-Request-Id` `cmw9owm800004vfoshymk7yir-CAPTURE-1`. Seller receivable: gross 20.00, PayPal fee 1.19, net 18.81 USD. Authorization `19070882T8512554U` is now `CAPTURED`. Local deal `cmw9owm800004vfoshymk7yir`: `VERIFYING` -> `CAPTURED`, captured amount 20, settlement record `FULL_CAPTURE` earned 100, exactly one `CAPTURE` operation, no void, no refund, 0 acceptance events, 9 ledger events added. Guard: 6 of 6 permitted requests sent, 0 refused. No retry, no second capture, no new order, spike orders and `.spike/state.json` untouched.

**Evidence.** `docs/qa/paypal-e2e-stage5-20261110081759.json` (sanitized; scanned: no token, no client secret, no approval link).

**Afterwards.** The app (port 3000, Sandbox mode, database `mandate_e2e`, all non-loopback requests blocked, write lock closed) and the seller simulator (port 4010) were restarted. No `src/` change was made in this stage (source digest unchanged); tests added: unit 1075 passed (+8), PostgreSQL 658 passed (+1).

**Limits.** This proves the Sandbox authorize-then-capture path end to end with a deterministic expiry-based settlement. It does not exercise an explicit-acceptance event, partial capture, void or refund against real PayPal, and it is Sandbox only: production remains NO-GO and V2 disabled.
