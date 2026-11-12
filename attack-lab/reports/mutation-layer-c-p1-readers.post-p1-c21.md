# Layer C - P1 forward-compatibility reader guards

Generated 2026-11-08T11:12:16.066Z. Scored separately from every other suite; denominators are NOT combined with the historical 29-mutant Lab suite. No real LLM, no PayPal call; mock PayPal, scripted providers, database mandate_test.

**Defined 1, killed 1, survived 0, invalid 0, unreached 0, not evaluated 0.**  src/ restored byte-for-byte: YES (58 files, digest b088a1918c62b8d3678c1ea50440a41f70b6996f39a60d83152d7fd090a41453).

| Mutant | Defence weakened | Verdict | Detectors (control -> mutant) |
|---|---|---|---|
| P1-C21 | integrity check trusts a non-string ledger digest (cast regression) | **KILLED** | reader architecture: PASSED -> KILLED [JSON text is parsed only where the result is validated before it is trusted ledger-event payloads (JSON read back from the database) are not cast to a shape, ex] |
