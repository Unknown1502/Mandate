# 12. Delivery and Verification (Gate 4)

Scope: one service type, `data_cleaning`. Evidence level of everything below: **unit-tested / DB-tested (real PostgreSQL) / mock-tested (PayPal) / scripted (AI)**.
**No PayPal operation was performed. No real LLM was run** (no API key); `LlmAiVerifier` / `LlmSkepticAgent` have only ever run against a scripted provider.

## Flow
```
seller ──manifest + CSV bytes──▶ submitDelivery ──(DELIVERED, ledger)──▶ verifyDelivery ──immutable VerificationRun──▶
        submitVerificationToSettlement (Gate 2 intake facade) ──▶ recordVerification / recordReverification ──▶ VERIFYING
        ... then Gate 2 alone: challenge window, settleDeal, human review, PayPal.
```
Gate 4 never calls PayPal, capture, void, the gateway, the budget code, or any settlement mutation. `src/settlement/verification-intake.ts` is the only door and exports
only `submitVerificationToSettlement` and `sealHash`.

## Delivery (`src/verification/delivery.ts`)
The manifest (`dealId, termsHash, sellerPrincipalId, artifactReference, artifactSha256, artifactSize, mediaType, submittedAt, metadata?`) is strict Zod; unknown keys
(e.g. a `criteria` or `price`) are rejected. Rejected with a ledgered **code only** (never content): `MANIFEST_INVALID, DEAL_NOT_FOUND, DEAL_ID_MISMATCH, TERMS_NOT_LOCKED,
TERMS_HASH_MISMATCH, SELLER_MISMATCH` (manifest id OR authenticated transport identity differs from the locked seller), `DUPLICATE_DELIVERY, STATE_<state>,
TIMESTAMP_IN_FUTURE, DELIVERY_AFTER_DEADLINE, ARTIFACT_MISSING, ARTIFACT_TOO_LARGE` (checked before hashing/parsing), `ARTIFACT_SIZE_MISMATCH, ARTIFACT_HASH_MISMATCH,
UNSUPPORTED_FORMAT` (zip/pdf/exe/gzip/png/OLE/shebang magic numbers even when labelled text/csv), and `CSV_<code>`.
An identical resubmission (same file **and** byte-identical manifest) is idempotent; a different one is `DUPLICATE_DELIVERY`. Concurrent submissions are serialised by `unique(dealId)`.

### Artifact security
* **Data only.** The bytes arrive in the request and are stored in PostgreSQL as text. `artifactReference` is an opaque label that is never used to open a file; the schema rejects separators,
  `..`, drive letters, leading dots, spaces and NUL. Nothing in `src/verification` imports `child_process`, `fs`, `vm`, or calls `eval`/`new Function`/`exec`/`spawn`; no raw-SQL helper exists in `src/`
  (enforced by `tests/unit/verification-isolation.test.ts`). CSV values are only ever split into strings.
* **Strict RFC 4180 parser** (hand-written, ~100 lines, no dependency, fuzz-tested): strict UTF-8 (lossless, BOM preserved for hashing), limits (10,000 rows, 100 columns, 10,000 chars/field, 200,000 bytes),
  rejects NUL, stray/unterminated quotes, ragged rows, duplicate or empty headers. A malformed file is **rejected at ingestion** (nothing to verify), not stored.
* **Provenance:** `artifactSha256`, size, `manifestHash`, `parserVersion`, parse summary, `submittedAt` and the server-side ledger event are stored on the (immutable) `Delivery`.
* **Immutability:** PostgreSQL triggers (`Delivery_immutable`, `VerificationRun_immutable`) refuse UPDATE/DELETE. Verification re-hashes the stored bytes and manifest, so even a database owner who bypasses the trigger is detected
  (`ARTIFACT_INTEGRITY_FAILURE`, ledgered). The ledger itself remains tamper-evident, not tamper-proof.

