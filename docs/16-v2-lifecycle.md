# 16. The V2 authorization lifecycle (P3 + P4 + P5 + P7)

Status date: 2026-11-08. Everything here ran against **mock PayPal, scripted models and the `mandate_test` database only**. No real LLM call, no real PayPal call, no Sandbox checkout approval, no capture/void/refund of any existing Sandbox order, no webhook, no UI, no deployment, no external auditor. Nothing below is evidence about real LLM or real PayPal behaviour, and nothing here claims production readiness.

## 16.1 Final statuses

| Item | Status |
|---|---|
| P0 model isolation (V1) | PASS (tested V1 paths; V1 never calls a model) |
| P1 forward-compatibility readers | PASS |
| P2 V2 seal verifier | PASS (now connected through the mandate opener only) |
| **P3** V2 writers + TermsAttestation | **PASS** (see 16.5) |
| **P4** model integration | **PASS** with scripted providers (see 16.6) |
| **P5** enforcement hardening | **PASS** for the surfaces that exist; distributed rate limiting, nonce-based CSP and OS-level seller isolation are NOT done (16.12) |
| **P7** detector governance | **PASS** for the mechanism; no real native-speaker review has happened (16.9) |
| Attack Lab overall | PARTIAL (unchanged) |
| Real-LLM validation | NOT DONE |
| Real-PayPal validation | NOT DONE |
| Production deployment | NOT DONE |

Global result: all four stages pass their stated criteria and all V1 regression is green, **with the capabilities blocked by unresolved owner questions isolated and OFF by default (16.3)**.

## 16.2 Architecture and data flow

```
 human (principal)
   |  1 preview V2 mandate  -> exact document + digest (mandateId, nonce, language policy floor)
   |  2 echo digest        -> sealMandateV2 -> self-verified by the P2 verifier -> Mandate row (sealVersion 2)
   v
 Mandate V2 (signed: budget, counterparties, expiry, task types, language policy FLOOR, detector pin, carryOver null)
   |  createDeal (openMandateRow: V1 | V2 dispatch, key registry)
   v
 lockTerms V2: strict schema -> classification/bijection -> group cap -> mandate binding -> policy >= floor -> detector permitted
   |  termsHash = sha256(canonical(normalized V2 terms))  (covers artifactSchema, inputFields, languagePolicy)
   v
 checkPolicy -> NEEDS_HUMAN (every V2 deal; LLM_MAPPING_APPROVAL_REQUIRED or V2_TERMS_APPROVAL_REQUIRED)
   |  previewDealApproval  (criteria, mapping, OPAQUE list, language policy, budget, counterparties, expiry, tasks, acceptance criteria; server nonce)
   |  approveDealWithAttestation (echo attestationDigest) -- ONE transaction under the mandate lock:
   |        TermsAttestation (signed, immutable) + HUMAN_REVIEW_DECISION{termsHash,attestationId,nonce} + budget reservation
   v
 Settlement engine createPayPalOrder: authorizeLoadedDeal = seal, identity, expiry, terms hash, counterparty, version pairing, classification,
   language policy >= floor, switch, detector release, mirrored columns, ATTESTATION verified against the registry and the CURRENT state
   v
 order -> (MOCK) buyer approval -> authorization -> delivery (strict CSV, hash, size) 
   v
 verifyDelivery (V2 core): re-derive authorization -> closed-world field classification -> deterministic checks + prescan (all fields)
   -> per model GROUP: buildModelInput (branded; only approved columns x inputMaxRows) -> language assessment of EXACTLY that text
   -> ModelRunner (manifest re-check, call budget) -> output validation (evidence resolved only inside the restricted view) -> result + binding
   v
 submitVerificationToSettlement: authorization re-derived NOW; bindingRefusal(...) compares every bound value; then recordVerification
   v
 settleDeal: authorizeLoadedDeal again; decideSettlement (AI never decides money); pre-send re-derivation before the first CAPTURE; capture/void/reconcile (V1 engine)
   v
 immutable audit: hash-chained DealEvent ledger, TermsAttestation, VerificationRun.resultJson.binding, AgentRun.inputManifestHash,
 detector release log (signed, chained)
```

No component reconstructs authorization: `authorizeLoadedDeal` is the single derivation, called by order creation, settlement, the pre-send capture guard, integrity checks, approval and verification.

## 16.3 Owner decisions, and what was done where a question is unresolved

