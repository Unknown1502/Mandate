# 10. Settlement Engine (Gate 2)

Code: `src/settlement/engine.ts` (the only module that causes PayPal writes), `src/domain/settlement.ts` (pure decision),
`src/paypal/gateway.ts` (closed result union + real REST adapter, **never run against Sandbox yet**).
Evidence level of everything below: **unit-tested / DB-tested / mock-tested**. Nothing is Sandbox-tested.

## Financial operation lifecycle (`PayPalOperation`)
```
PLANNED ──claim (CAS, attempt++, committed BEFORE the request)──> SENT ──gateway.write──>
   ok        2xx. Status stays SENT until a FRESH GET decides:
               capture COMPLETED                -> CONFIRMED  (deal CAPTURED / PARTIALLY_CAPTURED)
               capture PENDING                  -> CONFIRMED  (deal SETTLEMENT_PENDING; resolved only by later fresh GET)
               capture DECLINED / FAILED        -> FAILED     (money did not move; deal NEEDS_HUMAN; human may plan seq+1)
               void: authorization reads VOIDED -> CONFIRMED  (deal VOIDED); otherwise -> UNKNOWN, deal NEVER reported voided
               unexpected status                -> UNKNOWN    (stays live: blocks any second money operation)
   rejected  definitive 4xx (or a failure raised before sending) -> FAILED (nothing happened)
   unknown   timeout / network / 429 / 5xx / unintelligible reply -> UNKNOWN
UNKNOWN / stale SENT ──reconcile──> GET the PayPal resource FIRST
   resource proves it applied   -> finalize from the GET (no resend)
   resource proves it did not   -> resend with the SAME PayPal-Request-Id and byte-identical body (max 3 sends)
   anything else / cap reached  -> NEEDS_HUMAN, operation stays UNKNOWN
```
* Request id is deterministic: `<dealId>-<TYPE>-<seq>`. A new `seq` (new id) exists only after a definitive FAILED.
* A partial unique index allows at most one non-FAILED `CAPTURE`/`VOID` per deal, and `Settlement.dealId` is unique.
* Every write attempt and every fresh read is a hash-chained ledger event (no credentials).

## Deal states and transitions (generated from `statemachine.ts`)
| From | To |
|---|---|
| PROPOSED | NEGOTIATING |
| NEGOTIATING | TERMS_LOCKED, BLOCKED |
| TERMS_LOCKED | POLICY_CHECKED, BLOCKED |
| POLICY_CHECKED | BLOCKED, NEEDS_HUMAN, ORDER_CREATED |
| NEEDS_HUMAN | ORDER_CREATED, BLOCKED, SETTLING, SETTLEMENT_REVIEW (restricted by `needsHumanFrom`: pre-auth → ORDER_CREATED/BLOCKED; post-auth → SETTLING only; a timed-out challenge → SETTLEMENT_REVIEW only) |
| ORDER_CREATED | AWAITING_BUYER_APPROVAL |
| AWAITING_BUYER_APPROVAL | AUTHORIZED, EXPIRED |
| AUTHORIZED | AWAITING_DELIVERY, VOIDED |
| AWAITING_DELIVERY | DELIVERED, VOIDED |
| DELIVERED | VERIFYING |
| VERIFYING | SETTLING, NEEDS_HUMAN, SETTLEMENT_REVIEW |
| SETTLEMENT_REVIEW | VERIFYING (re-verification), NEEDS_HUMAN (timeout / unresolved). **Never** SETTLING, CAPTURED or VOIDED |
| SETTLING | CAPTURED, PARTIALLY_CAPTURED, VOIDED, SETTLEMENT_PENDING, NEEDS_HUMAN, FAILED |
| SETTLEMENT_PENDING | CAPTURED, PARTIALLY_CAPTURED, NEEDS_HUMAN |
| BLOCKED, CAPTURED, PARTIALLY_CAPTURED, VOIDED, EXPIRED, FAILED | terminal |

`FAILED` is reachable by the table but no Gate 2 code path currently enters it (every failure routes to a human).

## Settlement decision (`decideSettlement`, pure)
Order of rules: invalid authorization → NEEDS_HUMAN · authorized < price → NEEDS_HUMAN · required **deterministic** criterion not met → VOID
· any unverifiable/missing/duplicate/wrong-source result → NEEDS_HUMAN · required LLM criterion not met → NEEDS_HUMAN
· severe deterministic manipulation flag or any HIGH flag → NEEDS_HUMAN · earned 100 → FULL_CAPTURE
· earned ≥ 50 → PARTIAL_CAPTURE = `price × earned / 100` rounded **down** (only if `mandate.allowPartialSettlement` AND `partialCaptureVerified`; else NEEDS_HUMAN)
· earned < 50 with only deterministic failures → VOID, otherwise NEEDS_HUMAN.

