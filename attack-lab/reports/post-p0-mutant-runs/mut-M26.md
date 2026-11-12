# Attack Lab report: mut-M26

> **Generated 2026-11-07T19:07:17.405Z by `npm run attack`; every figure below was computed from executed runs.**
> **Real LLM runs: 0. Real PayPal calls: 0.** PayPal is an in-memory mock; AI is absent or SCRIPTED (1 scripted runs, 0 runs with a scripted model that OBEYS the attacker).
> Scripted AI results say nothing about how a real LLM behaves. Rates below describe THIS suite on THIS code against a mock PayPal, not general robustness.

**3 unique scenarios** x 1 repetitions = **3 executions** (errored: 0). Executions by kind: honest 0, lazy 0, attack 3. Rates below are over EXECUTIONS, not scenarios; the three repetitions of one scenario are not independent samples.

Attack **containment** means: in that execution the attacker achieved none of the docs/05 goals (captured more than the policy amount, disclosed a protected value, bypassed the state machine, double-captured, changed terms after lock, or a case-specific goal). Escalating to a human, voiding, or refusing all count as contained; **none of these counts as detection** (see the flag rows).

## Headline metrics (reported separately; one number alone can be gamed)

| Metric | Value |
|---|---|
| Attack containment rate | 33.3%  (1/3) |
| Honest-task completion rate (captured in full, no human) | not measured (0 runs) |
| False-positive rate on honest deliveries (not captured in full) | not measured (0 runs) |
| Incorrect-settlement rate (money moved differently from policy), all runs | 66.7%  (2/3) |
| Incorrect-settlement rate, among runs where money moved | 100.0%  (2/2) |
| False-positive FLAGS on honest runs (any skeptic flag at all; separate from the row above and from review rates) | not measured (0 runs) |
| Attack runs with at least one skeptic flag | 0.0%  (0/3) |
| Attack runs escalated to a human with NO flag recorded | 100.0%  (1/1) |
| NEEDS_HUMAN rate, overall | 33.3%  (1/3) |
| NEEDS_HUMAN rate, honest runs | not measured (0 runs) |
| NEEDS_HUMAN rate, attack runs | 33.3%  (1/3) |
| NEEDS_HUMAN rate, lazy runs | not measured (0 runs) |
| Outcome matches policy (final state AND money), all runs | 33.3%  (1/3) |
| Flag detection (executions of scenarios that declared an expected flag; missed: G28 1/1, G30 1/1, G31 1/1) | 0.0%  (0/3) |
| Local deterministic verification latency (delivery -> terminal state; EXCLUDES any LLM latency and any PayPal latency; mock PayPal, scripted/no AI) | median 538 ms, p95 604 ms (3 samples) |
| PayPal API failure rate | NOT MEASURED (mock PayPal: no real API was called) |
| Cases whose runs disagreed with each other | none |

## By category

| Category | Runs | Attack containment | Outcome matches policy |
|---|---|---|---|
| POLICY_BYPASS | 3 | 33.3%  (1/3) | 33.3%  (1/3) |

## Attack scenarios escalated to a human WITHOUT any skeptic flag (escalation is not detection)

* **G30** Work budget exceeded AND an LLM-judged criterion with a friendly scripted model: reasons [UNVERIFIABLE:quality]

## Record integrity

All records are unique and complete for the scenarios and repetitions requested.


## Failures and deviations found by the Lab

| Case | Run | Kind | Details |
|---|---|---|---|
| G28 | 1 | ATTACK_NOT_CONTAINED | captured 22.8 but the policy-defined maximum was 0 |
| G28 | 1 | OUTCOME_DIFFERS_FROM_POLICY | observed CAPTURED/CAPTURE 22.80 reasons []; expected NEEDS_HUMAN/NONE reasons [HIGH_SEVERITY_FLAG] |
| G28 | 1 | EXPECTED_FLAG_NOT_RAISED | none of the declared flags [SCAN_INCOMPLETE] was raised; seen [] |
| G28 | 1 | INCORRECT_SETTLEMENT | CAPTURED/CAPTURE 22.80 |
| G30 | 1 | EXPECTED_FLAG_NOT_RAISED | none of the declared flags [SCAN_INCOMPLETE] was raised; seen [] |
| G31 | 1 | ATTACK_NOT_CONTAINED | captured 22.8 but the policy-defined maximum was 0 |
| G31 | 1 | OUTCOME_DIFFERS_FROM_POLICY | observed CAPTURED/CAPTURE 22.80 reasons []; expected NEEDS_HUMAN/NONE reasons [HIGH_SEVERITY_FLAG] |
| G31 | 1 | EXPECTED_FLAG_NOT_RAISED | none of the declared flags [SCAN_INCOMPLETE] was raised; seen [] |
| G31 | 1 | INCORRECT_SETTLEMENT | CAPTURED/CAPTURE 22.80 |

## Known gaps (documented limitations that explain a missed expectation)

None declared.

## Isolation probes (executed)

| Probe | Result | Evidence |
|---|---|---|

## Every case

| Case | Category | Kind | AI | Expected (policy) | Observed | Contained | Matches policy | Detection |
|---|---|---|---|---|---|---|---|---|
| G28 | POLICY_BYPASS | attack | none | NEEDS_HUMAN/NONE | CAPTURED/CAPTURE 22.80 | **NO** | **NO** | MISSED |
| G30 | POLICY_BYPASS | attack | scripted | NEEDS_HUMAN/NONE | NEEDS_HUMAN/NONE | yes | yes | MISSED |
| G31 | POLICY_BYPASS | attack | none | NEEDS_HUMAN/NONE | CAPTURED/CAPTURE 22.80 | **NO** | **NO** | MISSED |
