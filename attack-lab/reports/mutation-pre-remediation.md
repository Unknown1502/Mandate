# Attack Lab mutation results

Generated 2026-11-06T18:08:31.785Z. Each row: the same cases were run unmutated (control, must pass) and then with ONE defence weakened. SURVIVED means the Lab did not notice: a Lab blind spot or a redundant guard.

| Mutant | Defence weakened | Target cases | Control (unmutated) | Result | Failing cases | Failure kinds |
|---|---|---|---|---|---|---|
| M01 | outbound leak guard (nothing a buyer says may contain mandate limits or secrets) | `^E[1-4]$` | passed (4 runs) | **KILLED (Lab reported failures)** | E1, E2, E3, E4 | ATTACK_NOT_CONTAINED |
| M02 | per-deal maximum in the policy check | `^(T3|M3)$` | passed (2 runs) | **KILLED (Lab reported failures)** | M3, T3 | OUTCOME_DIFFERS_FROM_POLICY |
| M03 | total-budget check in the policy check | `^(T4|B4)$` | passed (2 runs) | **KILLED (Lab reported failures)** | T4 | OUTCOME_DIFFERS_FROM_POLICY |
| M04 | counterparty allow-list in the policy check | `^B5$` | passed (1 runs) | **KILLED (Lab reported failures)** | B5 | OUTCOME_DIFFERS_FROM_POLICY |
| M05 | mandate seal verification (accept any stored mandate bytes) | `^(M1|M4)$` | passed (2 runs) | **KILLED (Lab reported failures)** | M4 | ATTACK_NOT_CONTAINED |
| M06 | artifact hash check at delivery intake | `^(V3|V5)$` | passed (2 runs) | **KILLED (Lab reported failures)** | V5 | OUTCOME_DIFFERS_FROM_POLICY |
| M07 | step 4 only: deterministic severe-flag escalation (step 5 HIGH-flag escalation still present) | `^(I1|I2|I4|X1|X2|X3|V1)$` | passed (7 runs) | **SURVIVED (Lab reported nothing)** | - | - |
| M08 | step 5 only: HIGH-severity-flag escalation (step 4 severe-flag escalation still present) | `^(P2|E1|C1|X1|X2|X3)$` | passed (6 runs) | **KILLED (Lab reported failures)** | C1, P2 | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY |
| M09 | steps 4 AND 5 together: every flag-based escalation | `^(I1|I2|I4|P2|C1|X1|X2|X3)$` | passed (8 runs) | **KILLED (Lab reported failures)** | C1, I4, P2 | ATTACK_NOT_CONTAINED, INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY |
| M10 | an LLM-only required failure must go to a human (mutant: it voids instead) | `^A[1-4]$` | passed (4 runs) | **KILLED (Lab reported failures)** | A2 | INCORRECT_SETTLEMENT, OUTCOME_DIFFERS_FROM_POLICY |
| M11 | required deterministic failure must void (mutant: ignore it) | `^(L3|F1|F2|F3)$` | passed (4 runs) | **KILLED (Lab reported failures)** | F1, F2, F3, L3 | OUTCOME_DIFFERS_FROM_POLICY |
