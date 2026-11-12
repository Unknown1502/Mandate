# 9. Implementation Plan and Decisions (post-Phase 1 direction change)

## 9.1 Owner decision record
- **2026-11-05, project owner:** proceed through the full roadmap without waiting for the manual buyer approvals.
  This is the explicit, documented fallback required by the master prompt for proceeding past an unfinished
  Phase 1 gate. **The Phase 1 gate is NOT passed.** Everything that depends on real PayPal behaviour
  (authorize, capture, partial capture, remainder, void, idempotent repeat, webhooks) is **UNVERIFIED** until it
  is exercised against Sandbox, and the design may need to change when it is.
- **Financial restriction:** the four Sandbox orders in `.spike/state.json` (run 202611051725) are not authorized,
  captured or voided by any code path until the owner approves checkout and a fresh PayPal GET reports `APPROVED`.
  `scripts/spike` already refuses to authorize an order that is not `APPROVED`. Application code never reads `.spike/`.

## 9.2 Spec additions (consistent with docs, but not spelled out there)
1. State machine adds `NEGOTIATING|TERMS_LOCKED|POLICY_CHECKED -> BLOCKED` (walk-away, rounds exceeded, terms drift).
2. `NEEDS_HUMAN` records its origin (`needsHumanFrom`). Pre-authorization origin may only resolve to
   `ORDER_CREATED` (approve) or `BLOCKED` (reject). Post-authorization origin may only resolve to `SETTLING`.
   A human decision never supplies an amount: the amount is always recomputed deterministically.
3. Reservation `amount` is rewritten to the captured amount on conversion, so `committed = SUM(amount WHERE status IN (ACTIVE, CONVERTED))`.
4. Mandate approval is two-step: the server computes the mandate digest for a draft; approval requires the caller to
   echo that digest. No mandate row exists before approval.
5. Seller Agent is a **separate Node HTTP process** (`seller-service/`) with its own scoped context and no access to
   the database, mandate, PayPal or buyer prompts. On Render it is a second web service.