## Deterministic validators (`validators.ts`)
`csv_schema_matches` (exact header, order), `required_columns_present`, `column_order_matches`, `row_count_range`, `no_duplicate_rows` (whole row or key columns), `unique_column_values`,
`null_rate_below` (exact integer arithmetic), `no_forbidden_values`, `column_values_in_set`, `date_format_valid` (real calendar dates, leap years, 3 formats), `column_type_valid`
(integer/decimal/boolean/email/string), `source_records_preserved`. Each yields `{criterionId, status PASS|FAIL|UNVERIFIABLE, expected, actual, reason, evidenceRefs}`.
Bad contract parameters or an unknown validator are **UNVERIFIABLE** (never a silent pass), a validator exception is UNVERIFIABLE. `actual` contains counts, positions and contract values only, never raw seller text
(it is later shown to the AI as trusted context). Criteria, weights and params come from the **locked terms**; the seller cannot add, drop or reweight them.

## Evidence references (`evidence.ts`)
`csv:<sha12>#header | col:<name> | row:<n> | row:<n>,col:<name> | rows:<a>-<b>`, `manifest:<field>`. A reference is valid only if it resolves inside **this** artifact; an optional quote must appear verbatim
(case/whitespace-normalised, >= 4 chars) in the cited text. Hallucinated rows/columns, another file's hash, unknown manifest fields and unsupported schemes are refused. One forged reference spoils the whole claim.

