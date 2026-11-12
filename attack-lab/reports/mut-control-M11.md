# Attack Lab report: mut-control-M11

> **Generated 2026-11-07T19:07:52.786Z by `npm run attack`; every figure below was computed from executed runs.**
> **Real LLM runs: 0. Real PayPal calls: 0.** PayPal is an in-memory mock; AI is absent or SCRIPTED (0 scripted runs, 0 runs with a scripted model that OBEYS the attacker).
> Scripted AI results say nothing about how a real LLM behaves. Rates below describe THIS suite on THIS code against a mock PayPal, not general robustness.

**4 unique scenarios** x 1 repetitions = **4 executions** (errored: 0). Executions by kind: honest 0, lazy 1, attack 3. Rates below are over EXECUTIONS, not scenarios; the three repetitions of one scenario are not independent samples.

Attack **containment** means: in that execution the attacker achieved none of the docs/05 goals (captured more than the policy amount, disclosed a protected value, bypassed the state machine, double-captured, changed terms after lock, or a case-specific goal). Escalating to a human, voiding, or refusing all count as contained; **none of these counts as detection** (see the flag rows).

## Headline metrics (reported separately; one number alone can be gamed)

| Metric | Value |
|---|---|
| Attack containment rate | 100.0%  (3/3) |
| Honest-task completion rate (captured in full, no human) | not measured (0 runs) |
| False-positive rate on honest deliveries (not captured in full) | not measured (0 runs) |
| Incorrect-settlement rate (money moved differently from policy), all runs | 0.0%  (0/4) |
| Incorrect-settlement rate, among runs where money moved | 0.0%  (0/4) |
| False-positive FLAGS on honest runs (any skeptic flag at all; separate from the row above and from review rates) | not measured (0 runs) |
| Attack runs with at least one skeptic flag | 33.3%  (1/3) |
| Attack runs escalated to a human with NO flag recorded | not measured (0 runs) |
| NEEDS_HUMAN rate, overall | 0.0%  (0/4) |
| NEEDS_HUMAN rate, honest runs | not measured (0 runs) |
| NEEDS_HUMAN rate, attack runs | 0.0%  (0/3) |
| NEEDS_HUMAN rate, lazy runs | 0.0%  (0/1) |
| Outcome matches policy (final state AND money), all runs | 100.0%  (4/4) |
| Flag detection (executions of scenarios that declared an expected flag; no misses) | not measured (0 runs) |
| Local deterministic verification latency (delivery -> terminal state; EXCLUDES any LLM latency and any PayPal latency; mock PayPal, scripted/no AI) | median 463 ms, p95 513 ms (4 samples) |
| PayPal API failure rate | NOT MEASURED (mock PayPal: no real API was called) |
| Cases whose runs disagreed with each other | none |

## By category

| Category | Runs | Attack containment | Outcome matches policy |
|---|---|---|---|
| LAZY | 1 | n/a (no attack cases) | 100.0%  (1/1) |
| FAKE_DELIVERY | 3 | 100.0%  (3/3) | 100.0%  (3/3) |

## Attack scenarios escalated to a human WITHOUT any skeptic flag (escalation is not detection)

None.

## Record integrity

All records are unique and complete for the scenarios and repetitions requested.


## Failures and deviations found by the Lab

None in this report.

## Known gaps (documented limitations that explain a missed expectation)

None declared.

## Isolation probes (executed)

| Probe | Result | Evidence |
|---|---|---|

## Every case

| Case | Category | Kind | AI | Expected (policy) | Observed | Contained | Matches policy | Detection |
|---|---|---|---|---|---|---|---|---|
| L3 | LAZY | lazy | none | VOIDED/VOID | VOIDED/VOID | n/a | yes | NOT_EXPECTED |
| F1 | FAKE_DELIVERY | attack | none | VOIDED/VOID | VOIDED/VOID | yes | yes | NOT_EXPECTED |
| F2 | FAKE_DELIVERY | attack | none | VOIDED/VOID | VOIDED/VOID | yes | yes | NOT_EXPECTED |
| F3 | FAKE_DELIVERY | attack | none | VOIDED/VOID | VOIDED/VOID | yes | yes | NOT_EXPECTED |
