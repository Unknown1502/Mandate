# Layer E - P3/P4 V2 terms, attestation, approval, restricted model input, language assessment, evidence scoping, intake binding

Generated 2026-11-08T14:56:34.533Z. Scored separately from every other suite; denominators are NOT combined with the historical 29-mutant Lab suite. No real LLM, no PayPal call; mock PayPal, scripted providers, database mandate_test.

**Defined 2, killed 2, survived 0, invalid 0, unreached 0, not evaluated 0.**  src/ restored byte-for-byte: YES (76 files, digest d38d2bd482d0bd78a3a4f9e571e3dd33eb34f4a380d59358c7236bc1c98428bb).

| Mutant | Defence weakened | Verdict | Detectors (control -> mutant) |
|---|---|---|---|
| P4-E54 | instructions split across the fields of one row are not screened | **KILLED** | restricted model input + language + runner (unit): PASSED -> KILLED [language assessment reads exactly the prompt's fragments (docs/15 15.9.2) an instruction split across cells that are each harmless on their own is caught only b] |
| P4-E60 | the shipped detector is not compared with the pinned one by default | **KILLED** | V2 verification + intake binding (PostgreSQL): PASSED -> KILLED [V2 verification: the pinned detector must be the one this build ships terms that pin a different detector are BLOCKED by default (no call), even though lock-tim] |
