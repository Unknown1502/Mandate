# 13. Orchestration and Integration (Gate 5)

Evidence level of everything below: **unit-tested / DB-tested (real PostgreSQL) / mock-tested (PayPal) / scripted (AI)**.
**No PayPal operation was performed. No real LLM was run.** The orchestrator cannot call PayPal: it never imports the engine, the gateway or `src/paypal`.

> Roadmap note: `docs/07-roadmap.md` lists "Phase 5 = Attack Lab". The owner redefined Gate 5 as orchestration/integration; the Attack Lab is deferred. docs/09 records this.

## Integration architecture
```
                         +--------------------------- Orchestrator (src/orchestration/service.ts) ---------------------------+
 principal / seller ---> | integrity preflight -> state check -> idempotent step -> (domain | verification | SettlementPort) |
                         +-------------------------------------------------------------------------------------------------+
   domain services (Gate 1)      negotiation (Gate 3)        delivery + verification (Gate 4)         SettlementPort (interface)
   createDeal/checkPolicy/       runNegotiation              submitDelivery / verifyDelivery           src/orchestration/ports.ts
   reserveForDeal/lockTerms                                                                                   |
                                                                                                  src/settlement/port.ts   <- the ONLY bridge
                                                                                                              |
                                                                           Settlement Engine (Gate 2): decisions, amounts, PayPal operations
```
* **Port, not engine.** `SettlementPort` exposes `createOrder, refreshApproval, submitVerification, requestSettlement, submitChallenge, submitReviewDecision, expireOverdueReviews, reconcileDeal, cancelForDeadline`.
  There is no capture, void, amount or PayPal identifier in the interface or the orchestrator (enforced by `tests/unit/orchestration-isolation.test.ts`; `src/settlement/port.ts` is the only file importing both).
