# MANDATE — End-of-day release readiness report (QA run `final-release-readiness-2`, 2026-11-09)

Written for: the project owner, who decides what happens next. Supersedes nothing: `docs/qa/final-release-readiness-1.md` and every earlier report are preserved.

## 1. Executive recommendation

| Decision | Verdict | Why (one line) |
|---|---|---|
| **Production release** | **NO-GO** | No authenticated HTTP boundary exists for mandate creation, approval, negotiation, delivery or settlement; no webhook, deployment, monitoring or operations material; no real LLM or real Sandbox lifecycle evidence |
| **V2 release** | **NO-GO** | Gate closed, no release record issued; detector 1.1.0 unreviewed and unregistered; native-speaker and independent security reviews NOT DONE; two unsafe passes and two language misses remain |
| Sandbox integration | **BLOCKED on owner approval** | Matrix prepared (`docs/qa/final-release-readiness-2.sandbox-matrix.md`); no order created, no PayPal call made |
| Internal engineering quality | Good on the evidence below | Everything that can be tested locally with mocks and scripted models passes |

**Single most important remaining release blocker:** a domain-level attestation or approval is not bound to an authenticated human. The approval functions take `principalId` / `principalEmail` as caller-supplied parameters, sign with the application's own key, and no HTTP route calls them (only `login`, `logout`, `session`, `health` exist).

## 2. Identity of what was tested

| Item | Value |
|---|---|
| Git commit | **none — the project is not a git repository** (`git rev-parse` fails); identity is recorded by hashes |
| Source manifest (92 files: `src/**`, `prisma/migrations/**`, `schema.prisma`, `package.json`, `package-lock.json`) | `sha256:428b53c6d3a57ce23a510c163c826175f5695c42258885370748c6566d31e84e` — identical at the start of A0, after A0, and at the end of the run; **no `src` change was made in this run** |
| `src/**` digest used by the mutation tool (79 files) | `853182b911ba4506e57a252cb02464343a79884d6a940ccf7daf47891b5f9a82` before and after |
| Tests + harness manifest at A0 start (100 files) | `50a6a970038c514d657998cc9b162bb06e32c2631dd257b965244d41e5f006c4` (`attack-lab/final-release-readiness-2.a0-pre.txt`) |
| `.spike/state.json` | sha256 `a47b3ae205b9399ace7e72139b907cae2f9d762cf6b8d09822460c645037113d`, mtime 2026-11-05 22:55 — unchanged |
| Detector | `mandate-lexical-detector` 1.1.0, `sha256:9d4511bf447ce787db33ccdcc5f249d1f3f8c54c591cc5ca96d6ebd717754fc9`; unregistered, unreviewed |
| Background processes at the end | none (no vitest, mutation, Lab or build process running) |

## 3. Stage results

| Stage | Result | Notes |
|---|---|---|
| Section 1 / A / B (earlier, `final-release-readiness-1.md`) | accepted as recorded | unchanged |
| **A0 consolidated mutation run** | **PASS** | one run, label `final-release-readiness-2-a0`: 235 defined, 235 killed, 0 survived, 0 invalid, 0 unreached; src restored byte-for-byte (79 files) with equal digests |
| **C disposable DB migration / fixtures / recovery** | **PASS (71/71)** | see §5 |
| **D real LLM validation** | **NOT DONE** | `ANTHROPIC_API_KEY` (and any other provider key) is absent or empty in the environment; `AnthropicProvider` exists but has never been executed (its own header says so). No substitute (scripted or other) was used |
| **E1 Sandbox read-only configuration** | **PASS (config level only)** | `PAYPAL_ENV=sandbox`, base `https://api-m.sandbox.paypal.com`, both enforced as exact literals by the env schema; no PayPal API call was made, so account ownership/aliases are NOT verified |
| **E2 transaction matrix** | **PREPARED, awaiting approval** | 10 cases S0–S9, funds held ≤ USD 5.00, captured ≤ USD 2.50; the four spike orders excluded |
| **E3 real Sandbox lifecycle** | **NOT DONE** | needs matrix approval, account aliases, and per-operation approval; none was given |
| **F security / production-readiness assessment** | **COMPLETE; 4 release blockers** | see §7 |
| **G V2 release-gate negative validation** | **PASS for what the gate checks; 2 directive cases not testable** | see §8 |
| **H1 V1 end to end (fixtures, mock PayPal)** | **PASS** | see §9 |
| **H2 V2 pre-release behaviour** | **PASS for fail-closed behaviour; operational V2 E2E BLOCKED — V2 intentionally disabled** | see §9 |
| **H3 final integrity checks** | **PASS** | see §10 |

