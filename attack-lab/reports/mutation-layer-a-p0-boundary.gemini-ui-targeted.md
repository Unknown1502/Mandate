# Layer A - P0 security boundary

Generated 2026-11-09T13:16:02.589Z. Scored separately from every other suite; denominators are NOT combined with the historical 29-mutant Lab suite. No real LLM, no PayPal call; mock PayPal, scripted providers, database mandate_test.

**Defined 1, killed 1, survived 0, invalid 0, unreached 0, not evaluated 0.**  src/ restored byte-for-byte: YES (98 files, digest a0cd2932e5eb6473adb363d359832778f35893951499e5f84ce69a40f718e837).

| Mutant | Defence weakened | Verdict | Detectors (control -> mutant) |
|---|---|---|---|
| P0-A16 | NEW model provider created in production source (a second route to the vendor) | **KILLED** | P0 unit+architecture: PASSED -> KILLED [the approved model-consumer inventory is closed (production source: src/ and seller-service/) nothing in production source CREATES a provider or an artifact-bea] |