| Q | Status | What this build does (strictest safe behaviour; nothing permissive was chosen) |
|---|---|---|
| Q1 TermsAttestation | approved | implemented as specified (not a user signature) |
| Q2 human sees the exact mapping | approved | `previewDealApproval` renders it |
| Q3 explicit `allowLlmJudgedCriteria` switch in the mandate | **UNRESOLVED** | not added to the signed document (the P2 payload is frozen). Capability **isolated**: V2 AI-judged criteria are blocked unless the deployment sets `llmCriteriaEnabled` (default OFF; reason `LLM_CRITERIA_NOT_ENABLED`). Per-deal human attestation is always required. Owner must choose derived-only (A) or a signed switch (B) |
| Q4 stop V1 model calls | approved | done in P0 |
| Q5 cap on model groups | **UNRESOLVED** | default cap **1** (strictest), tightenable, never above 5 (absolute); multi-group isolation is implemented and tested with an explicit cap |
| Q6 name-like tokens | approved | UNCERTAIN, never auto-passed, no manipulation flag |
| Q7 seller wire disclosure | **UNRESOLVED** | option (A): nothing new disclosed; the seller wire contract is unchanged |
| Q8 deprecated env variables | **UNRESOLVED** | V2 never reads them; they have no effect (V1 unaffected since P0). No silent behaviour change; removal/warning policy left to the owner |
| Q9 carry-over | approved: none | `carryOver: null` enforced in the signed document |
| Q10 detector governance | approved | P7 |
| Q11 docs/14 correction | **UNRESOLVED** | option (a): the existing correction note stays; no further edits |
| Q12 external audit | NOT approved | nothing sent anywhere |
| Q13 strict V1 post-check, Q14 identity+nonce, Q15 key registry | implemented in P1/P2/P3 under the staged approvals | |
| Q16 attestation for deterministic-only V2 deals | resolved by the directive | real HUMAN_PREAUTH attestation for every V2 deal; `POLICY_WITHIN_MANDATE` does not exist |
| Q17 | done | P0 first |

Blocked / isolated capabilities until the owner decides: production use of AI-judged V2 criteria (Q3, Q5). Everything else is enabled.

## 16.4 Migration inventory (additive only) and rollback

| Migration | Contents |
|---|---|
| `20261108120000_v2_authorization` | `Mandate`: `sealVersion` (default 1), `schemaVersion` (default 1), `languagePolicyHash?`, `mandateNonce?` (unique); `Deal`: `termsSchemaVersion` (default 1), `languagePolicyHash?`; `VerificationRun`: `termsSchemaVersion?`, `bindingHash?` (+index); `AgentRun`: `inputManifestHash?`; new table `TermsAttestation` (unique `dealId`, unique `approvalNonce`, shape CHECK, immutability trigger); CHECK constraint `Mandate_v2_identity_check` |
| `20261108130000_detector_governance` | new tables `DetectorRelease` (guard trigger: immutable except `status`, workflow-only transitions, no delete) and `DetectorReleaseEvent` (immutable) |

* No existing column altered or dropped, no row rewritten, no V1 record re-signed or migrated; every new column on an existing table is nullable or a constant default.
* Backward compatibility is tested: a V1 mandate keeps `sealVersion 1`, no nonce, still seals/opens; identical V1 drafts remain storable; V1 rows never open under the V2 verifier and vice versa; the whole V1 suite passes unchanged except the P1 tests that used `schemaVersion: 2` as "a future version" (now `3`).
* Rollback: no V1 code path reads the new objects. To roll back: withdraw V2 mandates/deals first (they would no longer be readable by an older build and fail closed), then `DROP TABLE "DetectorReleaseEvent"; DROP TABLE "DetectorRelease"; DROP TABLE "TermsAttestation";` drop the added columns and `Mandate_v2_identity_check`, and drop functions `mandate_detector_release_guard()`. The migrations were applied only to `mandate_test`.

## 16.5 P3 summary and evidence

Modules: `terms-v2.ts` (strict V2 terms, classification, bijection, group cap, hashes, dispatching reader), `language-policy.ts` (strictness lattice, `stricterOf`), `attestation.ts` (payload, signing, verification), `mandate-v2-writer.ts` (two-step approval, preview rendering), `v2-keys.ts`, `deal-approval.ts` (preview + approve in one transaction), `authorization.ts` (central derivation), `mandates.ts` (`openMandateRow`), `policy.ts`/`deals.ts` (V2 branches).

Evidence: unit tests for terms (28+), lattice and 2,000-case property test, attestation (22), writer/policy (13); PostgreSQL tests (25) cover persistence, tamper cases at every column, DB CHECKs, lock-time rejections, the legacy path refusal, preview contents, wrong digest/nonce/foreign nonce/expired/reused nonce, impersonation, **concurrent approvals (3 racing: exactly 1 attestation, 1 reservation)**, no joint overspend, revocation/drift between preview and approval, attestation immutability and tamper detection, and the engine refusing an order without a verifying attestation.

## 16.6 P4 summary and evidence