## 4. Commands executed and exit codes (this run, final tree)

| Command | Exit | Result |
|---|---|---|
| `attack-lab/mutate-layers.ts --suite all --label final-release-readiness-2-a0` | 0 | 235/235 killed |
| `npx tsc --noEmit` | 0 | clean |
| `npx eslint .` | 0 | clean |
| `npm run build` (log `docs/qa/final-release-readiness-2.build.log`) | 0 | succeeded |
| `npx vitest run tests/unit --reporter=json` | 0 | **36 files, 947/947** (`final-release-readiness-2.unit-tests.json`) |
| `npm run test:db --reporter=json` (`mandate_test` only) | 0 | **22 files, 570/570** (`final-release-readiness-2.db-tests.json`). The earlier 562 became 570 because `attack-lab.db.test.ts` now includes the 8 new homoglyph Lab cases (I7a–I7h) |
| `scripts/qa-stage-c.ts` | 0 | 71/71 (final run) |
| `scripts/qa-stage-g.ts` | 0 | 50/50 |
| `vitest run tests/unit/v2-release-gate.test.ts`; `test:db tests/db/v2-negotiation.db.test.ts` | 0 | 12/12 each |
| `npm audit --omit=dev` | 1 | 3 high-severity advisories (see §7). Sends dependency names and versions to the npm registry, nothing else |

Run boundaries: the mutation figures above are from **one** run. The two earlier runs (`final-release-readiness-1`: 233 killed + 2 survivors; `final-release-readiness-2` targeted: 2 killed) are preserved and are not merged into it. Attack Lab figures are from the earlier B3 run (`final-release-readiness-attack-lab-1`), which used the **same** source manifest as this report (no `src` change since).

## 5. Stage C — migration, fixtures, recovery (evidence: `docs/qa/final-release-readiness-2.stage-c.json`)

* **Database identity:** newly created `mandate_qa_c_261109…_a` / `_rb` / `_rs` on the local Docker PostgreSQL 16.15 (`127.0.0.1:55432`, container `mandate-pg`). The runner refuses any other host/port and any name not matching the disposable pattern. `mandate_test` and `mandate` were **only counted, read-only**, before and after: identical (`mandate_test`: 33,766 mandates, 33,806 deals, 864,823 events; `mandate`: empty). All three disposable databases were dropped afterwards. No `prisma migrate reset`, no truncate, nothing against `mandate_test`.
* **Process:** Prisma `migrate deploy` of the 6 pre-V2 migrations → V1 fixtures seeded by raw SQL under the old schema → `pg_dump` snapshot → `migrate deploy` of the 3 V2 migrations (history: 9 finished, none rolled back).
* **V1 preservation:** row counts unchanged (3 users, 6 mandates, 2 deals); content of every pre-existing column byte-identical after the migrations (hash over the old column list); all mandates got V1 defaults; the three golden shapes (`V1_BASE`, `V1_NO_CANCELLATION_FLAG`, `V1_FULL`) re-canonicalise to the stored text and digest and open as version 1 on the migrated schema; digest-mismatch, stale-signature and foreign-key mandates are refused; legacy locked terms read, and a changed stored hash fails the lock check; three concurrent V1 reservations of 60.00 against a 100.00 budget → exactly one succeeds.
* **V2 storage integrity (ephemeral keys only, no release record, no operational V2 flow):** valid sealed mandate verifies; refused: digest mismatch, tampered signature, unknown key, revoked key, unknown/missing envelope fields, wrong mandate id, wrong nonce, non-canonical text. `openMandateRow` returns null for the V2 row while the gate is closed. DB CHECKs reject a malformed nonce, a nonce on a V1 seal and a non-cuid V2 id. Attestation verifies against the re-derived binding and is refused for: other terms hash, other mandate digest, other deal, other actor, revoked key, unknown key, edited payload, malformed signature; it is immutable (UPDATE/DELETE refused); a second attestation per deal, a reused nonce and a non-human kind are refused; 3 concurrent attestations for one deal → exactly 1 stored. Terms history: duplicate version, bad hash, UPDATE and DELETE all refused. Detector releases: illegal transition, content change and delete refused; a legal transition accepted; no release row exists for `mandate-lexical-detector`.
* **Recovery — two different things, not conflated:**
  1. **Documented schema rollback** (the DROP statements in the migration headers / `docs/16` §16.4) was **executed on a clone**: schema afterwards equals the pre-migration schema; seeded V1 rows byte-identical; rolling forward again reproduces the migrated schema. Finding: **the documented order is not executable as written** — "withdraw V2 mandates/deals first" fails because attestations and term-history rows reference the deals (and attestations are immutable); the dependent tables must be dropped first. The runner's corrected order is recorded in the evidence file; the docs should be amended.
  2. **Backup-restore recovery:** the pre-migration `pg_dump` was restored into a separate database: schema equals the pre-migration schema, counts and row content equal; rolling forward reproduces the migrated schema.