## 9.3 Internal gates (each needs tests + evidence before it is called passed)
| # | Gate | Status |
|---|---|---|
| 1 | Core domain + DB | **PASSED 2026-11-05**: 80 unit + 27 DB tests (real Postgres `mandate_test`), typecheck/lint clean, concurrency test mutation-checked (removing the mandate lock makes it fail: 10 reservations instead of 5) |
| 2 | Settlement Engine (mock PayPal only) | **PASSED for deterministic logic, 2026-11-06** (see docs/10): 116 unit + 77 DB tests; 12/14 mutants killed, 2 equivalent. Real PayPal behaviour UNVERIFIED (Gate 9) |
| 3 | Agent negotiation (Buyer, separate-process simulated Seller, orchestrator) | **PASSED for deterministic logic, 2026-11-06** (see docs/11): 169 unit + 127 DB tests; 15/15 mutants killed. No real LLM run (UNVERIFIED) |
| 4 | Delivery + verification (CSV ingestion, validators, evidence, scripted-AI verifier/skeptic, Gate 2 intake) | **PASSED for deterministic logic, 2026-11-06** (see docs/12): 270 unit + 212 DB tests; 22/22 code mutants + DB-trigger mutant killed. No PayPal call; no real LLM run (UNVERIFIED) |
| 5 | Orchestration + human review integration (owner-redefined; roadmap Phase 5 Attack Lab deferred) | **PASSED for deterministic logic, 2026-11-06** (see docs/13): 282 unit + 244 DB tests; 18/18 mutants killed. No PayPal call; no real LLM run (UNVERIFIED) |
| 5c | **P0 - V1 model isolation (W1), owner-approved 2026-11-07** (docs/15 §15.9.0, §15.21; docs/14 §14.26) | **IMPLEMENTED (PASS) for V1 deals; P1+ NOT started.** V1 deals never reach a verifier or skeptic; 21 canary probes: 0 model calls. Not a real-LLM or V2 claim. Lab numbers in 5b predate P0. | 
| 5f | **P3 + P4 + P5 + P7 - V2 lifecycle, owner directive 2026-11-08** (docs/16) | **IMPLEMENTED on mock PayPal + scripted models + `mandate_test` only.** P3 PASS (V2 writers, TermsAttestation, atomic two-step approval), P4 PASS (ModelRunner boundary, restricted inputs, language assessment, evidence scoping, binding), P5 PASS for existing surfaces (central authorization re-derivation incl. pre-send capture guard, reservation sweeper, HTTP hardening), P7 PASS for the mechanism (governed detector releases; no real native-speaker review). AI-judged V2 criteria are OFF by default (Q3/Q5 unresolved). Final-directive additions (2026-11-09): signed **V2 release gate (V2 CLOSED; no record issued)**, V2 negotiation (price only), runner pre-flight checks, immutable terms history, detector-pin mirrors; mutation layers A-G 221/221 killed, unit 933, PostgreSQL 562 (docs/16 s16.17-16.21). Real-LLM, real-PayPal and production NOT DONE. P6, webhooks, UI, deployment NOT started. |
| 5e | **P2 - V2 seal VERIFIER, owner-approved 2026-11-08** (docs/15 s15.24) | **IMPLEMENTED as an isolated, operationally DISABLED verifier (see docs/15 s15.24 for evidence); P3+ NOT started.** Verifies a purpose-bound V2 seal against an explicit key registry; no V2 writer, no V2 terms, no database change, not imported by any live path. |
| 5d | **P1 - forward-compatibility guards, owner-approved 2026-11-08** (docs/15 s15.23) | **IMPLEMENTED (see docs/15 s15.23 for evidence); P2+ NOT started.** Strict, version-aware readers for mandate documents (3 known V1 shapes), locked terms and the session token; unknown versions / fields / duplicate keys refused; no V2 writer exists. |
| 5b | **Roadmap Phase 5: Attack Lab** (mock PayPal, scripted AI only) | **PARTIAL, gap closure 2026-11-07** (docs/14 §14.20-14.25): 113 scenarios x 3 = 339 executions on real PostgreSQL; containment 294/294, honest completion 33/33, false-positive flags 0/33, incorrect settlement 0/339; 29/29 Lab mutants killed; criterion-scoped language policy (text a model can read, only when the terms contain an LLM-judged criterion; unreadable or uncertain text is never sent to a model and forces the criterion UNVERIFIABLE; withheld columns via deployment config); prescan has a deterministic work budget + deadline and the reported 32 s input is not admissible through the 200 KB intake cap (now bounded at under 1 s with SCAN_INCOMPLETE); 491 unit + 368 DB tests. **OPEN:** short instructions in languages outside the 13-language override vocabulary pass as data (G26/G27); no per-criterion field list; no mandate-level language setting. Real LLM and real PayPal behaviour UNVERIFIED. Awaiting owner review |
| 6 | Webhook receiver | pending |
| 7 | Frontend + audit timeline | pending |
| 8 | Render deployment | pending (needs owner's Render account) |
| 9 | End-to-end Sandbox | blocked on owner approvals |
| 10 | Security review + submission readiness | pending |

## 9.4 File plan
**Gate 1 (core):** `prisma/schema.prisma` (+migration 2) · `src/domain/{money,canonical,signing,mandate,terms,statemachine,policy,ledger,budget,deals}.ts` · `scripts/gen-keys.ts` · `tests/unit/*` (pure) · `tests/db/*` (real Postgres, test database).
**Gate 2:** `src/settlement/engine.ts` (only module importing PayPal write functions) · `src/paypal/{orders,authorizations}.ts` · `src/settlement/operations.ts` (PayPalOperation persistence + reconciler).
**Gate 3:** `src/agents/{llm,buyer,skeptic,verifier}.ts`, `src/agents/prompts/*`, `seller-service/*`, `src/domain/negotiation.ts`.
**Gate 4:** `src/domain/verification/{deterministic,prescan,quotes,pipeline}.ts`, `src/domain/tasks/data-cleaning.ts`.
**Gate 5:** `src/domain/settlement.ts` (pure) · human-review routes.
**Gate 6:** `src/app/api/webhooks/paypal/route.ts`, `src/paypal/webhooks.ts`, `src/jobs/*`, `scripts/register-webhook.ts`.
**Gate 7:** `src/app/(app)/*` pages + shadcn/ui components, `src/app/api/{mandates,deals,ledger}/*`.
**Gate 8:** `render.yaml`, `Dockerfile` (if needed), `scripts/start.sh`.
**Gates 9–10:** `docs/sandbox-observations.md`, `attack/*`, security review report, README.

## 9.5 Reporting vocabulary
Implemented · Unit-tested (pure logic) · DB-tested (real Postgres) · Mock-tested (stubbed fetch/LLM) ·
Sandbox-tested (real PayPal) · Deployed · Not verified. Mocked results are never labelled Sandbox results.

## 9.6 Gate 5: integration summary (details in docs/13)
* **Integration architecture:** Orchestrator (application layer) -> domain services / negotiation / delivery + verification / `SettlementPort` -> (`src/settlement/port.ts`, the only bridge) -> Settlement Engine -> PayPal (mock until Gate 9). The orchestrator imports no PayPal, gateway or engine code.
* **State transition map:** see docs/13 table (one orchestrator action per deal state; every money decision stays in Gate 2).
* **Idempotency boundaries:** orchestration step (`OrchestrationStep`), delivery (manifest hash), verification (`VerificationClaim` + `VerificationRun`), submission (`VERIFICATION_SUBMITTED`), challenge, settlement (`Settlement` + live-operation index), ledger (once per completed step).
* **Human challenge lifecycle:** challenge -> SETTLEMENT_REVIEW -> re-verification of the same artifact against the original terms -> VERIFYING -> engine decides; timeout -> NEEDS_HUMAN -> resume_review.
* **Recovery behaviour:** GET-first reconciliation of in-doubt settlements by a fresh process; lease-based takeover of crashed steps and crashed verification claims; urgency-ordered sweep.
* **Known limitations:** no scheduler/webhook/UI; real LLM and real PayPal behaviour UNVERIFIED; HALTED deals need an operator.
* **Roadmap note:** docs/07's "Phase 5 = Attack Lab" was deferred while the owner-defined Gate 5 (orchestration) was built. The Attack Lab has been built, run, and remediated (docs/14, row 5b). Its figures are mock-PayPal / scripted-AI results and must not be quoted as real-LLM or Sandbox block rates. Remaining before any "measured block rate" claim: owner decisions on short instructions in unlisted languages, per-criterion field lists and a mandate-level language setting (docs/14 §14.24-14.25), and real-LLM and real-PayPal validation.
