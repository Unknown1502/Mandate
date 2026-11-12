# Attack Lab mutation results

Generated 2026-11-06T19:49:51.521Z. Each row: the same cases were run unmutated (control, must pass) and then with ONE defence weakened. SURVIVED means the Lab did not notice: a Lab blind spot or a redundant guard. 'Unit/DB layer' reports whether the named unit/DB test files notice the same mutant (a mutant the Lab misses but those tests kill is masked end to end, not untested).

| Mutant | Defence weakened | Target cases | Control (unmutated) | Lab result | Failing cases | Failure kinds | Unit/DB layer |
|---|---|---|---|---|---|---|---|
| M01 | outbound leak guard (nothing a buyer says may contain mandate limits or secrets) | `^E[1-4]$` | passed (4 runs) | **KILLED (Lab reported failures)** | E1, E2, E3, E4 | ATTACK_NOT_CONTAINED | not run |
| M02 | per-deal maximum in the policy check | `^(T3|M3)$` | passed (2 runs) | **KILLED (Lab reported failures)** | M3, T3 | OUTCOME_DIFFERS_FROM_POLICY | not run |
| M03 | total-budget check in the policy check | `^(T4|B4)$` | passed (2 runs) | **KILLED (Lab reported failures)** | T4 | OUTCOME_DIFFERS_FROM_POLICY | not run |
| M04 | counterparty allow-list in the policy check | `^B5$` | passed (1 runs) | **KILLED (Lab reported failures)** | B5 | OUTCOME_DIFFERS_FROM_POLICY | not run |
| M05 | mandate seal verification (accept any stored mandate bytes) | `^(M1|M4)$` | passed (2 runs) | **KILLED (Lab reported failures)** | M4 | ATTACK_NOT_CONTAINED | not run |
| M06 | artifact hash check at delivery intake | `^(V3|V5)$` | passed (2 runs) | **KILLED (Lab reported failures)** | V5 | OUTCOME_DIFFERS_FROM_POLICY | not run |
| M07 | step 4 only: deterministic severe-flag escalation (step 5 HIGH-flag escalation still present) | `^(I2|I3b|I5|I6|X1|X2|X3)$` | passed (7 runs) | **KILLED (Lab reported failures)** | I2, I3b, I5, I6, X1, X2, X3 | OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M08 | step 5 only: HIGH-severity-flag escalation (step 4 severe-flag escalation still present) | `^(P2|E1|C1|X1|X2|X3)$` | passed (6 runs) | **KILLED (Lab reported failures)** | C1, P2 | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | not run |
| M09 | steps 4 AND 5 together: every flag-based escalation | `^(I1|I2|I4|P2|C1|X1|X2|X3)$` | passed (8 runs) | **KILLED (Lab reported failures)** | C1, I4, P2 | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | not run |
| M10 | an LLM-only required failure must go to a human (mutant: it voids instead) | `^A[1-4]$` | passed (4 runs) | **KILLED (Lab reported failures)** | A2 | INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | not run |
| M12 | French and Chinese override patterns (language.ts) wired into the skeptic | `^(I5|I5b|I5c|I5d|I5f)$` | passed (5 runs) | **KILLED (Lab reported failures)** | I5, I5b, I5c, I5d, I5f | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M13 | UNSCANNED_LANGUAGE escalates (mutant: severity LOW, so it no longer reaches a human) | `^(I5g|I5h|I5i|I5j|I5k)$` | passed (5 runs) | **KILLED (Lab reported failures)** | I5g, I5h, I5i, I5j, I5k | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M14 | language-coverage guard (unreadable prose is no longer detected) | `^(I5g|I5h|I5i|I5j|I5k)$` | passed (5 runs) | **KILLED (Lab reported failures)** | I5j | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M15 | instructions split across consecutive rows of one column | `^(I5e|I5f)$` | passed (2 runs) | **KILLED (Lab reported failures)** | I5e, I5f | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M16 | instructions split across the fields of one row (row-joined scan) | `^(I5d|I5k|I6)$` | passed (3 runs) | **KILLED (Lab reported failures)** | I5d, I5k, I6 | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M17 | unreadable prose split across short fields of one row (joined language guard) | `^I5k$` | passed (1 runs) | **KILLED (Lab reported failures)** | I5k | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY | KILLED (tests failed) |
| M11 | required deterministic failure must void (mutant: ignore it) | `^(L3|F1|F2|F3)$` | passed (4 runs) | **KILLED (Lab reported failures)** | F1, F2, F3, L3 | OUTCOME_DIFFERS_FROM_POLICY | not run |