* Prisma has no down migration; none was invented.
* **Run history, for honesty:** run 1 = 68/71 (three assertions matched only constraint names, but the database had refused each insert with SQLSTATE 23505 — a test-script error); run 2 = 71/71 but its "untouched databases" probe queried a table that does not exist and compared two errors, i.e. was vacuous; run 3 (final) fixed the probe and fails on any probe error. Evidence of runs 1 and 2 is kept beside the final file. No `src` file was changed.

## 6. Stage D and E — what was and was not obtained

* **D — NOT DONE.** Missing prerequisite: a configured model-provider credential. No call to any model provider was made. The predeclared case list was not written because it cannot be run; scripted-model evidence (B3) must not be read as real-LLM evidence. Stage D remains the largest unverified area for V2 (and for any AI-judged criterion).
* **E — config PASS, lifecycle NOT DONE.** See `docs/qa/final-release-readiness-2.sandbox-matrix.md`. Open items for the owner: name the dedicated buyer and business Sandbox accounts, confirm the REST app belongs to the business account, approve or amend the matrix, then approve each state-changing operation separately. The four spike orders were not touched and were not queried.

## 7. Stage F — security and production-readiness assessment (read-only; code inspected, nothing deployed)

| # | Area | Finding | Status |
|---|---|---|---|
| 1 | Human identity at mandate creation / approval / negotiation / delivery / settlement | One principal configured by environment (`PRINCIPAL_EMAIL`, `PRINCIPAL_LOGIN_SECRET`), constant-time compare. **No HTTP route exists for mandates, deals, approvals, deliveries or settlement** (routes: login, logout, session, health). The UI is not started | **RELEASE BLOCKER** |
| 2 | Is the domain attestation bound to an authenticated human? | **No.** The actor id/label in the attestation are caller-supplied strings (`deal-approval.ts`), the signature is made with the **application's** key, and nothing ties a session to the call. The attestation proves the application attested; it does **not** by itself prove an authenticated human authorised the deal | **RELEASE BLOCKER** |
| 3 | Server-side / object-level authorization | Domain functions check ownership (`loadOwnedDeal(tx, id, principalId)`) but `principalId` is optional in several APIs (negotiation, lock, policy, reservation), so enforcement depends on every future caller passing it | PARTIAL |
| 4 | Sessions, cookies, CSRF, origin | HMAC-signed stateless token, strict payload schema, 8 h TTL; cookie `HttpOnly`, `SameSite=Strict`, `Secure` only when `NODE_ENV=production`; mutations require Origin match + synchroniser CSRF token. No server-side revocation (logout only clears the cookie; a copied token works until expiry), no rotation, single shared secret | PARTIAL |
| 5 | TLS, headers, CSP, CORS, redirects | Headers set in `next.config.ts` (CSP with `'unsafe-inline'` for scripts/styles, HSTS, frame deny, nosniff, no-referrer, COOP/CORP, `no-store` on `/api`). No CORS configuration (same-origin default), no redirects. TLS termination is deployment-dependent and not configured anywhere; headers were inspected in config, not against a running deployment | PARTIAL |
| 6 | Rate limiting | In-memory, **per process** (documented); login limited to 5/min per client key and 60/min globally. The client key comes from `X-Forwarded-For`, which a client can set unless a trusted proxy overwrites it; the global ceiling means an attacker can exhaust the 60/min and lock the legitimate user out. No distributed store | PARTIAL |
| 7 | Replay, idempotency, nonces, concurrency | Single-use approval nonce (unique column + ledger event), deterministic PayPal request ids, reservation under mandate row lock; concurrency verified on PostgreSQL (Stage C: 1 of 3 attestations, 1 of 3 reservations) and in the DB suite. PayPal behaviour itself is mock-only | PASS (domain, mock PayPal) |
| 8 | PayPal webhooks | **Not implemented** — only an optional `PAYPAL_WEBHOOK_ID` variable and a comment that finalizers use a fresh GET. No signature verification, replay or reconciliation path | NOT DONE |
| 9 | Secrets | `.env.local` holds the PayPal client secret, signing private key, session secret and login secret in plaintext; **the project sits under `OneDrive\Desktop` (cloud-synced) and is not a git repository**, so `.gitignore` protects nothing. No secret manager, rotation procedure, or access boundary. `redact()` strips named PayPal fields from stored payloads (key-name based). Nothing was printed in this run | PARTIAL — fix before any shared use |
| 10 | Audit log, retention, monitoring, incident response | `DealEvent` is a hash-chained ledger checked by `checkIntegrity`, but has **no database immutability trigger** (triggers exist only for `VerificationRun`, `Delivery`, `TermsAttestation`, `TermsVersion`, `DetectorReleaseEvent`) and V1 events are hashed, not signed: tamper-evident for a casual edit, not tamper-proof against someone who can rewrite the whole chain. No retention policy, alerting, monitoring or incident runbook exists | PARTIAL / NOT DONE |
| 11 | Dependencies / supply chain | `npm audit --omit=dev`: **3 high** (DeepmergeTS stack exhaustion, reached through `prisma` → `@prisma/config`; build/migration tooling, not the request path; the suggested fix is a major upgrade to Prisma 7). Versions are exactly pinned, 522 lockfile entries carry integrity hashes. No CI, SBOM, provenance or signed builds; the Prisma CLI is listed under `dependencies` | PARTIAL |
| 12 | SSRF, injection, uploads, untrusted content | Seller client: http(s) only, host allow-list (loopback by default), timeouts, 64 KB response cap; request bodies are size-bounded and parsed with a strict JSON parser; delivery artifacts are size-capped (200,000 bytes) and scanned under a deterministic work budget; the seller service binds `127.0.0.1` and is a **separate process, not an OS sandbox**. I did not audit every `$queryRaw` call site | PARTIAL |
| 13 | Deployment configuration and operations | No Dockerfile, CI, infrastructure code, health/readiness beyond `/api/health`, backups schedule, or runbook in the repository. The environment schema does enforce Sandbox-only PayPal | NOT DONE — release blocker for production |