* One boundary: `ModelRunner` (`model-runner.ts`) is the only verification module that reaches a provider; `ModelInput` and `ModelAuthorization` are branded and registered in module-private WeakSets, so a cast or spread copy is rejected at runtime. The runner re-checks the manifest, enforces a call budget, records a `CallManifest` per call (provider/model, prompt and policy version, role, criteria, field ids, artifact hash, input/output digests, call id, time, usage, status) and no text.
* Authority boundaries: the buyer cannot touch criteria, mandate or payment (V2 negotiation is built, see 16.17: the agents negotiate the PRICE inside principal-authored V2 terms). The seller's wire contract is unchanged (no budget, no tools). The verifier output has no money field; the skeptic prompt says "challenge only" and never sees the verifier output or the criteria. Provider output is parsed into closed Zod schemas and nothing else.
* Language: supported prose proceeds; unsupported/uncertain/name-like/incomplete scan/detector error/mismatch -> group UNVERIFIABLE, **zero provider calls**; OPAQUE never reaches a model; an undeclared artifact column blocks every AI-judged criterion; deterministic-only V2 deals make zero calls (asserted end to end).
* Evidence is resolved only against the group's restricted view (approved columns x `inputMaxRows`, no manifest); the result `binding` records fields, rows, quote hash, call ids, and `bindingRefusal` re-checks them at intake.
* Evidence: 28 + 29 + 1 unit tests and 28 PostgreSQL tests (canary tests prove opaque values never appear in any prompt, result or audit row).

## 16.7 P5 summary and evidence

Authorization re-derivation at order creation, settlement and (new) immediately before the first CAPTURE send; revoked-mandate and expiry rules; mirrored-column tamper checks; V2 integrity check; reservation sweeper; HTTP hardening for the existing routes (bounded strict-JSON body, per-process rate limit, secure headers, no-store API). PostgreSQL: full lifecycle to CAPTURED with one lineage (attestation, binding, ledger share the same mandate digest, terms hash, policy hash), concurrent settlement (4 racing: 1 capture, 1 settlement), capture response lost -> reconcile without resend, replay, drift, tampered attestation, revoked mandate, authorization lost between decision and send (capture not sent), expired mandate, sweeper rules and idempotence.

## 16.8 Security threat matrix (V2 additions)

| Threat | Control | Test |
|---|---|---|
| Tampered mandate bytes/digest/signature/nonce/version hint | V2 verifier + opener fail closed both directions | v2-authorization (tamper table) |
| Human-approval impersonation | principal-scoped load, attestation actor == mandate principal | impersonation, ATTESTATION_ACTOR_MISMATCH |
| Terms drift after lock/approval | hash lock + attestation binding, re-derived at every step | drift tests, settle/order |
| Field-mapping tampering | mappingHash in attestation and result binding | bindingRefusal table |
| Opaque data to a model | restricted ModelInput, closed world, builder re-check | canary tests |
| Evidence refs to unseen fields/rows/manifest | restricted visible CSV, binding check | evidence tests |
| Malicious artifact instructions / metadata injection | untrusted wrapping, sanitiser, language/prescan, model output cannot carry money | injection tests |
| Unsupported/uncertain language | UNVERIFIABLE, no call | language tests |
| Detector substitution | pinned triple, strictness lattice, shipped-vs-pinned check, registry release status | governance + pipeline tests |
| Signature/attestation tampering, duplicate JSON keys, non-canonical | strict parser, canonical re-encoding, domain-separated purpose | attestation tests |
| Replay of an approval | single-use nonce (ledger + unique column) | nonce tests |
| Concurrent approvals/reservations/settlements | mandate row lock, unique constraints, CAS | concurrency tests |
| Duplicate settlement, unknown outcome | unique settlement, GET-first reconcile | enforcement tests |
| Stale verification | binding vs CURRENT state, supersession | intake tests |
| Brute-force login, oversized body | rate limit (per process), bounded strict body | http-guard tests |
| Clickjacking, sniffing, referrer, caching | security headers, no-store | http-guard tests |

## 16.9 P7: detector governance, evaluation and release evidence

