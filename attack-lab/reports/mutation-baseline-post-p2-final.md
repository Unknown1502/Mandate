# Mutation baseline (post-p2-final) - separate suites, no combined score

The suites measure different things. Their denominators are NOT added and their rates are NOT compared as if the architecture were unchanged.

| Suite | Defined | Killed | Survived | Invalid | Unreached | Not evaluated | Generated |
|---|---|---|---|---|---|---|---|
| **Layer A - P0 security boundary** | 17 | 17 | 0 | 0 | 0 | 0 | 2026-11-08T12:54:20.187Z |
| **Layer B - dormant downstream AI defences (isolated harness)** | 7 | 7 | 0 | 0 | 0 | 0 | 2026-11-08T12:54:20.187Z |
| **Layer C - P1 forward-compatibility reader guards** | 21 | 21 | 0 | 0 | 0 | 0 | 2026-11-08T12:54:20.187Z |
| **Layer D - P2 V2 seal verifier and key registry** | 31 | 31 | 0 | 0 | 0 | 0 | 2026-11-08T12:54:20.187Z |

Historical reference only (earlier architectures; different mutants, different reach; kept unchanged):

* Historical combined Lab suite (reports/mutation.json): 29 defined, {"KILLED":29} (generated 2026-11-07T15:11:38.309Z)
* Post-P0 run of that same historical suite (reports/mutation-post-p0.json): 29 defined, {"KILLED":22,"SURVIVED":6,"INVALID MUTANT":1} (generated 2026-11-07T19:07:58.660Z)
* Layer A / Layer B as first established after P0: reports/mutation-layer-a-p0-boundary.json (17/17), reports/mutation-layer-b-downstream.json (7/7), unchanged

Layer A surviving mutants (each is a finding): none
Layer B surviving / unreached / invalid mutants: none
Layer C surviving / unreached / invalid mutants: none
Layer D surviving / unreached / invalid mutants: none
src/ restored byte-for-byte after the runs: YES

Details: mutation-layer-a-p0-boundary.post-p2-final.md, mutation-layer-b-downstream.post-p2-final.md, mutation-layer-c-p1-readers.post-p2-final.md, mutation-layer-d-p2-verifier.post-p2-final.md.