* **Settlement instruction** = `{kind:"SETTLE", dealId, verificationId, termsHash, resultHash, idempotencyKey}` (strict Zod). The port re-checks it against what the engine actually holds (terms hash, the latest `VERIFICATION_SUBMITTED` event) and answers `STALE_INSTRUCTION`/`INSTRUCTION_INVALID` otherwise. The engine still applies its own rules (strict authorization validation, challenge window, deterministic decision, persisted operation, GET-first reconciliation).
* **Integrity preflight** before every step (`integrity.ts`): sealed mandate verifies AND equals the digest recorded at `DEAL_CREATED`; locked terms still equal the hash recorded in the ledger at lock time (not just the deal's own columns); the hash chain verifies. Failure => `HALTED` (one ledger entry per distinct reason); nothing is sent to the engine; no money moves.
* **Authoritative result** (`settle()`): latest `VerificationRun`, schema-valid, `resultHash` recomputed and equal to the stored column, bound to this deal, terms hash and artifact hash. A mismatch halts (`RESULT_TAMPERED`) before any instruction exists.

## State transition map (what the orchestrator does in each state)
| Deal state | Orchestrator action | Gate that decides |
|---|---|---|
| TERMS_LOCKED | `checkPolicy` | Gate 1 policy engine |
| POLICY_CHECKED | `reserveForDeal` (atomic) -> `port.createOrder` | Gate 1 / Gate 2 |
| NEEDS_HUMAN (pre-auth) | wait for `preAuthDecision`; after approval + reservation -> `createOrder` | owner |
| AWAITING_BUYER_APPROVAL | `port.refreshApproval` (polls PayPal; WAITING until the buyer approves) | buyer in PayPal |
| AWAITING_DELIVERY | wait; after the deadline -> `port.cancelForDeadline` (system cancel) | Gate 2 |
| DELIVERED | `verifyDelivery(seq 1)` -> `port.submitVerification` | Gate 4 / Gate 2 intake |
| VERIFYING | validate result -> `port.requestSettlement` (engine enforces the challenge window) | Gate 2 |
| SETTLEMENT_REVIEW | not overdue: `verifyDelivery(seq n+1, challenge evidence)` -> submit; overdue: `expireOverdueReviews` | Gate 4 / Gate 2 |
| NEEDS_HUMAN (post-auth) | wait for `reviewDecision` (verdicts / retry / resume_review) | owner, via engine |
| SETTLING / SETTLEMENT_PENDING | `port.reconcileDeal` (engine's GET-first reconciliation) | Gate 2 |
| CAPTURED / PARTIALLY_CAPTURED / VOIDED / BLOCKED / EXPIRED / FAILED | none (DONE) | - |

`advance(dealId)` repeats single steps until the state stops changing; it reports `DONE | WAITING | NEEDS_HUMAN | HALTED | IN_PROGRESS | REFUSED`, with `nextCheckAt`/`approvalUrl` where relevant.

## Idempotency boundaries (each layer is idempotent on its own; the orchestrator adds a durable record)
| Boundary | Mechanism |
|---|---|
| Orchestration step | `OrchestrationStep` unique `(dealId, step, key)`; COMPLETED steps are replayed, never re-run; OPEN steps (waiting/in doubt) re-run; STARTED + expired lease => ONE takeover (atomic CAS) |
| Delivery | key = hash of the canonical manifest; `Delivery` unique per deal; identical manifest+file is a no-op; refusals for transient reasons are not final |
| Verification | `VerificationClaim` unique `(deliveryId, sequence)` with a lease (**atomic claim before any AI call**) + `VerificationRun` unique `(deliveryId, sequence)` |
| Submission to Gate 2 | `VERIFICATION_SUBMITTED` ledger event per `verificationId` |
| Challenge | key = hash(deal, canonical challenge); engine: one per criterion, max 2, state CAS |
| Settlement | step key = `verificationId`; engine: `Settlement` unique per deal, one live CAPTURE/VOID (partial unique index), operation planned+persisted before any request |
| Ledger | a step's outcome is appended once, when it completes; replays and polling append nothing |

## Human challenge lifecycle
`VERIFYING` -- owner challenges one passed criterion (reason + evidence refs that exist for this deal) --> `SETTLEMENT_REVIEW` (settlement paused) --> orchestrator re-verifies the SAME artifact against the ORIGINAL locked terms (sequence n+1, challenge evidence recorded) and submits it --> `VERIFYING` (window not reopened) --> engine decides.
Previous `VerificationRun`s are immutable and preserved. If re-verification cannot complete, the review times out into `NEEDS_HUMAN` (reason `REVIEW_TIMEOUT`) and the only human option is `resume_review`; neither the timeout nor repeated sweeps can capture or void. A challenge racing a settlement is resolved by the engine's compare-and-set: either the challenge is refused, or its review strictly precedes settlement.

## Recovery behaviour
* **In-doubt settlement** (lost response, timeout): deal stays `SETTLING`; `advance`/`sweep` run `reconcileDeal`, which reads the PayPal resource first and only ever re-sends with the SAME request id (Gate 2). A brand-new orchestrator over the same database recovered a capture whose response was lost with exactly one PayPal write.
* **Crashed worker** (dead lease): the step is taken over once after the lease expires; a live lease is respected. A crash after the engine settled but before the step was recorded does not settle again (state is terminal / `SETTLEMENT_ALREADY_DECIDED`).
* **Crashed verifier**: its claim lease expires and ONE other caller takes over; a live claim blocks everyone (no AI call); a failed verification releases its claim.
* **Sweep fairness**: `sweep()` serves in urgency order (in-doubt settlements first, pure waiting last; `AWAITING_DELIVERY` only past its deadline) because waiting deals never update and would otherwise starve recovery. `sweep(limit, only)` can be scoped.

## Known limitations
* Real LLM behaviour is UNVERIFIED. `npm run llm:smoke` exists but checks only connectivity + strict-schema output and reported **NOT CONFIGURED** (no key). It is not a security/robustness result.
* All PayPal behaviour is still mock-tested; Gate 2's UNVERIFIED list (docs/10) is unchanged. Immediate reconciliation after a timeout is safe by design (GET-first) but its behaviour against real PayPal eventual consistency is unknown.
* The orchestrator is in-process and pull-based: nothing schedules `sweep()` yet (no cron/worker, no webhook), so progress needs a caller. `advance` caps at 14 steps per call.
* Sweep ordering is by `updatedAt` within a priority group; with more than `limit` stuck deals in one group, rotation is not guaranteed.
* A HALTED deal needs a human/operator; there is no automatic or UI path to resume it. Halting is deliberately conservative: it never moves money, but it can also leave a valid authorization to expire.
* `expireOverdueReviews` is global (all deals), by Gate 2 design; the orchestrator calls it with its own clock.
* Pre-authorization human review (`preAuthDecision`) is wired but not covered by an orchestrator-level test (covered in Gate 1/2 tests); autonomous negotiation keeps prices under the human threshold so it normally does not occur.
* No UI, no webhook receiver, no deployment. Authentication/CSRF exist at the Phase 0 routes only; the orchestrator takes an already-authenticated `Actor` from its caller.
