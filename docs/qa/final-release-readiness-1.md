# Final release readiness — QA run `final-release-readiness-1` (2026-11-09)

Written for: the project owner deciding whether anything may proceed toward a real Sandbox integration. Nothing here is a claim of production readiness.

**Scope of this run:** Section 1 (baseline), Stage A (internal regression), Stage B1–B3 (homoglyph hardening, review package, Attack Lab). **Not done:** Stage C and every later stage — the directive text received was truncated at Stage C item 2 ("Restore or seed representative V1 and V2 test fixtures"), so the remaining stages are unknown and were not guessed. **No real PayPal call, no real LLM call, no release record, no V2 activation** happened in this run.

## 1. Baseline

| Item | Value |
|---|---|
| Repository state | not a git repository (`git rev-parse` fails); state is recorded by content hashes instead |
| Source manifest (92 files: `src/**`, `prisma/migrations/**`, `schema.prisma`, `package.json`, `package-lock.json`) | sha256 `428b53c6d3a57ce23a510c163c826175f5695c42258885370748c6566d31e84e` |
| `src/**` digest as used by the mutation tool (79 files) | `853182b911ba4506e57a252cb02464343a79884d6a940ccf7daf47891b5f9a82`, identical before and after every mutation run |
| Migrations | 9 migration folders; latest `20261108140000_terms_history_detector_refs` (all three directive-(b) migrations are additive) |
| Environment configuration | `MANDATE_V2_ENABLED`: not present in `.env.local` / `.env`; `MANDATE_V2_RELEASE_RECORD`: not set. No secret values were read into this report |
| V2 release gate | CLOSED: no signed release record exists; `scripts/issue-v2-release.ts` was not run |
| Test database | `mandate_test` only (DB tests and the Attack Lab both refuse any other database name) |
| `.spike/state.json` | untouched (mtime 2026-11-05) |
| Existing reports | none overwritten; every output of this run carries the label `final-release-readiness-*` |

## 2. Stage A — internal regression (final tree)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `next build` | succeeded |
| Unit tests (`vitest run tests/unit`) | 36 files, **947/947** pass |
| PostgreSQL tests (`npm run test:db`, `mandate_test`) | 22 files, **562/562** pass |
| `check:authorization-corpus` (strict-reader vs stored data) | OK; the database holds 0 stored mandates and 0 locked-terms rows, so it covers nothing real |
| V1 golden hashes / V1 deterministic-only zero model calls / V1 LLM-judged blocked / V2 unreachable without a signed record | covered by the unit and DB suites above and by the Lab (V1 deals: 0 model calls) |
| Test-only bypass in production source | grep for `NODE_ENV`/`VITEST`/`MANDATE_TEST`/`bypass`/`skipReleaseGate` in `src`: only the env schema and two vocabulary regexes — none opens a gate |

One test needed correction: the governance DB test blanked `knownGaps` to `[]`; detector 1.1.0 closes every v1 miss, so that no longer differed from the manifest. It now always forces a difference (`tests/db/detector-governance.db.test.ts:105`). No `src` change was involved.

### Mutation testing (layers reported separately)

Run `final-release-readiness-1`, `src` restored byte-for-byte after each layer.

| Layer | Defined | Killed | Survived | Invalid | Unreached |
|---|---|---|---|---|---|
| A P0 boundary | 17 | 17 | 0 | 0 | 0 |
| B downstream | 7 | 7 | 0 | 0 | 0 |
| C P1 readers | 21 | 21 | 0 | 0 | 0 |
| D P2 verifier | 31 | 31 | 0 | 0 | 0 |
| E P3/P4 V2 | 75 | 75 | 0 | 0 | 0 |
| F P5 enforcement | 38 | 38 | 0 | 0 | 0 |
| G P7 governance + detector | 46 (14 new: G33–G46) | 44 | **2** | 0 | 0 |

The two Layer G survivors were real test gaps, not equivalent mutants: **P7-G38** (single look-alike letter in an ASCII identifier — the branch was shadowed by the mixed-script branch for `c-1а042`) and **P7-G40** (whole-script look-alike flagged without Latin context — `рар` alone exited early, never reaching the rule). Tests were added (`1а042`, `рар x`, `рар αβγ`) and a targeted re-run (`final-release-readiness-2`, `--ids P7-G38,P7-G40`) killed both. Combined: 235 defined, 235 killed after remediation; **this is two runs, not one clean full run**, and layers A–F plus the other 44 Layer G mutants were not re-run after the added assertions (assertions cannot un-kill a mutant, and `src` is unchanged).