Release blockers from this stage: #1, #2, #13 and the absence of #8 if payments are to be reconciled in production.

## 8. Stage G — V2 release-gate negative validation (V2 stayed closed throughout)

Evidence: `docs/qa/final-release-readiness-2.stage-g.json` (50/50), plus the existing gate suites. **No release record — valid, fake, temporary or unsigned — was created**; the script hands the real loader only garbage/empty/structurally invalid files.

| Directive case | Result |
|---|---|
| Opt-in disabled (unset, empty, `false`, `TRUE`, `1`, `yes`, padded, `on`) | closed in all variants; exactly `"true"` without a record also closed |
| Release record missing / unreadable / garbage / `{}` / `[]` / `null` / oversized / duplicate keys / extra field / unsigned / forged signature | closed (with and without a trusted key) |
| Invalid signature, untrusted/revoked/disabled key, altered payload, non-canonical payload, expired, future-dated, over 30 days, wrong source digest, a requirement missing or FAIL | closed — covered by `tests/unit/v2-release-gate.test.ts` (12/12 pass) and mutation Layer F (38/38 killed) |
| Source tree unavailable | closed |
| V2 writer without an open gate (none, `{}`, forged gate-shaped objects) | `V2DisabledError` before any database access |
| V2 mandate row | `openMandateRow` returns null without a gate, also for a forged gate-shaped object |
| Detector 1.1.0 pinned by a new mandate | refused: no verified RELEASED release exists (`detectorPermission` false for NEW_PIN and EXISTING_PIN; no release row in the database) |
| No runtime bypass | unit test asserts the gate/loader read no environment and export no setter; grep of `src` found no test-only bypass; the real environment has the flag and record path unset |
| **Evidence artifacts missing / evidence hashes do not match** | **Not enforced at runtime.** The gate checks only that each requirement carries a well-formed 64-hex `evidenceSha256`; the evidence files are verified only by `scripts/issue-v2-release.ts` when a record is issued. Assurance therefore rests on the issuing tool and the custody of the signing key |
| **Detector or environment mismatch vs the record** | **Not representable.** The record binds a digest of `src/**` only; it does not name the detector, and the digest excludes migrations, `package*.json`, `prisma/schema.prisma` and scripts. Also, `loadV2Gate` has no caller in `src` yet (no composition root) |

