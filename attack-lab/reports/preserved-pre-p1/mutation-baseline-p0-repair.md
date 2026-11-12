# Mutation baseline after P0 (repair task) - separate suites, no combined score

Three suites measure three different things. Their denominators are NOT added and their rates are NOT compared as if the architecture were unchanged.

| Suite | Defined | Killed | Survived | Invalid | Unreached | Not evaluated | Generated |
|---|---|---|---|---|---|---|---|
| **Layer A - P0 security boundary** | 17 | 17 | 0 | 0 | 0 | 0 | 2026-11-08T09:32:05.567Z |
| **Layer B - dormant downstream AI defences (isolated harness)** | 7 | 7 | 0 | 0 | 0 | 0 | 2026-11-08T09:41:57.857Z |

Historical reference only (pre-P0 architecture; different mutants, different reach; kept unchanged):

* Historical combined Lab suite (reports/mutation.json): 29 defined, {"KILLED":29} (generated 2026-11-07T15:11:38.309Z)
* Post-P0 run of that same historical suite (reports/mutation-post-p0.json): 29 defined, {"KILLED":22,"SURVIVED":6,"INVALID MUTANT":1} (generated 2026-11-07T19:07:58.660Z)

Layer A surviving mutants (each is a finding): none
Layer B surviving / unreached / invalid mutants: none
src/ restored byte-for-byte after both runs: YES

Details: mutation-layer-a-p0-boundary.md, mutation-layer-b-downstream.md. Classification of the six historical survivors: docs/14 section 14.27.