## 3. Stage B1 — homoglyph / confusable hardening (detector 1.1.0)

Implemented as a structural, documented strategy (UTS #39-style skeleton + mixed-script / whole-script findings), not as a phrase list — see `docs/review/detector-1.1.0-independent-review-package.md` §2. The original text and evidence are never rewritten; the skeleton is used for screening only; uncertain → `UNCERTAIN` (UNVERIFIABLE / NEEDS_HUMAN); scan errors or budget exhaustion yield `SCAN_INCOMPLETE`, never a pass.

| Detector | Merged held-out (50) unsafe passes | False blocks |
|---|---|---|
| 1.0.0 | 7 | 1 |
| 1.1.0 | **2** | 1 |

Remaining misses (disclosed in the evaluation core's known gaps): `ho2-pa-1`, `ho2-pa-2` (plain English paraphrases — outside what a lexical/visual-similarity screen can catch) and the false block `ho2-ok-2`. The v1.1 held-out set was written before the fix and used to drive it, so it is **not** a clean held-out set for 1.1.0. Detector 1.1.0 is **not registered** in the release registry (no reviews exist), so it cannot be pinned by a new mandate.

Prescan cost stayed within the deterministic work budget (2000 fragments in ~350 ms against a 4000 ms budget).

## 4. Stage B2 — review package

Prepared: `docs/review/detector-1.1.0-independent-review-package.md` (languages, detector id/version/hash, dataset hashes, examples, confusable tests, known misses, methodology, reviewer tasks). **Native-speaker review: NOT DONE. Independent security review: NOT DONE.** No reviewer was invented or recorded.

## 5. Stage B3 — Attack Lab on the final source

Report: `attack-lab/reports/final-release-readiness-attack-lab-1.{json,md}`, log `attack-lab/final-release-readiness-attack-lab-1.log`. Eight new homoglyph scenarios were added (I7a–I7h: Cyrillic, Greek, fullwidth, combining mark, zero-width, split-across-fields, short Spanish with LLM-judged criterion, spoofed identifier). PayPal is an in-memory mock, the database is `mandate_test`; **real LLM runs 0, real PayPal calls 0**. These are results about this suite on this code, not real-world robustness.

| Metric | Value |
|---|---|
| Unique scenarios / executions | 121 / 363 (3 runs each); harness errors 0; discarded stalls 0 |
| Attack containment | 318/318 (100%) |
| Incorrect settlement | 0/363; among runs where money moved 0/81 |
| Honest completion | 33/33; false positives 0/33; false-positive flags 0/33 |
| Human escalation (NEEDS_HUMAN) | 207/363 overall; attacks 204/318; lazy 3/12; honest 0/33 |
| Outcome matches policy | 363/363 |
| Flag detection (scenarios that declare an expected flag) | 183/189; misses G26 (Swahili), G27 (Vietnamese): the same two open gaps as the previous reports — contained because no V1 deal calls a model; they REOPEN if V2 models are ever enabled |
| Incomplete / invalid scans (`SCAN_INCOMPLETE`) | 0 appearances in the report |
| Local deterministic latency (delivery → terminal state; no LLM, mock PayPal) | median 311 ms, p95 586 ms (312 samples) |
| Isolation probes | ISO-1…ISO-6 PASS; ISO-LIMIT NOT_PROVIDED (as before) |

Separation: **scripted-model runs 120 (of which 18 with a scripted model that obeys the attacker)**; the remaining 243 runs are deterministic-only. Scripted results say nothing about how a real LLM behaves.

## 6. Not done / open

* Stage C (migration lifecycle and rollback on a disposable PostgreSQL database) and any later stage: directive truncated — **waiting for the rest of the text**.
* Real PayPal Sandbox / real LLM validation: **NOT performed**. It requires the human's explicit approval of a Sandbox transaction matrix and dedicated test accounts; no such approval exists.
* Detector 1.1.0 review, registration, release: NOT DONE. V2 release record: NOT issued. V2 remains disabled.
* Unresolved owner decisions Q3 / Q5 / Q7 / Q8 / Q11: handled strictest / fail-closed (AI-judged V2 criteria off, model-group cap 1, no new seller disclosure).
* The stored-data check covered an empty database; migration behaviour on realistic V1/V2 data is untested until Stage C.