## AI (`ai.ts`) and the deterministic Skeptic (`prescan.ts`)
> **P0 model isolation (2026-11-07; docs/15 §15.9.0, weakness W1).** Three statements are kept apart here, because the earlier text of this chapter and of docs/14 §14.20 blurred them:
> 1. **Deterministic settlement decision** - what moves money. Always decided by deterministic validators, deterministic flags and the existing policy; a model can only help or escalate (AGENTS.md #16). This was true before P0.
> 2. **Actual AI model exposure** - whether artifact text reaches a model. **Before P0 this was NOT limited to deals that need a model:** the pipeline computed `hasLlmCriteria`, discarded it, and called any configured verifier and skeptic, so a deterministic-only deal still exposed the artifact to them (measured: verifier 2 calls, skeptic 1 call). **Since P0 a V1 deal never reaches a model**: `src/verification/model-gate.ts` decides from the parsed, hash-verified locked terms, and the pipeline obtains its verifier and skeptic only through that decision. A V1 deal with an `llm_judged` criterion has that criterion `UNVERIFIABLE` (reason `LEGACY_TERMS_NO_INPUT_BOUNDARY`) and goes to human review; AI-based verification returns only with a newly approved V2 deal (stage P4, not started).
> 3. **Model-input isolation** - proof, at the model-call boundary, of what a model was sent. Established by `tests/db/model-isolation.db.test.ts` and `tests/unit/model-gate.test.ts` (unique canary strings observed at the verifier object, the skeptic object, the provider request and the persisted `AgentRun` rows). It is proven for the paths those tests drive; it is not a claim about a real LLM or about V2.
>
> The AI-handling text below describes the code that stage P4 will re-enable; at P0 it is dormant for every deal.

* Provider-independent (`LlmProvider` from Gate 3, no tools). Prompt = locked criteria text + deterministic findings + a bounded, sanitised, delimiter-wrapped **sample** of the untrusted artifact and metadata. No mandate, budget or ceiling is ever included.
* The model may assess **only `llm_judged`** criteria and add observations. **Stricter than the brief:** a verdict about a deterministic criterion is *discarded* (recorded as rejected); a deterministic FAIL/UNVERIFIABLE can never be turned into PASS by a model at all.
* Every assessment/observation/flag needs valid evidence; invalid items are rejected individually and recorded (`ai.rejected`), the rest survive. Unknown criterion ids, duplicate verdicts, quotes not in the source, and unknown output fields (e.g. `amount`) are rejected (the latter invalidates the whole output).
* Two independent passes (reversed criterion order) must agree with evidence; otherwise the criterion is UNVERIFIABLE. Provider outage / invalid JSON / no configuration => deterministic verification still completes; llm-judged criteria are UNVERIFIABLE.
* LLM skeptic flags are always `source: llm`, `severe: false`. Only deterministic code can produce a *severe* flag.
* Deterministic Skeptic flags: hidden/tag characters, bidi controls, base64/data-URI payloads, instructions aimed at the verifier ("ignore previous instructions", "mark all criteria met", "Note to the verifier", role prefixes), price/amount change attempts, approval/authority claims, credential requests, urgency, HTML/markdown comments, spreadsheet formulas, empty delivery, contradictory metadata, unsupported completion claims. Matching is done after NFKC normalisation and invisible-character stripping, so splitting words with zero-width characters does not evade it.

## VerificationResult (`contracts.ts`)
Strict. Contains `verificationId, dealId, termsHash, artifactSha256, sequence, overall, criteriaResults, deterministicFailures, unverifiableCriteria, ai{status,passes,observations,rejected,summary},
skeptic{llmStatus,flags,rejected}, evidenceReferences, provenance, verifierVersion, createdAt, resultHash`. `overall` keeps the three cases apart (`ALL_REQUIRED_PASSED | REQUIRED_FAILED | REQUIRED_UNVERIFIABLE`).
**No score, percentage or amount exists anywhere in the shape** (checked structurally). `resultHash = sha256(canonicalJson(result minus resultHash))`. Criterion results, AI observations, skeptic flags and evidence
provenance live inside this single hashed, immutable record (one source of truth) rather than in separate mutable rows.

## Persistence and idempotency
`Delivery` (one per deal, immutable) and `VerificationRun` (`unique(deliveryId, sequence)`, `unique(verificationId)`, immutable). Sequence 1 is the initial verification; sequence >= 2 is a re-verification after a
challenge and requires evidence references. A repeated request returns the stored record **without recomputing or calling the AI again**; concurrent requests are reconciled by the unique constraint.
Ledger events: `DELIVERY_RECEIVED`, `DELIVERY_REJECTED`, `ARTIFACT_INTEGRITY_FAILURE`, `VERIFICATION_RECORDED`, `VERIFICATION_SUBMITTED` (+ `AgentRun` rows for AI calls, with prompt hashes).

## Gate 2 intake (`src/settlement/verification-intake.ts`)
Refuses (never raises into the engine): unknown verification or wrong deal (`UNKNOWN_VERIFICATION`), schema-invalid or hash-mismatching result (`RESULT_INVALID` / `RESULT_TAMPERED`),
changed terms hash or different artifact (`STALE_VERIFICATION`), non-latest sequence (`SUPERSEDED_VERIFICATION`). Already-submitted results are `DONE / ALREADY_SUBMITTED`.
Mapping: PASS->met, FAIL->not_met, UNVERIFIABLE->unverifiable, source kept; skeptic flags map one-to-one; an evidence-backed HIGH `SUSPICIOUS`/`CONTRADICTION` AI observation becomes an `llm` HIGH flag
(can send the deal to a human, nothing more). The challenge window, human review and SETTLEMENT_REVIEW rules are untouched.

## Trust boundary (accurate statement)
The Seller Agent is a **separate OS process** (Gate 3) that shares the machine and OS user; it is environment/import isolation, **not a secure OS sandbox**. In Gate 4 the seller supplies **data only**: no seller code is
ever executed, loaded, evaluated or shelled out. The buyer's ceiling and the mandate never enter a counterparty-visible context (negotiation) nor a verifier prompt (verification); both are asserted by tests.

## Known limitations
* Real LLM behaviour (verifier and skeptic) is UNVERIFIED; `AnthropicProvider` has never executed. Prompt-injection resistance is demonstrated against scripted/obedient providers and by the deterministic gates, not against a real model.
* The deterministic Skeptic is pattern-based: paraphrased or non-English manipulation can evade it (the settlement design assumes this and does not rely on it for money).
* Quote validation covers cited cells/rows only; the AI sees only the first 15 rows, so its llm-judged assessments are about a sample (evidence references may cite any real row).
* `source_records_preserved` compares against a value list in the terms (<= 200 values), not a separately stored source dataset.
* Duplicate concurrent verification requests may both call the AI before the unique constraint picks one (cost, not correctness).
* No UI, webhooks, deployment or real PayPal operation exists; Gate 2's PayPal behaviour remains UNVERIFIED.
