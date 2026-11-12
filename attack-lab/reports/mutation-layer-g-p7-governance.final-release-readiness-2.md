# Layer G - P7 detector registry, governance workflow, evaluation core, detector identity

Generated 2026-11-09T09:55:02.670Z. Scored separately from every other suite; denominators are NOT combined with the historical 29-mutant Lab suite. No real LLM, no PayPal call; mock PayPal, scripted providers, database mandate_test.

**Defined 2, killed 2, survived 0, invalid 0, unreached 0, not evaluated 0.**  src/ restored byte-for-byte: YES (79 files, digest 853182b911ba4506e57a252cb02464343a79884d6a940ccf7daf47891b5f9a82).

| Mutant | Defence weakened | Verdict | Detectors (control -> mutant) |
|---|---|---|---|
| P7-G38 | confusables: a single look-alike letter in an ASCII identifier is not flagged | **KILLED** | confusable screening (unit): PASSED -> KILLED [confusableFindings (structural, not a phrase list) flags a single look-alike letter inside an otherwise digit-only identifier (no ASCII letter to expose the mix] |
| P7-G40 | confusables: a whole-script look-alike word is flagged even without Latin context (false positives on real Cyrillic) | **KILLED** | confusable screening (unit): PASSED -> KILLED [confusableFindings (structural, not a phrase list) flags a whole-script look-alike word only inside Latin text] |
