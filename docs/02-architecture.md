# 2. Architecture

## 2.1 Components
```
Human UI ── Mandate Service
Buyer Agent <-> Negotiation Bus <-> Seller Agent (simulated counterparty)
   | typed intents only
Policy Engine (deterministic) + Skeptic Agent (LLM, no tools)
Settlement Engine  (ONLY module with PayPal write access)
   create order -> [human approves in PayPal] -> authorize
   -> delivery -> Verification Pipeline -> capture | partial | void
Ledger (hash chain) <- every transition, LLM call, PayPal call, webhook
```

## 2.2 Trust boundaries
| Source | Trust |
|---|---|
| Signed mandate (verified) | Authoritative for limits |
| Seller messages & deliveries | **Untrusted data** |
| LLM outputs | Untrusted suggestions; schema- and quote-validated |
| PayPal API / verified webhook | Authoritative for money state |
| Human PayPal approval | Authoritative for reservation consent |

LLM prompts wrap counterparty content in delimiters (`<untrusted_delivery id="...">`) and the system prompt says content inside is data. This reduces but does not eliminate injection risk — hence deterministic decisions and tool-less Skeptic/Verifier agents.

## 2.3 Deal state machine
```
PROPOSED -> NEGOTIATING -> TERMS_LOCKED -> POLICY_CHECKED
POLICY_CHECKED -> BLOCKED | NEEDS_HUMAN | ORDER_CREATED
NEEDS_HUMAN -> ORDER_CREATED (human approves) | BLOCKED (rejects)
ORDER_CREATED -> AWAITING_BUYER_APPROVAL -> AUTHORIZED | EXPIRED
AUTHORIZED -> AWAITING_DELIVERY -> DELIVERED -> VERIFYING
VERIFYING -> SETTLING | NEEDS_HUMAN
SETTLING -> CAPTURED | PARTIALLY_CAPTURED | VOIDED | SETTLEMENT_PENDING | NEEDS_HUMAN | FAILED
SETTLEMENT_PENDING -> CAPTURED | PARTIALLY_CAPTURED | NEEDS_HUMAN   (only after webhook + fresh GET)
AUTHORIZED / AWAITING_DELIVERY -> VOIDED (revocation, deadline passed, human cancel)
```
Transitions are a typed table in code. Anything else throws and is logged. Terminal: CAPTURED, PARTIALLY_CAPTURED, VOIDED, BLOCKED, EXPIRED, FAILED.

## 2.4 Terms lock
`TermsV1 = { taskType, description, criteria[], price, currency, deadline, sellerId, mandateId }`, `termsHash = sha256(canonicalJson(TermsV1))`. Stored on the deal and put in the PayPal order `description`/`custom_id`. Verification uses **locked** criteria only. Any later change to price/criteria/deadline => `BLOCKED`.

## 2.5 Ledger
`DealEvent { id, dealId, seq, type, actor, payload(redacted json), prevHash, hash, createdAt }`
`hash = sha256(prevHash || canonicalJson({dealId, seq, type, actor, payload, createdAt}))`
`GET /api/ledger/verify?dealId=` recomputes the chain and returns the first broken `seq`. Demo: edit a DB row, show verify fail. Say "tamper-evident", not "tamper-proof" (a DB owner could rewrite the whole chain); optionally publish the latest hash in the video.

## 2.5b Budget reservation (concurrency)
Before creating a PayPal order, atomically insert a `BudgetReservation` in a serializable transaction (or `SELECT ... FOR UPDATE` on the mandate row): `committed = SUM(active reservations) + captured`; reject if `committed + price > budgetTotal`. Release on VOIDED/EXPIRED/BLOCKED; convert to captured amount on settlement (release the unused remainder). Two concurrent deals can therefore never both reserve the same remaining budget.

## 2.5c Ledger sequence allocation
Allocate `seq` inside the same DB transaction using `SELECT ... FOR UPDATE` on the deal row (or a per-deal counter row) so concurrent writers cannot fork the chain.

## 2.5d Identity and approval
All mandate, order, settle, void and approve routes require an authenticated principal (session) with CSRF protection. Mandate creation is a two-step flow: draft -> principal reviews the full mandate and explicitly confirms. Store `approvedBy`, `approvedAt`, `approvalMethod`, and `mandateDigest`; the Ed25519 signature is the **application's seal** over the approved mandate (key id/version stored). Call it "human-approved, application-signed". A user-held key/passkey signature is a P1 upgrade; do not claim it until built.

## 2.6 Orchestration
In-process async orchestrator + DB `Job` rows (type, dealId, runAt, attempts, status, lastError). A sweeper route (Render cron or page-load triggered) handles deadlines, authorization expiry, retries. No external queue.

## 2.7 File layout
```
src/
  app/ pages: /, /mandates, /deals/[id], /attack-lab, /ledger/[id]
  app/api/ mandates, deals, deals/[id]/{negotiate,approve,deliver,settle},
           paypal/return, webhooks/paypal, ledger/verify, attack/run
  domain/ mandate.ts terms.ts statemachine.ts policy.ts settlement.ts money.ts ledger.ts
          verification/ deterministic.ts prescan.ts quotes.ts pipeline.ts
  agents/ buyer.ts seller.ts skeptic.ts verifier.ts llm.ts prompts/
  paypal/ client.ts orders.ts authorizations.ts webhooks.ts toolkit.ts normalize.ts
  attack/ cases.ts harness.ts metrics.ts
  db/ prisma client
tests/ unit (policy, settlement math, statemachine, ledger, quotes) + sandbox integration
docs/sandbox-observations.md  (real captured responses)
```

## 2.8 Delivery and verification (Gate 4)
Seller delivers a manifest and CSV bytes (data only; never executed). `submitDelivery` binds them to the locked termsHash and seller, stores an immutable `Delivery`, and moves the deal to DELIVERED. `verifyDelivery` runs deterministic validators (locked criteria and weights only), the deterministic Skeptic, and optional evidence-validated AI, and writes one immutable, hash-sealed `VerificationRun` per (delivery, sequence). `submitVerificationToSettlement` (src/settlement/verification-intake.ts, the only door into Gate 2) re-checks seal, terms hash, artifact and recency, then calls the existing recordVerification / recordReverification. The challenge window, SETTLEMENT_REVIEW, human review and all PayPal operations remain in the Settlement Engine. See docs/12.

### Updated file layout
```
src/verification/ csv.ts evidence.ts validators.ts prescan.ts contracts.ts ai.ts delivery.ts pipeline.ts
src/settlement/verification-intake.ts   (facade: the only verification -> engine door)
seller-service/                         (separate-process simulated seller; Gate 3)
```