### Deliberate deviations from docs/04 §4.6 (all stricter)
1. Any unverifiable criterion (not only required ones) → NEEDS_HUMAN, so a seller is never underpaid on a guess.
2. `injectionPolicy=BLOCK` also yields NEEDS_HUMAN after authorization: a flag alone never voids a valid authorization.
3. Partial capture needs the signed mandate's `allowPartialSettlement` **and** a code-level `partialCaptureVerified` switch (default false) that flips only after Gate 9 evidence.
4. "Unresolved flags" = HIGH severity (either source) or severe deterministic flags; LOW/MED informational flags do not block (protects honest completion rate).

## Post-verification policy (owner ruling 2026-11-06)
1. **No unrestricted human rejection** once mandatory criteria pass. The review decision `reject` no longer exists, and the old
   "human void after a declined capture" override was removed. If mandatory criteria fail, the deterministic engine computes the outcome;
   if they all pass, settlement follows the signed mandate. AI-only flags can escalate to a human but can never void.
2. **Pre-delivery cancellation** is governed by the signed mandate field `allowPreDeliveryCancellation` (human cancels only, only in
   AUTHORIZED / AWAITING_DELIVERY). System cancels (invalid authorization, deadline) are not human cancels and are always allowed.
3. **Challenge** (`challengeVerification`): the owning principal disputes ONE criterion whose recorded result is *met*, giving a reason
   (10-1000 chars) and 1-10 evidence references (`ledger:<seq>` and `delivery:<id>` must exist for this deal; `external:https://...` is stored unverified).
   Strict schema: no amount, no decision. One challenge per criterion, at most 2 per deal. Moves VERIFYING -> SETTLEMENT_REVIEW, which pauses settlement.
4. **Re-verification** (`recordReverification`, system-side only; Gate 4 will call it): fresh results against the ORIGINAL locked terms plus new evidence
   references; the previous verification is preserved in the ledger by hash. Returns to VERIFYING; the engine decides; the challenge window is not reopened.
5. **Timeout** (`expireOverdueReviews`): an overdue challenge goes to NEEDS_HUMAN (origin SETTLEMENT_REVIEW). The only human option is `resume_review`.
   Nothing in this path can capture or void.
6. **Challenge window**: after a verification that would pay the seller, capture waits `challengeWindowMs` (default 15 min; tests use 0) so the
   principal can challenge. A VOID caused by a failed contract is not delayed.
7. **Human verdicts** remain, but only on criteria machines could not resolve (unverifiable/missing, or an LLM-judged failure asserted only by a verifier).
   A human *not_met* verdict on a required criterion lets the **engine** compute VOID; a passed criterion can only be disputed via a challenge.
8. **Retry** is allowed only when the last money operation is FAILED, and re-plans the same immutable settlement (never an amount from a human).

## Known UNVERIFIED assumptions (resolve in Gate 9)
* Idempotent replay of an identical `PayPal-Request-Id` (create/authorize/capture/void) returns the original result.
* Void success status and body (assumed 2xx; the engine only trusts the fresh GET).
* Authorization status after a `final_capture: true` partial capture, and whether the remainder is released. The engine does **not** void a remainder.
* Capture resources appear under the order's `payments.captures[]` with the `invoice_id` we sent (used by reconcile).
* Documented status strings in `src/paypal/statuses.ts` other than `PAYER_ACTION_REQUIRED` (observed).
* Authorization `expiration_time` is present on the authorization resource.
* A declined capture leaves the authorization usable.

## Mutation testing record
* Settlement engine, round 1 (14 mutants): 12 killed. **M5** (attempt cap removed from `claim`) and **M14** (stale-SENT demotion early return removed) survived.
  They are labelled **masked / redundant-guard mutants**: a second independent guard (reconcile's `canResend`; `claim` accepting only `UNKNOWN`) covers the same
  invariant, so removing one is invisible to the tests. **Formal equivalence has NOT been established**, so they are neither counted as kills nor claimed equivalent.
* M6 and M10 of round 1 were superseded by the policy change (the `reject` and deterministic-verdict rules were rewritten); their intent is now covered by P4 and P7.
* Review policy, round 2 (12 mutants P1-P12: challenge preconditions, window, cancellation term, `reject` re-introduced, evidence existence, duplicate challenge,
  verdict scope, timeout deadline, settle-from-review, human-verdict VOID, state-machine jump, terms-drift check): **12 killed**.
