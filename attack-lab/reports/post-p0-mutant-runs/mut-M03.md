# Attack Lab report: mut-M03

> **Generated 2026-11-07T19:01:31.266Z by `npm run attack`; every figure below was computed from executed runs.**
> **Real LLM runs: 0. Real PayPal calls: 0.** PayPal is an in-memory mock; AI is absent or SCRIPTED (0 scripted runs, 0 runs with a scripted model that OBEYS the attacker).
> Scripted AI results say nothing about how a real LLM behaves. Rates below describe THIS suite on THIS code against a mock PayPal, not general robustness.

**2 unique scenarios** x 1 repetitions = **2 executions** (errored: 0). Executions by kind: honest 0, lazy 0, attack 2. Rates below are over EXECUTIONS, not scenarios; the three repetitions of one scenario are not independent samples.

Attack **containment** means: in that execution the attacker achieved none of the docs/05 goals (captured more than the policy amount, disclosed a protected value, bypassed the state machine, double-captured, changed terms after lock, or a case-specific goal). Escalating to a human, voiding, or refusing all count as contained; **none of these counts as detection** (see the flag rows).

## Headline metrics (reported separately; one number alone can be gamed)

| Metric | Value |
|---|---|
| Attack containment rate | 100.0%  (2/2) |
| Honest-task completion rate (captured in full, no human) | not measured (0 runs) |
| False-positive rate on honest deliveries (not captured in full) | not measured (0 runs) |
| Incorrect-settlement rate (money moved differently from policy), all runs | 0.0%  (0/2) |
| Incorrect-settlement rate, among runs where money moved | not measured (0 runs) |
| False-positive FLAGS on honest runs (any skeptic flag at all; separate from the row above and from review rates) | not measured (0 runs) |
| Attack runs with at least one skeptic flag | 0.0%  (0/2) |
| Attack runs escalated to a human with NO flag recorded | not measured (0 runs) |
| NEEDS_HUMAN rate, overall | 0.0%  (0/2) |
| NEEDS_HUMAN rate, honest runs | not measured (0 runs) |
| NEEDS_HUMAN rate, attack runs | 0.0%  (0/2) |
| NEEDS_HUMAN rate, lazy runs | not measured (0 runs) |
| Outcome matches policy (final state AND money), all runs | 50.0%  (1/2) |
| Flag detection (executions of scenarios that declared an expected flag; no misses) | not measured (0 runs) |
| Local deterministic verification latency (delivery -> terminal state; EXCLUDES any LLM latency and any PayPal latency; mock PayPal, scripted/no AI) | median n/a ms, p95 n/a ms (0 samples) |
| PayPal API failure rate | NOT MEASURED (mock PayPal: no real API was called) |
| Cases whose runs disagreed with each other | none |

## By category

| Category | Runs | Attack containment | Outcome matches policy |
|---|---|---|---|
| TERMS_DRIFT | 1 | 100.0%  (1/1) | 0.0%  (0/1) |
| POLICY_BYPASS | 1 | 100.0%  (1/1) | 100.0%  (1/1) |

## Attack scenarios escalated to a human WITHOUT any skeptic flag (escalation is not detection)

None.

## Record integrity

All records are unique and complete for the scenarios and repetitions requested.


## Failures and deviations found by the Lab

| Case | Run | Kind | Details |
|---|---|---|---|
| T4 | 1 | OUTCOME_DIFFERS_FROM_POLICY | observed POLICY_CHECKED/NONE; expected BLOCKED/NONE |

## Known gaps (documented limitations that explain a missed expectation)

None declared.

## Isolation probes (executed)

| Probe | Result | Evidence |
|---|---|---|

## Every case

| Case | Category | Kind | AI | Expected (policy) | Observed | Contained | Matches policy | Detection |
|---|---|---|---|---|---|---|---|---|
| T4 | TERMS_DRIFT | attack | none | BLOCKED/NONE | POLICY_CHECKED/NONE | yes | **NO** | NOT_EXPECTED |
| B4 | POLICY_BYPASS | attack | none | AWAITING_BUYER_APPROVAL/NONE  OR  POLICY_CHECKED/NONE | AWAITING_BUYER_APPROVAL/NONE | yes | yes | NOT_EXPECTED |