Workflow `DRAFT -> EVALUATION -> REVIEW -> APPROVED -> RELEASED -> RETIRED` (+ REVOKED, signed ROLLBACK), enforced in code and by DB triggers. Controls: immutable manifest + content hash; evaluation must pass nine required suites with separate tuning/held-out sets, a clean mutation run, prescan performance in budget, and **no undisclosed failures** (misses must be listed in the manifest's `knownGaps`); independent language (every claimed language) and security (named adversarial corpus) reviewers, distinct from the submitter and each other; a third-party approver; a releaser who is not the submitter; every event hash-chained and signed with the application key and re-verified on load; permissive releases need an explicit acknowledgement and are never adoptable by an existing mandate (a different triple is a different detector). Use requires: verified release + permitting status (`NEW_PIN`: RELEASED; `EXISTING_PIN`: RELEASED/RETIRED; never REVOKED) + coverage >= policy languages + the build ships exactly the pinned detector.

Identity: `mandate-lexical-detector@1.0.0`, vocabulary hash `sha256:f5562477b9f2a162c1915eea84f99d20c8eb91e85804507e13bbb7d61576abda` (pinned by a golden test; covers data tables and patterns, not function bodies).

Evaluation: `npm run detector:eval` (offline). Fixtures: `eval/detector/tuning.v1.json` (31) and `heldout.v1.json` (31). **Measured: 1 miss in total, in the TUNING set: `tu-uni-cyr-1`, an English override with a Cyrillic homoglyph passes the pre-model defence (disclosed known gap of 1.0.0, would need homoglyph folding = new version). The held-out sample produced 0 misses of 31 and 0 false blocks. These are tiny hand-written samples: counts, not accuracy.** Prescan/classify benchmark: 2,000 fragments in ~100 ms.

**Not claimed:** no native-speaker or independent security review of the shipped vocabulary has taken place; the registry enforces that such reviews are recorded by distinct people, it cannot verify that they were competent. Reviewer identities are caller-supplied strings until the HTTP/auth layer exists.

## 16.10 24-step lifecycle -> evidence

1 mandate preview, 2 digest confirmation, 3 V2 seal + self-verify, 4 persistence with identity/nonce, 5 createDeal opener, 6 terms lock (strict, classified), 7 floor/switch/detector checks, 8 policy -> NEEDS_HUMAN, 9 approval preview, 10 digest echo, 11 attestation + reservation (one tx), 12 order creation re-derivation, 13 buyer approval (MOCK), 14 authorization, 15 delivery, 16 integrity + closed-world classification, 17 deterministic checks + prescan, 18 restricted ModelInput, 19 language assessment, 20 ModelRunner calls + manifests, 21 evidence validation + binding, 22 intake binding, 23 settlement decision + pre-send guard, 24 capture + reservation conversion + audit chain. All asserted in `tests/db/v2-enforcement.db.test.ts` ("the complete V2 lifecycle") with the same mandate digest, terms hash and policy hash at every step.

## 16.11 Traceability matrix (excerpt; Requirement -> design -> module -> test)

| Requirement | Design | Module | Test |
|---|---|---|---|
| strict V2 terms, bijective mapping, unclassified fails closed | 15.3.1, 15.7 | terms-v2.ts | terms-v2.test.ts; killers P3-E01..E16 |
| language policy in signed scope, deployment only stricter | 15.3.3, 15.6.2 | language-policy.ts, mandate-v2-writer.ts | language-policy-attestation.test.ts; E27..E31 |
| two-step approval with exact digest | 15.5.5 | deal-approval.ts | v2-authorization.db.test.ts; E32..E35 |
| TermsAttestation binds deal/mandate/terms/policy/mapping/actor/nonce | 15.5.4 | attestation.ts, authorization.ts | attestation tests; E17..E23, F01..F09 |
| concurrent approvals cannot bind different terms | 15.5.4 | deal-approval.ts + unique constraints | concurrency tests |
| one ModelRunner boundary, branded input | 15.8 | model-input.ts, model-runner.ts | model-input.test.ts, architecture tests; E36..E48 |
| evidence provenance + scoping | 15.7 | pipeline-v2.ts, binding-check.ts | v2-verification.db.test.ts; E55..E68 |
| every consequential action re-validates | 15.9.1 | authorization.ts, engine.ts | v2-enforcement.db.test.ts; F01..F13 |
| reservation expiry/cleanup | P5 | reservations.ts | enforcement tests; F16, F17 |
| security controls | P5 | http-guard.ts, next.config.ts | http-guard.test.ts; F18..F23 |
| detector governance | 15.18 | detector-registry.ts, scripts/detector-eval.ts | detector-eval.test.ts, detector-governance.db.test.ts; G01..G32 |

## 16.12 Open issues and residual risks

1. **Q3, Q5, Q7, Q8, Q11 unresolved** (16.3); AI-judged V2 criteria are OFF by default.
2. V2 negotiation was missing in the first pass and is **built in the final-directive sprint (16.17)**. Remaining limit: the buyer can negotiate only the price; it cannot propose different criteria or mappings (by design).
3. No HTTP routes for mandates/deals/approval exist (UI not started), so human authentication of approvers/reviewers is outside this build.
4. Rate limiting is per process; CSP keeps `unsafe-inline` for scripts (Next.js bootstrap); HSTS only effective over HTTPS.
5. The seller service is a separate process, **not an OS sandbox**.
6. Detector: known gap `tu-uni-cyr-1`; vocabulary written without native-speaker review; the hash does not cover function logic (version bump + golden test instead).
7. `REJECT_DELIVERY` is a stricter label but, like `UNVERIFIABLE_HUMAN_REVIEW`, never voids or pays by itself: a language heuristic must not decide money.
8. A retired detector remains usable by mandates that already pin it (documented choice); revoke to stop use.
9. Key registry has no retired-but-trusted state; the detector snapshot is loaded by the caller (refresh cadence is a deployment matter).
10. Real-LLM prompt quality, real-PayPal behaviour, and production operations are unvalidated.

## 16.13 Reproducible commands

```
npx tsc --noEmit && npm run lint && npm run build
npm test                         # unit (no database)
npm run test:db                  # real PostgreSQL, mandate_test only
npm run attack:mutate:layers -- --suite E|F|G|A|B|C|D --label <new-label>
npm run detector:eval -- --report out.json [--mutation summary.json]
npm run bench:v2 -- --label <name>
```

## 16.14 Mutation results by layer (run `post-p7`, final code; separate suites, no combined score)

| Layer | Scope | Defined | Killed | Survived | Invalid | Unreached |
|---|---|---|---|---|---|---|
| A | P0 model boundary (V1) | 17 | 17 | 0 | 0 | 0 |
| B | dormant downstream AI defences | 7 | 7 | 0 | 0 | 0 |
| C | P1 readers | 21 | 21 | 0 | 0 | 0 |
| D | P2 verifier + registry (D03, D24 re-expressed for the P3 architecture) | 31 | 31 | 0 | 0 | 0 |
| **E** | **P3/P4 terms, attestation, approval, model input, language, evidence, intake binding** | **68** | **68** | 0 | 0 | 0 |
| **F** | **P5 authorization re-derivation, settlement gates, sweeper, HTTP** | **24** | **24** | 0 | 0 | 0 |
| **G** | **P7 registry, workflow, evaluation core, detector identity/classifier** | **32** | **32** | 0 | 0 | 0 |

`src/` hashed before and after: identical (76 files). Reports: `attack-lab/reports/mutation-layer-*.post-p7.{json,md}`, `mutation-baseline-post-p7.md`. The historical 29-mutant suite and earlier reports are untouched.

**Honesty note.** The first (trial) run of E/F/G had 5 non-kills: P4-E54 (row-join screen: the test cells were individually blocked, so it could not tell), P4-E60 (default shipped-detector check: fixtures happened to equal the shipped detector), P5-F15 (the mutant run crashed/timed out and is conservatively counted as survived), P5-F24 (no rule pinned where model authority may be derived), P7-G31 (no test with an identified language outside the policy). Each was closed by a NEW test (not by changing the mutant) and the final run is the one above. Mutants are my own choices of weakening; 200/200 is a statement about those 200, not a proof of absence of defects. Several defences are intentionally redundant (for example the counterparty check in the central authorization duplicates the policy check), so mutants removing only the duplicate are not defined.

## 16.15 Benchmarks (this machine, one run; not capacity claims)

Environment: Windows 11, Intel i5-1135G7 (8 threads), 20 GB RAM, Node v22.17.1, PostgreSQL 16.15 in Docker, MOCK PayPal, SCRIPTED model. Command: `npm run bench:v2 -- --label <name> --workflows 1,5,10,20`. Raw: `attack-lab/reports/bench-v2.final.json`, `bench-v2.final20.json`.

Limits in force: artifact 200,000 bytes (refused before hashing/parsing; a 600,002-byte artifact is over), 10,000 rows, 100 columns, 10,000 chars per cell, model view <= 15 rows x 50 fields x 200 chars per cell and 60,000 input characters, language scan <= 5,000 fragments / 2 s, prescan work budget 600,000 units / 5 s (exceeding it is SCAN_INCOMPLETE, never a pass), model timeout 15 s, 2 attempts, per-verification call budget set by the caller.

Artifacts through parse -> checks -> prescan -> model view -> language assessment (ms): ~145 kB/1,333 rows: 11 / 1 / 60 / 1 / 4; 10,000 rows: 5 / 0 / 43; 100 columns x 100 rows: 5 / 0 / 33; 15 rows x 10,000-char cells (300 kB, over the delivery limit, parser-only): 11 / 1 / 33 / 2 / 1. (The synthetic filler text is correctly blocked by the language assessment as uncertain, and a wide view whose approved columns are absent is refused as INPUT_FIELD_ABSENT.)

Concurrent complete workflows (approve -> order -> authorize -> deliver -> verify -> intake -> settle -> capture): 1: 827 ms; 5: 1,127 ms wall; 10: 1,948 ms; 20: 4,005 ms (p95 per workflow ~= wall time because they run concurrently against one local database). In every run: all completed, 0 failed, **at most 1 capture per deal, settlements == deals, reservations converted == deals, 100% of ledger chains intact**.

## 16.16 Files

Created: `src/domain/{attestation,authorization,deal-approval,detector-registry,language-policy,mandate-v2-writer,reservations,terms-v2,v2-keys}.ts`, `src/verification/{errors,language-v2,model-input,model-runner,pipeline-v2}.ts`, `src/settlement/binding-check.ts`, `src/lib/http-guard.ts`, `prisma/migrations/20261108120000_v2_authorization`, `prisma/migrations/20261108130000_detector_governance`, `eval/detector/{tuning,heldout}.v1.json`, `scripts/{detector-eval,bench-v2}.ts`, `scripts/lib/detector-eval-core.ts`, `attack-lab/mutants-p3-p7.ts`, tests (`tests/unit/{terms-v2,language-policy-attestation,policy-v2,model-input,model-runner-guard,http-guard,detector-eval}.test.ts`, `tests/db/{v2Fixtures,v2-authorization,v2-verification,v2-enforcement,detector-governance}...`, `tests/helpers/v2Fixtures.ts`), this document.
Modified: `prisma/schema.prisma`; `src/domain/{mandate-v2 (export of the payload builder), mandates, deals, policy, terms (exports), compat}.ts`; `src/settlement/{engine,verification-intake}.ts`; `src/orchestration/{integrity,service}.ts`; `src/verification/{pipeline,delivery,contracts,ai,language}.ts`; `src/app/api/auth/login/route.ts`; `next.config.ts`; `package.json`; architecture tests (narrow, named allow-list updates); P1 tests that used `schemaVersion: 2` as a future version (now 3); `attack-lab/mutate-layers.ts` (layers E-G, D03/D24); docs 09, 15.
Deleted: none. V1 records, approved mandates, `.spike/state.json` and the Sandbox orders: untouched.


## 16.17 Final-directive additions (2026-11-09)

The final directive re-stated P3+P4+P5+P7 as one sprint and added items the first pass had not covered. They are implemented and listed here with their evidence; everything else in the directive was already in place (16.1-16.16).

### V2 release gate (directive part 7): V2 is DISABLED by default
* `src/domain/v2-release-gate.ts` (pure), `src/lib/v2-gate-loader.ts` (composition root) and `scripts/issue-v2-release.ts` (QA tool, **not run**).
* `openMandateRow` returns null for every V2 mandate, and `approveMandateV2` throws `V2DisabledError`, unless an **open gate** is supplied. Every V2 read (policy, authorization, order creation, settlement, integrity, negotiation, verification) goes through `openMandateRow`, so V2 is dead without it.
* The gate opens only for a **signed release record** (purpose `v2-release-gate`, application key under the registry) that states PASS for **P2, P3, P4, P5, P7 and the security-regression suites**, each with the sha256 of its evidence; is bound to the **sha256 of the running source tree**; is valid for at most 30 days; **and** the deployment opted in with `MANDATE_V2_ENABLED=true`. A decision is re-checked against the clock at every use.
* **No test-only override exists.** Tests sign their own record with an ephemeral key against a registry that holds only that key (`tests/helpers/v2Gate.ts`); such a record cannot verify against a production registry. The gate module reads no environment and exports no setter (a test lists its exports).
* `issue-v2-release.ts` refuses to sign unless every requirement has at least one green vitest-JSON or clean mutation-JSON evidence file. **No record has been issued**: V2 is closed in this environment.

### V2 negotiation (directive 2.2, workflow step 12)
`TaskBrief.v2` carries the principal-authored template (criteria with inputFields, artifact schema, language policy). Agents negotiate the **price** only. The brief version must match the mandate version (`BRIEF_VERSION_MISMATCH`); the V2 brief is validated (classification, group cap) before any message is exchanged; the lock passes the full verification context (floor, switch, detector release).

| Agent | May | May not | Enforced by |
|---|---|---|---|
| Buyer | propose / counter / accept / walk away on PRICE up to the ceiling; see task text, criteria text, deadline, round | change criteria, mapping, policy, counterparty or deadline; see the mandate, budget, mapping or delivery artifacts; approve the mandate or pay | `validateBuyerIntent`, frozen context, outbound leak guard; V2 test: prompt contains no mapping / budget / mandate id |
| Seller (separate process) | answer with price / accept / decline; receive the V1-shaped spec | see budget, policy, mapping, classification; call settlement; change locked terms; run code in this system | strict wire contracts (an extra field is a protocol violation), drift detector, wire-inspection test; **not an OS sandbox** |
| Verifier | return PASS / FAIL / UNVERIFIABLE with evidence for the criteria of ONE group, over that group's approved cells | read opaque fields, other groups or the manifest; move money (the output schema has no such field); judge deterministic criteria | branded `ModelInput`, restricted evidence view, closed output schema, `mergePasses` |
| Skeptic | challenge: flags with cited evidence | see the criteria or the verifier's output; void / capture / override deterministic rules (a flag can only escalate) | prompt role, same restricted view, `severe: false` for any LLM flag |
| ModelRunner | call the provider for a cleared, branded input | run an input that is unbranded, not language-cleared, for a different detector, older than 15 min, over the size limit, outside the approved criteria, or with a failed manifest check; exceed the call budget | the runner's own pre-flight (next section) |

### ModelRunner independent verification (directive 2.1)
Besides the manifest re-check, the runner now refuses (zero provider calls) an input that: is not **language-cleared** (a registration only `assessAndClear` can make, and only when the assessment of exactly that input's fragments found nothing to block); pins a detector other than the one this build ships; carries an authorization older than 15 minutes; exceeds the input limit; has a malformed binding (hashes, nonce, policy hash); or names a criterion that is not an approved AI-judged criterion of the approved terms. The seal, attestation and terms hash are verified when the authorization is derived (`authorizeLoadedDeal`); the runner has no database, so it checks the bound facts that derivation produced instead of re-reading them. This is a deliberate narrow bridge: the runner never imports the V2 verifier or the key registry.

### Terms history and detector references (directive 1.6)
Migration `20261108140000_terms_history_detector_refs`: immutable `TermsVersion` (one row per locked version, keyed (deal, version), written in the lock transaction) and mirrored `Mandate.detectorId / detectorVersion / detectorVocabularyHash` columns, which must equal the signed pin or the mandate does not open.

### Evidence provenance model
Per accepted evidence reference the result `binding.evidence[]` records: criterion id, the reference (which embeds the artifact hash prefix), the approved **field id**, the **row**, the **sha256 of the quote** and the **call ids** that produced it. The binding as a whole carries the mandate digest, terms hash, mapping hash, policy hash, attestation nonce and record hash, delivery id, verification id and the per-call manifests (provider, model, prompt and policy version, detector, criterion, field ids, input / output digests, status). `bindingRefusal` re-checks all of it against the CURRENT locked deal at intake. References are resolved only against the group's restricted view, so a reference to an unseen field or row, a manifest field or another artifact cannot validate.

### Settlement enforcement architecture
```
AI proposes (closed-schema findings) -> evidence supports (quotes verified inside the restricted view) -> deterministic policy decides (decideSettlement)
human approval defines authority (TermsAttestation) -> authorizeLoadedDeal re-derives it at order creation, settlement and the pre-send capture guard -> the Settlement engine alone writes to PayPal
```
No model output reaches the engine except as a status per criterion after `bindingRefusal`; a PayPal write needs a persisted `PayPalOperation`, a verifying attestation, an ACTIVE reservation and an unrevoked, unexpired mandate.

## 16.18 Final QA plan, and what was actually executed

The directive asked for implementation first and a dedicated QA phase afterwards. Tests were written alongside the code, and the campaign below was **executed after the last code change**; the table separates executed from deferred from not-done.

| QA item | Command | Status |
|---|---|---|
| Typecheck, lint, production build | `npx tsc --noEmit && npm run lint && npm run build` | EXECUTED (16.19) |
| Unit suite (P0-P7, golden vectors, architecture pins) | `npm test` | EXECUTED |
| PostgreSQL suite (V1 + V2, concurrency, tamper) | `npm run test:db` | EXECUTED |
| V1 immutable golden fixtures, V1 zero-model-call tests | inside the unit and DB suites | EXECUTED (unchanged, green) |
| V2 cryptographic golden vectors (seal, attestation, release record) | `mandate-v2-seal`, `language-policy-attestation`, `v2-release-gate` tests | EXECUTED |
| Model-boundary canary tests | `tests/db/v2-verification.db.test.ts`, `model-isolation.db.test.ts` | EXECUTED |
| Concurrency and crash recovery | approvals, settlements, claims, reconcile in the DB suite | EXECUTED (mock; host-suspension flake documented in docs/14) |
| All mutation layers A-G | `npm run attack:mutate:layers -- --suite all --label <new-label>` | EXECUTED (16.19) |
| Detector evaluation | `npm run detector:eval` | EXECUTED (16.9) |
| Benchmarks | `npm run bench:v2 -- --label <name>` | EXECUTED (16.15) |
| Migration apply (all migrations on `mandate_test`) | `prisma migrate deploy` | EXECUTED |
| **Migration ROLLBACK (running the DROP scripts and re-running V1)** | scripts in each migration header and 16.4 | **DEFERRED** (documented, not executed) |
| **Full Attack Lab re-run after the final sprint** | `npm run attack` | **DEFERRED** (the Lab's scenarios are V1; V1 verification is unchanged and the order / settlement gates are covered by the DB suite) |
| **Real-LLM validation** | needs a key and approval | **NOT DONE (forbidden by this directive)** |
| **Real-PayPal Sandbox validation** | needs owner checkout approvals | **NOT DONE (forbidden)** |
| **Independent language / security review, external audit** | | **NOT DONE (Q12 not approved)** |
| **Production checks (TLS, secrets, distributed rate limit, CSP nonce)** | | **NOT DONE** |

### Evidence the issuing tool would need (do not issue without owner approval)
`npx vitest run tests/unit --reporter=json --outputFile=qa/unit.json`; `node --env-file=.env.local node_modules/vitest/vitest.mjs run -c vitest.db.config.mts --reporter=json --outputFile=qa/db.json`; the `mutation-layer-*.final-qa.json` reports; then `scripts/issue-v2-release.ts --evidence qa-evidence.json --out v2-release.json`.

## 16.19 Final QA results

Executed after the last code change, on the final tree (78 `src` files):

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint .` | clean |
| `npm run build` | succeeds (routes: `/`, `/api/auth/{login,logout,session}`, `/api/health`) |
| Unit suite | **933 / 933** pass (35 files) |
| PostgreSQL suite (`mandate_test`) | **562 / 562** pass (22 files); all V1 tests unchanged and green |
| Mutation `final-qa` (first run of the final tree, nothing re-run to hide a survivor) | A 17/17, B 7/7, C 21/21, D 31/31, **E 75/75, F 38/38, G 32/32** = **221/221 killed**; 0 survived, 0 invalid, 0 unreached; `src` restored byte for byte (digest `4e30b6da...85c9b`) |
| Detector evaluation | 62 fixtures (31 tuning, 31 held-out), 1 disclosed miss (`tu-uni-cyr-1`), 0 held-out misses, counts only |
| Benchmark (`final2`) | 1 workflow 829 ms, 10 concurrent 2,071 ms; 0 failed; 1 capture per deal; settlements = deals; ledger chains intact 10/10 |

The earlier `post-p7` mutation reports (200 mutants) and the `post-p2-final` and earlier sets are preserved unchanged. Layer E gained 7 mutants (runner pre-flight, negotiation), Layer F gained 14 (release gate, mirrors, terms history).

Not executed (see 16.18): migration rollback scripts, the V1 Attack Lab re-run, anything involving a real model or real PayPal, external review, production checks.

## 16.20 Final statuses (this directive)

| Item | Status |
|---|---|
| P0 | PASS (tested V1 paths) |
| P1 | PASS |
| P2 | PASS (functionally unchanged; `buildV2SignedPayload` export and the opener / writer bridge are the only integration points) |
| P3 | IMPLEMENTED and QA-executed: PASS on the evidence above |
| P4 | IMPLEMENTED and QA-executed: PASS with scripted providers only |
| P5 | IMPLEMENTED and QA-executed: PASS for the surfaces that exist |
| P7 | IMPLEMENTED and QA-executed: PASS for the mechanism; no real language / security review |
| V2 release gate | IMPLEMENTED; **CLOSED** (no release record issued; V2 cannot run in this environment) |
| Attack Lab overall | PARTIAL (not re-run) |
| Real-LLM validation | NOT DONE |
| Real-PayPal validation | NOT DONE |
| Production readiness | **NOT claimed** |

## 16.21 Unresolved decisions (unchanged, all handled fail-closed)
Q3 (signed AI switch vs derived: AI-judged V2 criteria need the deployment switch, default off), Q5 (group cap default 1, absolute 5), Q7 (no new seller disclosure), Q8 (deprecated env variables: ignored by V2), Q11 (docs/14 note stays), plus the policy decisions this directive left open: how long a retired detector remains usable by existing pins, who the real reviewers / approvers are once an authenticated UI exists, and whether to issue a release record at all.

## 16.22 Final release-readiness QA run `final-release-readiness-1` (2026-11-09)
Full report: `docs/qa/final-release-readiness-1.md`. Detector 1.1.0 (confusable-aware: `src/verification/confusables.ts`, hash `sha256:9d4511bf...4fc9`) cut unsafe passes on the merged 50-case held-out set from 7 to 2 (remaining: two English paraphrases, disclosed); it is NOT registered/released (no reviews). Review package: `docs/review/detector-1.1.0-independent-review-package.md` (native-speaker and independent security reviews NOT DONE). Final tree: unit 947/947, PostgreSQL 562/562, tsc/eslint/build clean. Mutation A-G: 235 defined; first run killed 233 and 2 Layer G survivors (P7-G38, P7-G40) were real test gaps, closed by new tests and a targeted re-run. Attack Lab on the final source: 121 scenarios / 363 runs, containment 318/318, incorrect settlement 0/363, honest completion 33/33, 0 false positives, flag detection 183/189 (the two known open gaps G26/G27); mock PayPal and scripted models only. Stage C and later stages of the directive were truncated and are NOT done; no real PayPal/LLM call, release record or V2 activation.

## 16.23 Release-readiness QA run `final-release-readiness-2` (2026-11-09)
Full report: `docs/qa/eod-release-readiness-report.md`. One consolidated mutation run 235/235 killed (src digest unchanged); unit 947/947, PostgreSQL 570/570 (the 8 new Lab cases account for +8). Stage C on disposable databases: 71/71 (V1 rows byte-identical across the V2 migrations, V2 storage constraints and refusals, documented rollback executed on a clone, backup-restore recovery). Finding: the documented rollback order in 16.4 ("withdraw V2 mandates/deals first") is not executable because attestations and term history reference the deals; drop `TermsVersion` and `TermsAttestation` first. Stage G: gate closed in every negative case; the runtime gate does not re-verify evidence hashes (only at issuance) and the record does not bind the detector or files outside `src`. Stage D (real LLM) NOT DONE (no credential). Stage E: Sandbox matrix prepared, nothing executed. Stage F: production NO-GO (no authenticated HTTP boundary for mandates/approvals, attestation signed by the application key with a caller-supplied actor, no webhooks, no deployment/operations material). V2 NO-GO.