Stage G acceptance as written is met for every case the gate implements; the two rows above are gaps in the gate's design, reported rather than patched (a source change would have required a fresh validation; none was made).

## 9. Stage H

**H1 — V1 end to end (PostgreSQL `mandate_test`, mock PayPal, scripted/absent models), 22 files, 570/570:** mandate and terms compatibility (`authorization-readers` 39); negotiation and terms drift (`negotiation` 23, `lifecycle` 14); delivery and evidence intake (`delivery` 29, `delivery-clock` 6); V1 model isolation (`model-isolation` 18, `p0-reachable-scan-defences` 5); verification and human review (`verification` 36, `verification-integration` 20, `review-policy` 27); settlement re-derivation, idempotency, no capture on failed/unverifiable/unauthorised paths (`engine` 50, `orchestration` 32, `survivor-gate-masking` 19, `dormant-downstream-defences` 19, `budget` 6, `ledger` 7); plus the Attack Lab (121 scenarios, 363 runs, 0 breaches, 0 incorrect settlements — earlier B3 report). **External integrations used: none.** PayPal = in-memory mock; models = scripted or not called; the database is real PostgreSQL.

**H2 — V2 pre-release:** entry points reject while the record is absent and the flag is off (Stage G); V2 seal verification and strict parsing behave correctly on isolated fixtures, including every refusal in §5; V2 domain/policy suites pass (`v2-authorization` 25, `v2-verification` 29, `v2-enforcement` 14, `v2-negotiation` 12; unit suites for terms, lattice, attestation, model input/runner). **Operational V2 end to end: BLOCKED — V2 intentionally disabled.** Note that those DB suites build an in-memory test gate inside test helpers (never in `src`, never persisted); they are not evidence that a real release is possible.

## 10. H3 — final integrity

`.spike/state.json` unchanged (hash and mtime); the four spike orders not touched or queried; **no PayPal API call of any kind was made in this run** (E1 was configuration only; the Lab and tests use the mock); no capture/authorization/void/refund; no V2 release record issued, `issue-v2-release.ts` not run, `MANDATE_V2_ENABLED` and `MANDATE_V2_RELEASE_RECORD` unset; the only external network call was `npm audit` to the npm registry; no real LLM call; final source manifest equals the manifest at the start; no process still running; all historical reports preserved (new files carry the `final-release-readiness-2` label).

## 11. Remaining gaps that must stay visible

* Detector 1.1.0: 2 unsafe passes (`ho2-pa-1`, `ho2-pa-2`, English paraphrases) and 1 false block (`ho2-ok-2`) on the 50-case set; that set guided the fix, so it is **not** an independent held-out evaluation. G26 (Swahili) and G27 (Vietnamese) remain open language-detection misses (contained only because V1 never calls a model). Native-speaker review: **NOT DONE**. Independent security review: **NOT DONE**. No reviewer is recorded.
* Q3 / Q5 / Q7 / Q8 / Q11 (owner decisions) remain unresolved and are handled strictest / fail-closed.
* Rollback documentation for the V2 migrations needs the corrected order (§5).
* Gate design gaps in §8.

## 12. What I need from the owner

1. Sandbox: name the dedicated buyer/business accounts and approve or amend the matrix — then per-operation approvals.
2. Real LLM: provide a test provider credential (and a cost ceiling) if Stage D should run.
3. Decide whether to close the Stage F blockers (authenticated HTTP boundary bound to attestations) before any Sandbox work that exercises the full flow.
4. Name real reviewers for the detector if V2 is ever to be considered.

## 13. Evidence files (all new, none overwritten)

`attack-lab/final-release-readiness-2-a0.mutation.log`, `attack-lab/reports/*final-release-readiness-2-a0*`, `attack-lab/final-release-readiness-2.a0-pre.txt`, `docs/qa/final-release-readiness-2.stage-c.json` (+ `.run1-68of71.json`, `.run2-71of71-vacuous-untouched-probe.json`), `docs/qa/final-release-readiness-2.stage-g.json`, `docs/qa/final-release-readiness-2.unit-tests.json`, `docs/qa/final-release-readiness-2.db-tests.json`, `docs/qa/final-release-readiness-2.build.log`, `docs/qa/final-release-readiness-2.sandbox-matrix.md`, `scripts/qa-stage-c.ts`, `scripts/qa-stage-g.ts`.
