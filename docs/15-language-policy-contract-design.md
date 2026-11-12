# 15. Language Policy & Contract Architecture — Design Proposal

**Status: DESIGN ONLY — REVISION 2. NOTHING IN THIS DOCUMENT IS IMPLEMENTED. AWAITING EXPLICIT HUMAN IMPLEMENTATION APPROVAL (decisions in §15.0A are architectural direction only).**
Date: 2026-11-07. Author: engineering agent. Evidence level of every *proposal* below: **none yet (paper design)**. Evidence level of every statement about *current* behaviour is stated inline (code-read, DB-read, or measured by a read-only probe).

This phase changed **no** application source, **no** Prisma schema or migration, **no** canonical terms, **no** signature, **no** mandate record, **not** `.spike/state.json`. No PayPal call (real or Sandbox), no real LLM call, no Sandbox order approval/capture/void/refund, no webhook, UI or deployment, no code sent to an external auditor, no secret printed or rotated. The attack-lab overall gate remains **PARTIAL**; this document does not change it.

Nothing here may be implemented without a human approval of §15.16 (open questions), because it changes signed contracts and the database. Per `~/.claude/CLAUDE.md` the eventual implementation is **`deep`** (auth/crypto-adjacent, data model, signed contract); the standing rule "no code to an external auditor without approval" still applies and approval has not been granted.

## 15.0A Revision 2 (2026-11-07): owner decisions and decision matrix

The owner reviewed Revision 1 and approved the decisions below **as architectural direction only. This is NOT implementation approval.** No application source, Prisma schema, migration, canonical term, signature, mandate record or `.spike/state.json` was changed in this revision; no PayPal or LLM call was made; no webhook, UI or deployment was started. The attack-lab overall gate remains **PARTIAL**.

### Decision matrix

| Item | Decision | Main design consequence | Specified in |
|---|---|---|---|
| **Q1** TermsAttestation | **APPROVED.** Mandatory for V2 deals that enable `llm_judged` criteria; preferred for all settleable V2 deals if the existing workflow supports it without weakening legacy behaviour. Must bind deal ID, mandate ID + digest, terms hash, schema version, language-policy hash, criterion-to-field mappings, approving actor, approval timestamp, approval nonce. An Ed25519 attestation proves the **application recorded an approval event**; it is not the user's own signature. | New `TermsAttestation` object with its own signed payload and purpose tag; engine refuses V2 deals without a verifying attestation; code-read shows the existing workflow can host it for V2 only (§15.5.4). | §15.5.4, §15.11 |
| **Q2** Human approves mapping | **APPROVED.** The approving human sees every criterion, its type, permitted input fields, fields excluded from models, the language policy and the consequence of unsupported/uncertain language. The exact mapping is inside the terms hash and the attestation. Any later change = terms drift + reapproval. | LLM-criteria V2 deals can **never** skip human pre-authorisation review; two-step digest confirmation reused. | §15.5.5 |
| **Q4** Stop model calls for V1 deterministic-only deals | **APPROVED** as a **security correction (P0)**. V1 deterministic-only: no verifier, no skeptic, no secondary path. V1 deals needing LLM criteria: AI stays blocked pending a newly approved V2 deal. V1 payloads and signatures preserved. | P0 stage; model-boundary canary tests; V1 never calls a model. | §15.9.0, §15.10, §15.14.2 |
| **Q6** Name-like tokens | **UNCERTAIN for model-visible tokens.** OPAQUE names/addresses/short tokens are never sent to a model. Uncertain model-visible tokens never auto-pass: `UNVERIFIABLE` + human review. Not every short string is treated as malicious. `ALLOW_COUNTED` is **not** a permitted shortcut. Prefer deterministic matching for names and identifiers. | `nameLikeBehavior` collapses to the single value `UNCERTAIN`; "uncertain" is a verification status, not an injection flag. | §15.3.3, §15.9.2 |
| **Q9** Budget carry-over | **No automatic carry-over.** Exceptional carry-over only as an explicit human-approved authorisation inside the new signed mandate, with previous-mandate reference, remaining eligible amount, outstanding reservations, new ceiling and atomic closure/reconciliation of the old mandate; no double reservation across versions. | `carryOver` reserved (null) in the V2 document; full specification written; implementation deferrable. | §15.19 |
| **Q10** Detector governance | **Independent review required** (language review, security review, immutable hashed artifacts, reproducible/held-out evaluation, explicit release approval and audit history). More-permissive changes never silently affect an approved mandate; stricter deployment restrictions may apply without weakening it. No universal-robustness claim. | Detector release process and permissiveness rule. | §15.18 |
| **Q12** External audit | **NOT APPROVED at this stage.** Prepare an independent audit scope only. Nothing (code, credentials, env files, signing material) is sent to any external party without separate explicit approval. | Audit scope prepared, nothing sent. | §15.20 |
| **W1** deterministic-only model exposure | **P0.** Before any V2 work: zero model invocations for deterministic-only deals; no indirect leakage via metadata, agent context, logs or secondary calls; unique canary strings at every model-call boundary; **no successful verification if the model-input isolation check fails.** | Runtime `ModelGate` + provider guard + post-call isolation assertion; stage P0. | §15.9.0 |
| **Signature scope** | **Verify precisely; do not assume** that extra JSON fields are authenticated. Define and test a **new V2 canonical signed payload** that explicitly includes the language-policy floor and the authorisation fields. V1 signature verification unchanged. Unknown/unsupported schema versions fail closed; no downgrade parsing or silent field dropping. | Experiment run (§15.5.1); exact V2 payload and verification algorithm (§15.5.2–3). | §15.5 |
| **Q3, Q5, Q7, Q8, Q11** | **UNDECIDED. No decision is inferred.** Full text, options, trade-offs and recommendations reproduced. | — | §15.16.2 |

### What changed in this revision
* §15.5 rewritten: verified scope of the existing seal (with an experiment), exact V2 seal payload and verification algorithm, `TermsAttestation` specification, human-approval preview.
* New §15.9.0: P0 model-isolation guarantee. §15.9.1/§15.9.2 amended (V1 never calls a model; name-like tokens).
* §15.10 rewritten: updated migration/compatibility plan incorporating Q1, Q4, Q6, Q9, Q10 and the compatibility matrix.
* §15.14.2 re-ordered: **P0 is now the W1 fix**; V2 stages follow.
* §15.16 rewritten: decided items recorded, remaining questions Q3/Q5/Q7/Q8/Q11 in full, new questions Q13–Q17 raised by this revision.
* New §15.18 detector governance, §15.19 carry-over specification, §15.20 independent-audit scope (prepared, **not sent**).

### Evidence added in this revision (all read-only)
* **Seal-scope experiment** with a throwaway in-memory key (§15.5.1); no DB, no repo change, no key printed.
* **Buyer-agent prompt trace** (code-read): the buyer prompt is built from task description, criteria text, deadline, round and negotiation history only (`src/agents/buyer.ts:49-63`); negotiation precedes `TERMS_LOCKED`, so delivery data does not exist at that point (§15.7.9).
* **Existing deal-level approval workflow** (code-read, `src/domain/deals.ts:98-186`): human approval exists only when policy returns `NEEDS_HUMAN` at `POLICY_CHECKED`; the recorded `HUMAN_REVIEW_DECISION` event carries `{phase, decision}` and actor `human:<email>` only — **no terms hash, no nonce** (finding W15).
* **Budget accounting** (code-read, `prisma/schema.prisma`): `BudgetReservation` is per mandate, `unique(dealId)`, `status` enum; no mandate closure or successor link exists.

---

## 15.0 Scope, inspected material, and document-name mismatch

The request named `docs/04-ai-and-verification.md`, `docs/05-data-model-and-app-api.md`, `docs/07-security-and-testing.md`. **Those files do not exist in this repository.** The equivalents actually read are listed below; if the owner meant other documents, tell me.

Files inspected (read-only): `AGENTS.md`; `docs/02-architecture.md`, `04-agents-and-settlement.md`, `05-attack-suite.md`, `07-roadmap.md`, `12-delivery-and-verification.md`, `13-orchestration-and-integration.md`, `14-attack-lab.md` (§14.20–14.25); `src/domain/{terms,mandate,mandates,deals,policy,negotiation,canonical,signing,statemachine}.ts`; `src/agents/{contracts,llm,buyer}.ts`; `src/lib/env.ts`; `src/verification/{pipeline,ai,evidence,scope,language,contracts}.ts`; `src/settlement/{verification-intake,engine}.ts`; `src/orchestration/integrity.ts` (read), `src/orchestration/service.ts` (partially read — see §15.7.9); `src/domain/statemachine.ts` (function listing only); `prisma/schema.prisma`; `src/app/api/**` (route listing); `tests/` layout (listing); `attack-lab/{cases,mutate}.ts` (read earlier in this session). Databases were queried **read-only** (counts and key sets only).

Terminology: *principal* = human authority; *mandate* = signed spending authority; *terms* = per-deal contract (`TermsV1`), hash-locked; *criterion* = one verifiable acceptance condition; *artifact* = the seller's delivered CSV + manifest.

---

## 15.1 Current architecture assessment

### 15.1.1 What is signed, what is hash-locked, what is neither (code-read)

| Object | Integrity mechanism today | Source |
|---|---|---|
| `MandateDocument` (limits only: budget, per-deal max, task types, counterparties, `injectionPolicy`, 2 booleans, expiry) | `mandateDigest = sha256(canonicalJson(doc))`; Ed25519 application seal over `{approvalMethod, approvedAt, approvedBy, digest, keyVersion}` after the human's two-step confirmation | `src/domain/mandate.ts:43-125` |
| `TermsV1` (task type, description, **criteria**, price, deadline, seller, mandateId) | `termsHash = sha256(canonicalJson(normalizeTerms(terms)))`, stored on Deal, in the ledger `TERMS_LOCKED` event and the PayPal order description. **Not signed. Not individually human-approved.** Criteria originate from the principal's `TaskBrief`. | `src/domain/terms.ts:45-86`, `src/domain/deals.ts` |
| Criterion input boundary (which artifact text a model may read) | **Nothing.** | — |
| Language policy (supported languages, scope, opaque columns) | **Nothing signed or locked.** Deployment config only (`LanguagePolicy`, `MANDATE_SUPPORTED_LANGUAGES / _LANGUAGE_SCOPE / _OPAQUE_COLUMNS` env, `src/verification/language.ts:211-229`) | |
| Artifact field set (CSV columns, manifest keys) | Optionally constrained by a deterministic `csv_schema_matches` criterion; otherwise unconstrained | `src/verification/validators.ts` |

### 15.1.2 Where model calls happen (code-read, grep-enumerated)

`callLLM` is invoked from exactly three places: `src/verification/ai.ts:112` (verifier), `ai.ts:121` (skeptic), `src/agents/buyer.ts:70` (negotiation agent), plus `scripts/llm-smoke.ts` (manual smoke, not part of the app). The only HTTP egress to a model vendor is `AnthropicProvider` (`src/agents/llm.ts:97-103`). Only `/api/auth/*` and `/api/health` HTTP routes exist; no mandate/deal/verification API exists yet.

### 15.1.3 Design weaknesses found (each with evidence)

| # | Weakness | Evidence | Severity |
|---|---|---|---|
| W1 | **A deterministic-only deal still sends artifact text to a configured verifier and skeptic.** `hasLlmCriteria` is computed and then discarded (`void hasLlmCriteria;`); the model blocks are guarded only by `if (d.ai && !blockedReason)` / `if (d.skeptic && !blockedReason)`. **My earlier statement (docs/14 §14.20) that such a deal "cannot be steered by any text / no model reads it" was true for the *settlement decision* but false for *model exposure*.** | `src/verification/pipeline.ts:188,196,214,238`. **Measured** by a read-only probe against the Lab world (mock PayPal, scripted models, test DB): deterministic-only terms → verifier 2 calls, skeptic 1 call, artifact text reached a model: **true**; terms with an LLM criterion and unreadable text → 0 model calls. | HIGH |
| W2 | `termsSchema`/`criterionSchema` are **non-strict Zod objects**: unknown keys are stripped before hashing. A future field (e.g. `inputFields`) written by a newer producer and read by this code would be silently dropped; the hash would then not match, but the *semantics* disappear without an explicit error. There is also **no version field** in terms or mandates. | `terms.ts:34-62` | HIGH for any contract extension |
| W3 | Terms are hash-locked but **not signed**; the mandate signature covers limits only. The user's requirement "language policy covered by the mandate signature" cannot be met by editing terms alone. | `mandate.ts:43-55`, `deals.ts` | structural |
| W4 | `openSealedMandate` ends in `JSON.parse(s.canonicalJson) as MandateDocument` — an **unvalidated cast**. A mandate document with extra/unknown fields (a V2 document read by old code) is accepted and the new fields are silently ignored = silently weaker. | `mandate.ts:121` | HIGH for rollout order |
| W5 | Mandate documents have **no `schemaVersion` and have already changed shape three times.** DB read (test DB, 12,224 mandates): 11,191 documents carry both `allowPartialSettlement` and `allowPreDeliveryCancellation`; 969 carry only the first; 64 carry neither. Absence-means-old-semantics is the de-facto practice; it must be made explicit before adding a security-relevant field. | read-only SQL on `Mandate.canonicalJson` | MED |
| W6 | `detectTermsDrift` projects criteria as `[id,text,type,required,weight]` only. Any new criterion field (`inputFields`) would be **invisible to negotiation drift detection**. | `src/domain/negotiation.ts` | HIGH for B |
| W7 | The policy engine's reasons contain **no language/field/input reason**; terms drift is detected only via `termsHash(t) !== lockedTermsHash`. | `src/domain/policy.ts` | structural |
| W8 | `resolveEvidence` validates references against the **whole artifact** (all columns/rows), not against what the model was shown. A model can cite (and quote) a field it never saw only if it guesses it; an opaque field is therefore *citable evidence*. | `src/verification/evidence.ts` | MED |
| W9 | `opaqueColumns` **is** withheld from the shared prompt sample (`ai.ts:87-90`, placeholder `WITHHELD`), but it is deployment-level, unsigned, applies to **all** deals, and covers only CSV cell values: **column names (headers) and every `metadata` string are still sent** (`ai.ts:90,98`; `scope.ts` `modelVisibleFragments`). | code-read | HIGH |
| W10 | `VerificationResult` and intake (`submitVerificationToSettlement`) bind seal hash, `termsHash`, `artifactSha256`, latest sequence — but **not** the language-policy, detector/vocabulary version, field mapping or mandate digest. A result produced under a weaker policy is indistinguishable from one produced under a stronger one. `VERIFIER_VERSION` is still `"gate4-1"` although verification semantics changed in the gap-closure turn. | `verification-intake.ts`, `contracts.ts:8`, `pipeline.ts:244` | HIGH |
| W11 | **No model-input manifest.** `AgentRun` stores `promptHash` and redacted output only; nothing records which fields/rows/characters a call contained, so "every model input is traceable to criterion + approved mapping" cannot be proven after the fact. | `src/agents/llm.ts` | HIGH |
| W12 | The seller-facing wire contract (`taskSpecSchema`) carries criteria; any classification/`inputFields` added carelessly would disclose to the seller which fields a model reads. | `src/agents/contracts.ts` | design point |
| W13 | The language scan is a *pass on the model-visible slice* but **not tied to a per-criterion field set** (all columns of the first 15 rows, scope `criterion|all`). With several LLM criteria all would see the same slice. | `scope.ts`, `pipeline.ts:148-156` | MED |
| W14 | No composition root / startup validation for the language configuration: policy objects are parsed where used (`parseLanguagePolicy`) and a misconfiguration is not a boot-time failure. | `src/lib/env.ts` (no language variables), `language.ts:223` | MED |
| W15 | The existing deal-level human approval is **not bound to the terms**: the `HUMAN_REVIEW_DECISION` event records only `{phase, decision}` and actor `human:<email>` — no `termsHash`, no nonce, no mapping. It exists only when policy happens to return `NEEDS_HUMAN`. (Added in Revision 2.) | `src/domain/deals.ts:167-186` | HIGH for V2 |

### 15.1.4 Existing mechanisms the design reuses (not replaces)

`canonicalJson` (sorted keys, safe integers only, throws on `undefined`/unsupported types — already fail-closed); the human two-step digest confirmation in `previewMandate`/`approveMandate`; `evaluatePolicy`; `decideSettlement` (required deterministic fail → VOID; any unverifiable → NEEDS_HUMAN; AI-only signals only escalate, AGENTS.md #16); the shipped language machinery (`classifyString`, 13-language override vocabulary, `assessLanguageScope`, `UNSCANNED_LANGUAGE`/`SCAN_INCOMPLETE` flags, prescan work budget); the immutable `VerificationRun` row.

---

## 15.2 Design decisions in one page

| ID | Decision | Rationale |
|---|---|---|
| D1 | Introduce **explicit versions**: `MandateDocument.schemaVersion` (absent = 1), `Terms.schemaVersion` (absent = 1, new = 2). All V2 schemas are **`.strict()`**. V1 schemas stay byte-for-byte as they are. | W2, W4, W5 |
| D2 | The **language policy lives in two places with different roles**: (a) the **signed mandate floor** `MandateDocument.languagePolicy` (human-approved, application-sealed); (b) the **deal's `TermsV2.languagePolicy`**, which is hash-locked with the terms and must be **at least as strict as the mandate floor** (checked by `evaluatePolicy` and re-checked at verification). | the user's requirement "signed" + "in canonical terms" without pretending terms are signed (W3) |
| D3 | **Field classification and per-criterion `inputFields` live in `TermsV2`** (per-deal, hash-locked, principal-authored with the brief). The mandate floor only fixes *that* classification is mandatory and *how strict* the policy is; it never lists artifact fields (they vary per deal). | fields are deal-specific |
| D4 | **All model calls go through one chokepoint** (`ModelRunner`) that accepts only a branded `ModelInput` produced by `buildModelInput(authorizedView)`; each call emits a **`ModelInputManifest`** hashed into the result. No other module may import `callLLM`/`LlmProvider`. | W1, W11 |
| D5 | **Model calls are permitted iff the locked terms are V2, contain ≥ 1 `llm_judged` criterion, and the V2 preconditions hold** — enforced in code by three independent layers (§15.9.0), independent of which models are configured. V1 deals never call a model. **Stage P0 (owner-designated).** | W1 |
| D6 | **Deployment configuration is a monotone floor**: effective policy = `stricterOf(signed/terms policy, deployment floor)`, computed by a pure function; weakening is impossible by construction, and weaker deployment values are *recorded*, never silently ignored. | requirement |
| D7 | Results carry a **binding block** (`termsHash`, `languagePolicyHash`, effective-policy hash, `mandateDigest`, detector id/version/vocabulary hash, per-call manifest hashes, new `verifierVersion`). Intake rejects results whose binding does not match the deal's current locked state. | W10 |
| D8 | **Legacy objects are never rewritten.** Legacy deterministic-only deals continue under original semantics (plus D5); legacy deals with `llm_judged` criteria are **blocked from model use** and routed to human review; enabling LLM criteria requires a **new V2 mandate (human-approved) and new V2 terms**. | requirement; safest option (see §15.9) |
| D9 | **Rollout order forbids silent downgrade**: a reader that rejects unknown versions/keys ships *before* any writer of V2 data (§15.14.2). | W4 |
| D10 | **A new V2 canonical signed payload** (purpose-tagged, with explicit language-policy hash and authorisation echo) replaces reliance on "the existing digest covers it"; V1 verification cryptography is unchanged (§15.5). | S1–S7 |
| D11 | **`TermsAttestation`**: application-signed record of a human (or policy) approval of the exact terms + mapping; mandatory for V2 LLM-criteria deals; never described as a user signature (§15.5.4). | Q1, W15 |
| D12 | **Human sees and confirms the exact mapping and policy consequences** before approval (two-step digest confirmation) (§15.5.5). | Q2 |
| D13 | **No automatic budget carry-over**; exceptional carry-over only inside a new signed mandate with atomic closure (§15.19). | Q9 |
| D14 | **Detector releases are reviewed, immutable, hash-pinned artifacts**; permissive changes never reach an approved mandate silently (§15.18). | Q10 |

---

## 15.3 Proposed schema (all examples are ILLUSTRATIVE — not implemented, not approved)

### 15.3.1 `TermsV2`

```jsonc
// ILLUSTRATIVE — not implemented. Strict: unknown keys are a validation error.
{
  "schemaVersion": 2,
  "taskType": "data_cleaning",
  "description": "Clean the customer export and flag duplicates",
  "price": "25.00",
  "currency": "USD",
  "deadline": "2026-12-01T00:00:00.000Z",
  "sellerId": "seller-7",
  "mandateId": "mdt_123",

  "artifactSchema": {                       // REQUIRED when any criterion is llm_judged
    "format": "csv",
    "fields": [                             // the COMPLETE, closed set of model-addressable names
      { "id": "col:description",     "classification": "CRITERION_INPUT", "criteria": ["C3"] },
      { "id": "col:delivery_notes",  "classification": "CRITERION_INPUT", "criteria": ["C3"] },
      { "id": "col:customer_id",     "classification": "OPAQUE" },
      { "id": "col:email",           "classification": "OPAQUE" },
      { "id": "col:legacy_text_ja",  "classification": "OPAQUE" },
      { "id": "csv:header",          "classification": "OPAQUE" },        // column NAMES are a field too
      { "id": "manifest:artifactReference", "classification": "OPAQUE" },
      { "id": "manifest:mediaType",         "classification": "OPAQUE" },
      { "id": "manifest:metadata",          "classification": "OPAQUE" }   // all seller metadata, one field
    ]
  },

  "criteria": [
    { "id": "C1", "type": "deterministic", "validator": "required_columns_present",
      "params": { "columns": ["customer_id", "email"] }, "text": "Required columns present", "required": true, "weight": 40 },
    { "id": "C2", "type": "deterministic", "validator": "unique_column_values",
      "params": { "column": "customer_id" }, "text": "customer_id unique", "required": true, "weight": 30 },
    { "id": "C3", "type": "llm_judged",
      "inputFields": ["col:description", "col:delivery_notes"], "inputMaxRows": 15,
      "text": "Free-text description is coherent and matches the delivery notes", "required": false, "weight": 30 }
  ],

  "languagePolicy": { /* §15.3.3 — full object, hashed with the terms */ }
}
```

Rules enforced by the V2 parser (all failures = the deal cannot be created / terms cannot be locked; see §15.6, §15.7):

* `deterministic` criteria **must not** carry `inputFields`/`inputMaxRows` (strict schema rejects them) — deterministic criteria never read model-visible text.
* `llm_judged` criteria **must** carry a non-empty `inputFields` (no default, no wildcard, no "all").
* `artifactSchema` and `languagePolicy` are **required iff** at least one criterion is `llm_judged`, and **forbidden-or-inert** otherwise (a deterministic-only V2 deal may carry neither; if it carries them they cannot enable a model — D5).
* A model can never add fields: the model's output schema has no field-selection facility and `ModelInput` is built before the call.

### 15.3.2 Classification semantics

| Class | Meaning | Allowed in `inputFields` | Reaches a model | Runtime effect |
|---|---|---|---|---|
| `CRITERION_INPUT` | Explicitly authorised for the *listed* criteria only | only of the criteria in `criteria` | only within a call for one of those criteria | language-scanned (policy), prompt-injection-scanned, size-bounded |
| `OPAQUE` | Never model-readable, for any purpose | never | **never** — not in verifier, skeptic, extraction helper, agent context, secondary call, summary or explanation | still scanned **deterministically** for settlement-relevant manipulation flags (not for language) |
| `UNCLASSIFIED` | **Not a declarable value.** It is the runtime state of an artifact field that has no entry in `artifactSchema` | n/a | never | → `FIELD_UNCLASSIFIED` → fail closed (§15.9) |

Mapping must be a **bijection**: a field listing criterion `C3` under `criteria` ⇔ `C3.inputFields` contains that field. Any asymmetry is `CLASSIFICATION_CONFLICT` and rejects the terms.

### 15.3.3 `LanguagePolicy` (versioned, signed in the mandate as the floor, copied into terms)

```jsonc
// ILLUSTRATIVE — not implemented.
{
  "schema": "mandate.languagePolicy/1",          // domain-separation tag inside the hashed object
  "policyVersion": 1,
  "supportedLanguages": ["en", "fr", "zh"],       // subset of the detector's registered set
  "detector": {
    "id": "mandate-lexical-detector",
    "version": "1.0.0",
    "vocabularyHash": "sha256:<64 hex>"           // hash of the shipped override vocabulary + script tables
  },
  "unsupportedBehavior": "UNVERIFIABLE_HUMAN_REVIEW",   // enum: UNVERIFIABLE_HUMAN_REVIEW | REJECT_DELIVERY  (no "ALLOW")
  "uncertainBehavior":   "UNVERIFIABLE_HUMAN_REVIEW",
  "nameLikeBehavior":    "UNCERTAIN",                   // single permitted value (Q6 decided): a model-visible name-like token is never auto-passed; there is no ALLOW_COUNTED. OPAQUE names are simply never sent.
  "incompleteScanBehavior": "UNVERIFIABLE_HUMAN_REVIEW",
  "shortText": "NO_EXEMPTION",                          // short length alone never makes text safe
  "criterionScope": [                                   // per-criterion language scope
    { "criterionId": "C3", "scope": "INPUT_FIELDS", "rows": "MODEL_SAMPLE" }   // INPUT_FIELDS only; "rows" must ⊇ the rows actually sent
  ],
  "humanReview": { "required": true }                   // any language-triggered UNVERIFIABLE needs a human decision
}
```

`languagePolicyHash = sha256(canonicalJson(policy))`. The strictness order and the `stricterOf` function are in §15.6.2.

### 15.3.4 `MandateDocument` V2 (signed) — see §15.5.2 for the exact document and signed payload

The V2 document adds `schemaVersion: 2`, `mandateId`, `nonce`, `languagePolicy` (the floor), `carryOver` (reserved, `null`), and makes the two behaviour booleans mandatory. All V1 documents are unchanged and remain valid forever. The exact bytes, the new signed payload, and the verification algorithm are specified in §15.5.2–§15.5.3; Revision 1's statement that the existing seal "covers" the policy is superseded by that specification.

`allowedLlmJudgedCriteria` is deliberately **not** added: whether a deal may use LLM criteria is derived (V2 mandate + V2 terms + valid policy + attestation), not a separate switch (Q3 asks whether the owner wants an explicit switch).

### 15.3.5 Sealed representation (ILLUSTRATIVE, placeholders only)

```json
{
  "sealVersion": 2,
  "canonicalJson": "{\"allowPartialSettlement\":false,...,\"languagePolicy\":{...},\"mandateId\":\"...\",\"nonce\":\"...\",\"schemaVersion\":2}",
  "mandateDigest": "<sha256 of the string above>",
  "approvedBy": "<principal email>", "approvedAt": "<ISO>", "approvalMethod": "EXPLICIT_DIGEST_CONFIRMATION",
  "keyVersion": "<kv>",
  "signature": "<base64 Ed25519 over the V2 signed payload of §15.5.2, produced by the application seal key>"
}
```
The signature is over the **payload** of §15.5.2 (which contains the digest, the language-policy hash and an explicit echo of every authorisation field), not over the envelope. It is an application seal over a human-approved document; it is not a user-held-key signature.

### 15.3.6 `VerificationResult` additions (strict, additive)

```jsonc
// ILLUSTRATIVE
"binding": {
  "termsSchemaVersion": 2,
  "termsHash": "…", "mandateDigest": "…",
  "languagePolicyHash": "…",            // the policy inside the locked terms
  "effectivePolicyHash": "…",           // after merging the deployment floor
  "deploymentFloorHash": "…",
  "deploymentWeakerDimensions": [],      // recorded, never silent
  "detector": { "id": "…", "version": "…", "vocabularyHash": "…" },
  "modelCalls": [ { "callId": "…", "role": "verifier|skeptic", "pass": 1, "criterionIds": ["C3"],
                    "manifestHash": "…", "promptHash": "…" } ]
}
```
`verifierVersion` is bumped (`gate6-1`) so a result's lineage is readable. Legacy results have no `binding`; see §15.9.

### 15.3.7 `ModelInputManifest` (one per model call; hash recorded in the result and `AgentRun`)

```jsonc
{ "callId": "…", "role": "verifier", "pass": 1,
  "criterionIds": ["C3"],
  "fields": [ { "id": "col:description", "rows": "1-15", "chars": 1840, "sha256": "…" },
              { "id": "col:delivery_notes", "rows": "1-15", "chars": 920, "sha256": "…" } ],
  "trustedContext": [ "criterion:C3:text", "deterministic:findings(template-only)" ],
  "termsHash": "…", "effectivePolicyHash": "…", "detectorVersion": "…" }
```
Generated **by the same function that renders the prompt**; there is no second path from which a prompt can be built.

---

## 15.4 Canonical serialization changes

1. **Canonical function unchanged** (`canonicalJson`): sorted keys, safe integers, throws on `undefined` — its fail-closed behaviour is exactly what is needed. The new objects contain no floats, no `undefined`, no dates other than ISO strings.
2. **Hash scope.** `termsHash` for V2 = `sha256(canonicalJson(normalizeTermsV2(terms)))`, where the hashed object **includes** `schemaVersion`, `artifactSchema`, every criterion's `inputFields`/`inputMaxRows`, and the full `languagePolicy`. Nothing that influences model exposure or language handling is outside the hash. V1 terms hash exactly as today (no `schemaVersion` key present).
3. **Normalisation rules (to remove canonicalisation ambiguity):**
   * `criteria` sorted by `id` (existing); `artifactSchema.fields` sorted by `id`; each `inputFields`, each field's `criteria`, `supportedLanguages`, `criterionScope` sorted ascending (byte order).
   * Duplicates anywhere in these lists are a **validation error**, not de-duplicated silently (avoids two different inputs hashing equal).
   * Field IDs are NFC-normalised ASCII-restricted identifiers (`col:` / `manifest:` / `csv:` prefix + printable characters); control, bidi, tag and zero-width characters are rejected; comparison is exact (no case folding). This prevents homograph/duplicate-looking field IDs and "same name, different Unicode" collisions.
   * Free text (`description`, criterion `text`) is hashed as given (existing behaviour); it is *trusted context from the principal*, never classified as an artifact field.
4. **Domain separation:** `schemaVersion` and `"schema": "mandate.languagePolicy/1"` inside the hashed objects make a V1 hash and a V2 hash (and a policy hash and a terms hash) non-interchangeable.
5. **Strictness fix (W2):** V2 schemas use `.strict()`. For V1 the schema stays as is **and** a read-only pre-migration check confirms stored V1 terms contain only V1 keys (done now on the test DB: all 11,820 stored `termsJson` have exactly `criteria,currency,deadline,description,mandateId,price,sellerId,taskType`; all 42,302 stored criteria have exactly `id,params,required,text,type,validator,weight` (40,457, deterministic) or `id,required,text,type,weight` (1,845, llm_judged)). So strictness can be added to V1 *parsing of new input* without invalidating any stored record. (Evidence: SQL key-set query on `mandate_test`; the dev DB is empty.)
6. **Parse dispatch:** `parseTerms(raw)` reads `schemaVersion`: absent → V1 schema; `2` → V2 strict; anything else → reject. V1 and V2 are **never** converted into each other.
7. **`detectTermsDrift`** (negotiation) must project the V2 fields (`inputFields`, `inputMaxRows`, `artifactSchema`, `languagePolicy`) — or, better, compare `termsHash` of the normalised V2 objects — so neither agent can alter the input boundary during negotiation (W6).
8. **Mandate:** `buildMandateDocument` gains `schemaVersion` and `languagePolicy` only for V2; `mandateDigest` formula unchanged. Readers keep hashing `s.canonicalJson` *as stored* — never a re-serialisation — so historical digests cannot change.

---

## 15.5 Signing and approval — exact signature-scope specification

*Revision 2: this section replaces the Revision-1 text, whose claim that the V2 policy is "covered by the existing digest and seal" was true for byte integrity but insufficient as an authorisation design.*

### 15.5.1 What the existing seal covers — verified (code-read + experiment)

Code (`src/domain/mandate.ts:75-125`, `src/domain/signing.ts`):
* The signature is Ed25519 over the string `canonicalJson({approvalMethod, approvedAt, approvedBy, digest, keyVersion})`.
* `digest = sha256Hex(canonicalJson(doc))` and the stored `canonicalJson` string is what `openSealedMandate` re-hashes (`sha256Hex(s.canonicalJson) !== s.mandateDigest` → `null`).
* The document `doc` has exactly 11 fields: `principalId, currency, budgetTotal, perDealMax, requireHumanAbove, allowedTaskTypes, counterparties, injectionPolicy, allowPartialSettlement, allowPreDeliveryCancellation, expiresAt`. **Terms, criteria, field mappings and language policy are not in it.** "Limits only" in earlier summaries meant "authorisation limits and two behaviour flags".

**Experiment** (scratchpad script, throwaway in-memory key, no DB; results are measured):

| # | Test | Result |
|---|---|---|
| 1 | Seal a document carrying an extra field (stand-in for `languagePolicy`) with the unchanged `sealMandate`; open it | verifies; extra field returned |
| 2 | Edit the policy text inside the stored string, keep digest + signature | rejected |
| 3 | Edit the policy and recompute the digest (attacker without the key) | rejected |
| 4 | Opener's return value | the parsed JSON **cast** to `MandateDocument`, extra keys included, **no schema validation** |
| 5a | A **non-canonical** string (extra whitespace, odd ordering) signed by the key holder | accepted |
| 5b | A string with **duplicate keys** (`budgetTotal` twice) signed by the key holder | accepted; **last key wins** (value `999999.00` read) |
| 5c | A string `{"anything":true}` signed by the key holder | accepted (no shape check) |
| 6 | Seal payload keys | `approvalMethod, approvedAt, approvedBy, digest, keyVersion` — **no purpose / version / schema tag** |
| 7 | Another public key rejects; changing the signed `keyVersion` field rejects | confirmed |

**Conclusion.** Content placed inside the sealed string *is* integrity-protected by the existing mechanism (tests 1–3), so a field would not be silently unsigned. But that is not enough for a V2 contract, because of these gaps (all measured or code-read):

| Gap | Evidence | Risk if unaddressed |
|---|---|---|
| **S1** No schema validation after verification | test 4, 5c; `JSON.parse(...) as MandateDocument` | an old reader silently ignores the policy; a malformed signed document is accepted |
| **S2** No canonical-form / duplicate-key check | 5a, 5b | ambiguity between "what was hashed" and "what was parsed" (only the key holder can create such a string, but a V2 verifier must not tolerate it) |
| **S3** No purpose / version tag in the payload | 6 | cross-protocol confusion once the same key also signs `TermsAttestation`, and no cryptographic statement of which schema the digest refers to |
| **S4** Policy and authorisation fields are covered only transitively through the digest | design | a verification bug that skips the digest check would drop all protection; explicit echo gives a second, independent check |
| **S5** The mandate's row id and any uniqueness nonce are not in the signed document | `Mandate.id` is a `cuid()` assigned at insert; no unique index on `mandateDigest` | two rows with identical documents are indistinguishable; an attestation cannot bind a signed mandate ID |
| **S6** `keyVersion` is signed but the opener accepts **one** public key and never maps version → key | `openSealedMandate(s, publicKeyB64)` | rotation ambiguity; an unknown `keyVersion` is not rejected |
| **S7** Mirrored columns (`budgetTotal`, `perDealMax`, …) and `revokedAt` are unsigned | `prisma/schema.prisma` | by design `revokedAt` is mutable state; mirrored columns must never be authoritative (existing code reads `verifiedDocument`; a V2 test must assert the policy is never read from a column) |

### 15.5.2 V2 document and V2 signed payload (exact specification — ILLUSTRATIVE until approved)

**Document** (the exact bytes of `canonicalJson` that are hashed; strict schema, unknown keys rejected, every field mandatory unless marked):

```jsonc
{
  "schemaVersion": 2,
  "mandateId": "<cuid pre-allocated by the application before sealing>",
  "nonce": "<128-bit random, lowercase hex>",
  "principalId": "...",
  "currency": "USD",
  "budgetTotal": "100.00",
  "perDealMax": "25.00",
  "requireHumanAbove": null,
  "allowedTaskTypes": ["data_cleaning"],
  "counterparties": ["seller-7"],
  "injectionPolicy": "HUMAN_REVIEW",
  "allowPartialSettlement": false,        // mandatory boolean in V2 (no absent-means-false)
  "allowPreDeliveryCancellation": false,  // mandatory boolean in V2
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "languagePolicy": { /* the FLOOR, §15.3.3, full object */ },
  "carryOver": null                        // reserved; see §15.19
}
```

**Signed payload** (the exact message passed to Ed25519; `canonicalJson` of this object):

```jsonc
{
  "purpose": "mandate-seal",
  "sealVersion": 2,
  "schemaVersion": 2,
  "keyVersion": "<kv>",
  "mandateId": "<same as document>",
  "principalId": "<same as document>",
  "mandateDigest": "<sha256Hex(canonicalJson(document))>",
  "languagePolicyHash": "<sha256Hex(canonicalJson(document.languagePolicy))>",
  "carryOverHash": "<sha256Hex(canonicalJson(document.carryOver))>",
  "authorization": {                      // explicit echo of every authorisation field in the document
    "currency": "USD", "budgetTotal": "100.00", "perDealMax": "25.00", "requireHumanAbove": null,
    "allowedTaskTypes": ["data_cleaning"], "counterparties": ["seller-7"], "injectionPolicy": "HUMAN_REVIEW",
    "allowPartialSettlement": false, "allowPreDeliveryCancellation": false, "expiresAt": "2027-01-01T00:00:00.000Z"
  },
  "approvedBy": "<principal email>",
  "approvedAt": "<ISO>",
  "approvalMethod": "EXPLICIT_DIGEST_CONFIRMATION"
}
```

**Envelope stored in `Mandate`:** `{sealVersion: 2, canonicalJson, mandateDigest, approvedBy, approvedAt, approvalMethod, keyVersion, signature}` (envelope fields are never trusted on their own; every one is re-derived or compared against the signed payload).

The explicit echo (`languagePolicyHash`, `authorization`) is **deliberately redundant** with the digest: verification checks the digest *and* each echoed value against the parsed document, so neither a digest-handling bug nor a parser discrepancy can silently weaken a field.

### 15.5.3 V2 verification algorithm (fail closed at every step; closed-enum error codes)

1. **Dispatch.** Read `sealVersion` from the envelope and peek `schemaVersion` from the stored string. Absent/absent → V1 path. `2`/`2` → V2 path. Any other value or any mismatch between the two → `UNSUPPORTED_SCHEMA_VERSION` (reject; **no downgrade parsing, no field dropping**).
2. `sha256Hex(storedString) === mandateDigest`, else `DIGEST_MISMATCH`.
3. **Canonical form.** Parse with a duplicate-key-rejecting parser; require `canonicalJson(parsed) === storedString`, else `NON_CANONICAL_DOCUMENT` / `DUPLICATE_KEY`.
4. **Strict schema.** Validate with the strict V2 schema (unknown or missing keys → `DOCUMENT_INVALID`). Validate `languagePolicy` against its own strict schema (§15.3.3) and `carryOver` (§15.19).
5. **Key.** Resolve `keyVersion` through a key registry (`{keyVersion → publicKey}`); unknown → `KEY_VERSION_UNKNOWN`.
6. **Payload rebuild.** Rebuild the payload **from the parsed document and envelope** (never from caller-supplied echo values) and verify the Ed25519 signature, else `SIGNATURE_INVALID`.
7. **Echo checks** are satisfied by construction in step 6; additionally assert `mandateId` equals the row id and `nonce` is unique (unique index), else `MANDATE_IDENTITY_MISMATCH`.
8. Return the **parsed strict object**, never a cast.

**V1 path unchanged in cryptography:** payload = the 5-key object, same digest rule, same Ed25519 verification. One new **post-verification** guard (decision Q13): after the V1 signature verifies, parse the document with a strict V1 shape (accepting the three historical shapes found in the data: with/without `allowPartialSettlement`, with/without `allowPreDeliveryCancellation`) and reject unknown keys, so a V2-style document can never be accepted under V1 rules. A V1 envelope presented for a document that contains `schemaVersion`, `languagePolicy` or `carryOver` is `DOWNGRADE_REJECTED`.

**Why cross-protocol confusion is impossible:** V1 payloads have no `purpose`; V2 payloads have `purpose: "mandate-seal"`; attestations have `purpose: "terms-attestation"`. A verifier reconstructs the exact byte string for the protocol selected in step 1; the three byte strings differ in structure, so a signature produced for one cannot verify under another.

**Tests (S-series, to be written at implementation):** S1 the §15.5.1 experiment re-run as regression tests against the new verifier; S2 each of steps 1–8 failing independently (mutate one thing at a time); S3 V1 fixtures (all three shapes) verify exactly as before and still hash to stored digests; S4 downgrade: V2 document under a V1 envelope → rejected; V1 document under a V2 envelope → rejected; S5 duplicate-key and non-canonical strings (signed by a test key) → rejected under V2; S6 mutate each echoed field in the payload → signature invalid; S7 unknown `keyVersion` → rejected; S8 unknown `schemaVersion` (3, "2", 2.0, null) → rejected; S9 policy read only from the verified document (grep/static + behavioural test that corrupting mirrored columns changes nothing); S10 `mandateId`/`nonce` uniqueness.

### 15.5.4 `TermsAttestation` (decision Q1) — exact specification

**What it proves — wording that must be used in code comments, UI and docs:** *"The application recorded that <actor> approved these exact terms under this mandate at <time>, and attests to that record with its Ed25519 application key."* It is **not** the user's own cryptographic signature (the user holds no key) and must never be described as one. This preserves the project's existing label for mandates: "human-approved, application-signed".

**Signed payload** (canonicalJson; ILLUSTRATIVE):

```jsonc
{
  "purpose": "terms-attestation",
  "attestationVersion": 1,
  "keyVersion": "<kv>",
  "dealId": "...",
  "mandateId": "...",
  "mandateDigest": "...",
  "termsHash": "...",
  "termsSchemaVersion": 2,
  "languagePolicyHash": "...",
  "mappingHash": "<sha256Hex(canonicalJson({artifactSchema, criteria: [{id,type,inputFields,inputMaxRows}]}))>",
  "approvalKind": "HUMAN_PREAUTH",          // or "POLICY_WITHIN_MANDATE" (never presented as human approval)
  "actor": { "kind": "human", "id": "<user id>", "label": "<email>" },   // or {kind:"policy-engine", id:"policy-engine"}
  "approvedAt": "<ISO>",
  "approvalNonce": "<128-bit random hex, issued by the server at preview>"
}
```

(`mappingHash` is redundant with `termsHash`, which already covers the mapping; it is included so the attestation states the criterion-to-field mapping explicitly, as required, and so a UI can show "this approval covered mapping X".)

**Rules**
* One attestation per deal (`unique(dealId)`), immutable (trigger), nonce single-use (unique).
* **Required** for every V2 deal with ≥ 1 `llm_judged` criterion, and `approvalKind` must be `HUMAN_PREAUTH` for those.
* **Issued for all other settleable V2 deals** (deterministic-only V2 terms) with `approvalKind: "POLICY_WITHIN_MANDATE"` when policy returns OK, or `HUMAN_PREAUTH` when a human approved. Workflow support, verified by code-read: `reserveForDeal` (`src/domain/deals.ts:137-161`) is a single transaction that re-evaluates policy under the mandate lock and is the natural hook; the V1 path never takes the V2 branch, so legacy behaviour is untouched. (Decision Q16 asks the owner to confirm this extension.)
* **Engine gate.** The Settlement Engine refuses to create a PayPal order for a V2 deal unless the attestation exists, its signature verifies (key registry), and every bound value equals the deal's current locked state and the freshly verified mandate (`dealId`, `mandateId`, `mandateDigest`, `termsHash`, `termsSchemaVersion`, `languagePolicyHash`, `mappingHash`). The integrity check (`checkIntegrity`) gains the same verification. V1 deals are exempt (legacy).
* **Drift.** Terms are immutable after `TERMS_LOCKED`; any change means different terms, hence a new `termsHash`, hence the old attestation no longer matches. Negotiation drift detection (`detectTermsDrift`) is extended to every V2 field. A changed mapping therefore requires a new deal/lock and a new approval.
* **Actor attribution preserved.** The ledger event `HUMAN_REVIEW_DECISION` for V2 is extended to carry `{termsHash, attestationId, approvalNonce}` in addition to the existing `{phase, decision}` and `human:<email>` actor (finding W15: today it binds no terms hash and no nonce).

### 15.5.5 Human approval preview (decision Q2)

The pre-authorisation review for a V2 LLM-criteria deal becomes a **mandatory two-step confirmation**, reusing the mandate pattern (`EXPLICIT_DIGEST_CONFIRMATION`):

1. **Preview** (read-only; issues the server-side nonce and an `attestationDigest = sha256(canonicalJson(attestation payload minus approvedAt/signature))`). It must display, in plain language and without truncation:
   * the deal: seller, price, deadline, the mandate and its digest;
   * for **each criterion**: id, text, **type** (deterministic / LLM-judged), and — for LLM-judged — its **permitted input fields** (with row limit);
   * the **fields excluded from model access** (every `OPAQUE` field, including the header row and manifest fields), and the statement that they are never sent to any AI model;
   * the **language policy**: supported languages, detector id/version/vocabulary hash, and **what happens in the unsupported / uncertain case** — *"if a model-readable field contains text in an unsupported language, or the language cannot be confidently determined, the affected criterion is marked UNVERIFIABLE, no AI model is called for it, and the deal is held for human review"*; name-like tokens in model-visible fields are treated as uncertain (decision Q6);
   * the `termsHash` and `languagePolicyHash`.
2. **Approve:** the human echoes the `attestationDigest`. On match, one transaction: write the `TermsAttestation`, append `HUMAN_REVIEW_DECISION` (with hash + nonce), reserve budget. A mismatch changes nothing.

For these deals the policy engine returns `NEEDS_HUMAN` with reason `LLM_MAPPING_APPROVAL_REQUIRED` **regardless of amount**; the existing `humanApproved` waiver in `evaluateFor` (`deals.ts:113`) must not convert this specific reason to OK without an attestation (test: approving through the legacy path without an attestation is refused).

---

## 15.6 Deployment configuration design

### 15.6.1 Where it is read

A **single composition root** (`loadLanguageDeployment(env)`), executed at process start and in every test world, parses a strict config, **fails startup** on any error (W14), and exposes an immutable object. Pipeline code receives it by injection; it may not read `process.env` itself. Proposed variables (names illustrative): `MANDATE_LANGUAGE_FLOOR_FILE` (path to a JSON floor; its sha256 is logged and recorded in results), `MANDATE_DETECTOR_REGISTRY` (allow-list of detector id/version/vocabularyHash the build actually contains). The legacy variables `MANDATE_SUPPORTED_LANGUAGES`, `MANDATE_LANGUAGE_SCOPE`, `MANDATE_OPAQUE_COLUMNS` are **deprecated**: accepted for V1 deals only; for V2 deals they may only *tighten* via the floor file.

### 15.6.2 Strictness order and the merge

`A ⊒ B` ("A at least as strict as B") iff **all** of:

* `supportedLanguages(A) ⊆ supportedLanguages(B)`
* each behaviour in A ≥ B on the order `REJECT_DELIVERY > UNVERIFIABLE_HUMAN_REVIEW` (there is **no "allow" value**), and `nameLikeBehavior` is the single value `UNCERTAIN` (no weaker value exists)
* `humanReview.required(A) ≥ humanReview.required(B)`; `shortText` equal (`NO_EXEMPTION` only)
* for every criterion in B's scope, A's scope covers at least the same fields and rows
* `detector(A)` is the same id and version **and** the same `vocabularyHash` as B, or is listed in the build's registry as a successor that `supersedes` B's (detectors are never compared by name alone).

`stricterOf(P, F)` (`P` = signed/terms policy, `F` = deployment floor) is a pure function: intersection of languages, max of behaviours, OR of human-review, union of scopes, and `opaqueOverlay` = deployment-declared extra opaque fields. Properties to be proven by tests: `stricterOf(P,F) ⊒ P`; `stricterOf(P,F) ⊒ F`; idempotent; commutative on the lattice order; **no output weaker than `P` in any dimension for any `F`**.

### 15.6.3 Interaction rules (the precise contract)

| Situation | Outcome |
|---|---|
| Deployment floor stricter than signed policy | Allowed; effective = stricter; both hashes recorded. |
| Deployment floor weaker than signed policy in some dimension | The signed value wins for that dimension; the dimension is listed in `binding.deploymentWeakerDimensions` (**recorded, not silent**). No error: a deployment floor is a minimum, not an assertion about every mandate. |
| Deployment claims a language/detector the signed policy does not list | Ignored for widening (cannot widen); startup warning. |
| Detector required by the signed/terms policy is not in the build registry or its `vocabularyHash` differs | `LANGUAGE_DETECTOR_MISMATCH` → all LLM criteria of that deal `UNVERIFIABLE`, no model call. |
| Terms policy weaker than the mandate floor | `evaluatePolicy` reason `LANGUAGE_POLICY_WEAKER_THAN_MANDATE`; terms cannot be locked; re-checked at verification (defence in depth). |
| Mandate is V1 and terms contain an `llm_judged` criterion | `evaluatePolicy` reason `LANGUAGE_POLICY_REQUIRED` (V1 mandates cannot authorise LLM criteria). |
| Deployment `opaqueOverlay` marks a `CRITERION_INPUT` field opaque | Field becomes opaque (stricter); a criterion left without input becomes `UNVERIFIABLE` (`INPUT_FIELD_WITHHELD`). Overlay can never un-opaque a field. |

Precedence, highest first: **signed mandate floor > terms policy (⊒ floor, hash-locked) > deployment floor (tightens only) > runtime detector output (may only move an outcome toward UNVERIFIABLE/escalation, never toward PASS).**

---

## 15.7 Field-classification rules

1. **Completeness.** For any deal with ≥ 1 `llm_judged` criterion, every artifact field that can exist must be covered by `artifactSchema.fields`: each CSV column (`col:<exact header>`), the header row itself (`csv:header`), and the manifest namespace (`manifest:artifactReference`, `manifest:mediaType`, `manifest:metadata`, any other manifest key). Column *names* are model-visible today (W9) and are therefore an explicit field.
2. **No implicit model-readable field.** There is no default class. A field that is not declared does not default to anything: it is `UNCLASSIFIED` and fails closed.
3. **Validation failures (terms are rejected at lock time):** `FIELD_MISSING_CLASSIFICATION`, `FIELD_DUPLICATE`, `FIELD_EXTRA` (declared but impossible, e.g. a column absent from a mandatory `csv_schema_matches` header), `FIELD_ID_INVALID`, `CLASSIFICATION_CONFLICT` (bijection broken, or `OPAQUE` with a `criteria` list, or `CRITERION_INPUT` with an empty list), `CRITERION_UNKNOWN`, `FIELD_UNKNOWN_IN_CRITERION` (criterion lists a field not in `artifactSchema`).
4. **Closed world at delivery time.** On ingestion of a delivery for a V2 deal with LLM criteria, the observed header and manifest keys are compared with the declared fields: an observed name not declared → `FIELD_UNCLASSIFIED` (see decision flow); a declared `CRITERION_INPUT` field missing from the artifact → the dependent criterion is `UNVERIFIABLE` (`INPUT_FIELD_ABSENT`). Comparison is exact on NFC bytes.
5. **Opaque means opaque everywhere.** Not in the verifier or skeptic prompt, not in an AI extraction helper, not in agent (buyer/seller) context, not in any secondary model call, not in an AI-generated summary/explanation; **not citable as model evidence** (`resolveEvidence` gets the allowed field set and refuses refs to other fields — W8); not usable as a deterministic-finding *value* that is fed to a model.
6. **No model-output chaining.** A model's free-text output (rationale, observations, summary, flags) is never placed into another model's input: it may quote a `CRITERION_INPUT` field of one criterion group that another group is not authorised to read.
7. **Closed-form deterministic findings.** The "trusted context" given to a model (deterministic findings) is generated from templates containing only criterion IDs, statuses, counts, positions and contract constants — never artifact text (asserted by a boundary test).
8. **Human-facing explanations** are templates over the same closed-form data; if an AI-written explanation is ever added it is a model call subject to this whole design.
9. **Other model consumers** (buyer/seller agents, future explainers) receive only a `VerificationResultPublicView` (criterion IDs, closed-enum statuses/reasons, counts) — no fragments, no model free text. *Verification status (code-read, Revision 2): `src/agents/buyer.ts` is the only non-verification `callLLM` site. `buildBuyerUserPrompt` (`buyer.ts:49-63`) composes the prompt from the task description, the criteria **text strings**, the deadline, the round counter and the negotiation history (seller messages wrapped as untrusted). Negotiation precedes `TERMS_LOCKED`, so no delivery, artifact or verification result exists when the buyer prompt is built. The buyer prompt must stay free of `inputFields`, classification and policy (the buyer sees criteria text only). Test M6 pins this; a future change that feeds delivery data to the buyer would fail it.*

---

## 15.8 Criterion-to-field mapping

* Each `llm_judged` criterion gets an **`AuthorizedView`** = exactly its `inputFields` × its `inputMaxRows` (default and maximum bounded by the policy; currently 15 = `MODEL_SAMPLE_ROWS`).
* **Grouping:** criteria with an **identical** `(inputFields, inputMaxRows)` share one verifier call (two passes, as today) and one skeptic call; criteria with different views get **separate calls**. Cost is bounded: ≤ `G` groups × (2 verifier + 1 skeptic), with `G ≤ #llm_judged criteria ≤ 20` and a recommended cap (Q5). A skeptic call is never given a union wider than its group's view.
* `buildModelInput(view)` is the **only** way to obtain a `ModelInput` (branded type). `callLLM`'s signature accepts `ModelInput` only; raw strings no longer type-check. A static test asserts that nothing outside `src/verification/model-runner.ts` imports `callLLM`, `LlmProvider` or the Anthropic provider except the negotiation agent (separately constrained).
* **Deterministic criteria stay deterministic**: they run on the parsed artifact in-process; they have no `inputFields`; `ModelRunner` cannot be reached from the validator module (import-graph test, extending `verification-isolation.test.ts`).
* **Traceability:** every `ModelInputManifest` lists `criterionIds` and field IDs; a post-hoc checker verifies `manifest.fields ⊆ ⋃ inputFields(criterionIds)` and that each field's classification is `CRITERION_INPUT` listing those criteria. A call with a manifest that fails the check marks the run `MODEL_INPUT_VIOLATION` (hard error, result not submitted to settlement).
* Unknown criterion or field IDs anywhere → rejection at lock time; at runtime they can only appear through corruption → `INTEGRITY_FAILURE`.

---

## 15.9 Runtime decision flow

### 15.9.0 P0 model-isolation guarantee (W1) — applies to V1 and V2, before any V2 work

**Guarantees (all must hold and all are tested at the actual model-call boundary):**

| # | Guarantee |
|---|---|
| P0-1 | **Zero model invocations for deterministic-only deals** (V1 and V2), even when a verifier/skeptic is configured. |
| P0-2 | **V1 deals never invoke a model**, including V1 deals that contain `llm_judged` criteria (those criteria are `UNVERIFIABLE` until a V2 deal exists). |
| P0-3 | **No indirect leakage**: artifact content, manifest metadata, header names, deterministic findings, verification results, model free text and error text do not reach any model through any other path — agent context, logs, ledger payloads, `AgentRun` rows, secondary/chained calls, summaries or explanations. |
| P0-4 | **Canary tests at every model-call boundary** (below). |
| P0-5 | **No successful verification if the isolation check fails.** |

**Mechanism (defence in depth — three independent layers, any one of which suffices to stop an unauthorised call):**
1. **Decision layer.** `modelCallsPermitted := schemaVersion === 2 && criteria.some(llm_judged) && attestation/policy preconditions hold`. If false the pipeline never constructs a verifier/skeptic call (today `hasLlmCriteria` is computed and discarded, `pipeline.ts:238`; P0 makes it load-bearing).
2. **Provider layer.** The composition root hands the pipeline a `GuardedProvider` instead of the raw provider. Each verification creates a `ModelGate` with a **call budget** (0 for any deal where models are not permitted). The guard throws `ISOLATION_VIOLATION` on a call that exceeds the budget or does not present a `ModelInput` token bound to an authorised manifest — so a future code path that forgets layer 1 still cannot reach the vendor.
3. **Assertion layer.** Before the `VerificationRun` is persisted or submitted to settlement, `assertModelIsolation(terms, manifests, providerCallLog)` checks: call count equals the number of authorised manifests; each recorded prompt hash equals its manifest hash; for a deterministic-only deal the log is empty. A failure → the run is **not** submitted as a verification; the deal is routed to `NEEDS_HUMAN` with closed code `MODEL_ISOLATION_VIOLATION`, ledgered (code only, never content); it is never a capture path. The result records `isolation: {modelCallsPermitted, modelCallsMade}`.

**Canary boundaries (each test seeds a unique canary string in every artifact field, header name, manifest key/value and, separately, in negotiation text, and asserts it never appears in the bytes handed to):**
* verifier pass 1, verifier pass 2, skeptic — through `ScriptedLlm.requests` **and** through the `GuardedProvider` call log;
* the buyer-agent prompt (`buildBuyerUserPrompt`) built from a deal that has a delivery;
* any AI extraction/summary helper (none exists today: a static test pins the **set** of `callLLM` call sites to {verifier, skeptic, buyer, smoke script} so a new site fails the build);
* every persisted store: `AgentRun`, `DealEvent`/ledger payloads, `VerificationRun.resultJson`, logger output and thrown error messages;
* the human-facing explanation templates;
* the second model call of any chain (model output is never an input to another call).
Each test has a mutation partner (remove the gate, remove the assertion, route around the guard → the test must fail).

**Impact to disclose:** (a) the existing Attack-Lab scripted-AI cases and unit/DB tests that run AI against V1 terms with `llm_judged` criteria will no longer call a model after P0; they move to V2 fixtures once V2 exists (until then they expect `UNVERIFIABLE`); the Lab's AI-dependent numbers must be re-measured, not reused. (b) Verification results produced before P0 for deterministic-only deals with a configured model are immutable and may have involved model calls; they are not re-run (§15.10.3).

### 15.9.1 Flow (per delivery, in `verifyDelivery`)

1. Load locked terms; verify `termsHash` against the locked hash (existing); dispatch on `schemaVersion`.
2. **V1 terms** → legacy path (§15.10): deterministic validators always; **never a model call** (Q4/P0-2), with or without `llm_judged` criteria; LLM criteria → `UNVERIFIABLE` `LEGACY_TERMS_NO_INPUT_BOUNDARY`.
3. **V2 terms**: open the sealed mandate; require V2 mandate when any `llm_judged` criterion exists; require `terms.languagePolicy ⊒ mandate.languagePolicy` (re-check); resolve detector against the build registry; compute `effectivePolicy = stricterOf(...)`; any failure → LLM criteria `UNVERIFIABLE` with a closed-enum reason, **no model call**.
4. `modelCallsPermitted := terms.criteria.some(llm_judged)`. If false: skip to step 8 — verifier/skeptic are **not constructed for this deal** (even if configured) and no artifact text leaves the process.
5. Compare observed header/manifest keys with `artifactSchema` (closed world). Undeclared → `FIELD_UNCLASSIFIED`: every LLM criterion `UNVERIFIABLE`, no model call (deterministic criteria still evaluate; the settlement rule "any unverifiable → NEEDS_HUMAN" applies).
6. Deterministic prescan over **all** fields (hidden/tag/bidi characters, payloads, verifier-targeted instructions) as today — it informs settlement flags (severe → NEEDS_HUMAN) but has no model dependency.
7. For each model group: build the `AuthorizedView`; run the **language assessment on exactly the text `buildModelInput` will contain** (same function, same rows — the scan can never describe different text from the prompt); apply the effective policy to each fragment's classification; any `UNSUPPORTED`/`UNCERTAIN`/`NAME_LIKE(UNCERTAIN)`/incomplete scan/detector error → the group's criteria `UNVERIFIABLE` (`LANGUAGE_UNSUPPORTED|LANGUAGE_UNCERTAIN|SCAN_INCOMPLETE|DETECTOR_ERROR`) and **no call for that group**. Otherwise call the verifier (two passes) and skeptic with manifests; evidence refs restricted to the group's fields.
8. Assemble the `VerificationResult` with `binding`; persist the immutable `VerificationRun`.
9. **Intake** (`submitVerificationToSettlement`) re-derives the binding from the *current* locked deal and rejects the result as **stale** unless (V2) the deal's `TermsAttestation` verifies and the result's `isolation` block shows the permitted/made call counts agree, and `binding.termsHash`, `languagePolicyHash`, `mandateDigest` match the deal, `verifierVersion` is in the accepted set, and the detector/vocabulary hashes are in the registry. A result without `binding` is accepted only for V1 deals and only if `verifierVersion ∈ {"gate4-1"}` (frozen set; §15.10).
10. Settlement is unchanged: any `UNVERIFIABLE` → NEEDS_HUMAN; required deterministic fail → VOID; model signals only escalate.

### 15.9.2 Language-handling table

| Case | Normal-flow outcome | Model call? | Settlement eligibility |
|---|---|---|---|
| Supported language (per effective policy), field is `CRITERION_INPUT` | Normal verification | yes, only that group | eligible per existing rules |
| Unsupported language in a `CRITERION_INPUT` field | group's criteria `UNVERIFIABLE`, flag `UNSCANNED_LANGUAGE` HIGH | **no** | NEEDS_HUMAN (human review required by policy) |
| Uncertain language / detector error / missing detector output / invalid output | treated as **uncertain** → per `uncertainBehavior` (fail closed) | **no** | NEEDS_HUMAN |
| Short text (`< N` chars) | **no exemption**; classified like any other text; strictly structural content (digits/punctuation/ISO dates/UUIDs by exact grammar) is `NOT_LANGUAGE`, anything else short is `UNCERTAIN` unless it matches a supported-language vocabulary | per outcome | per outcome |
| Name-like / address-like / identifier-like token in a **model-visible** field (decision Q6) | classified **UNCERTAIN** (never auto-pass, never `ALLOW_COUNTED`): the affected criterion group is `UNVERIFIABLE` (`LANGUAGE_UNCERTAIN`), human review. This is a **verification status, not an injection flag** — it does not raise a manipulation flag and does not treat the string as malicious. Authors should declare such columns `OPAQUE` (never sent) and verify them with **deterministic** criteria (exact match, set membership, format validators) wherever feasible | **no** | NEEDS_HUMAN |
| `OPAQUE` field containing any language | never scanned for language, **never sent to a model** | no | unaffected; deterministic flags still apply |
| `UNCLASSIFIED` field present in artifact | `FIELD_UNCLASSIFIED`; LLM criteria `UNVERIFIABLE` | **no** | NEEDS_HUMAN |
| Unclassified field in *configuration* (terms) | **terms rejected at lock time** | n/a | deal not created |
| Deterministic-only terms | no language escalation; optional LOW informational flag (never a model input) | **no model call exists on this path** | settlement from deterministic validators + existing policy only |
| LLM criterion added to a deterministic-only deal | impossible in place (terms immutable) — a **new** V2 deal is required, and V2 validation makes `artifactSchema` + `languagePolicy` + V2 mandate mandatory | — | — |
| Invalid / missing / weaker-than-floor policy | config/terms rejected | — | — |
| Scan budget/deadline exceeded | `SCAN_INCOMPLETE` → fail closed | no | NEEDS_HUMAN |

"Supported" means *the shipped lexical detector classified it so*; this design makes **no claim of universal language detection** (§15.13 T5/T11 residuals).

---

## 15.10 Legacy migration and compatibility plan (Revision 2)

Principles: **never rewrite a historical mandate, terms object, signature, ledger event or verification result; never re-sign on a user's behalf; never reinterpret V1 as V2; new authority only through new human approval.**

### 15.10.1 What exists (DB-read, `mandate_test` only; the dev DB has 0 mandates/deals)

12,224 mandates, 12,474 deals (11,820 with locked terms, 4,169 terminal), 1,845 deals with an `llm_judged` criterion, **0** mandate documents with a `schemaVersion`; three historical mandate shapes (11,191 / 969 / 64). These are test/Lab fixtures; no production data exists, but the plan must be correct for real data.

### 15.10.2 Compatibility matrix (mandate version × terms version × deal kind)

| Mandate | Terms | Deal kind | Behaviour |
|---|---|---|---|
| V1 | V1 | deterministic-only | Runs exactly as before **except**: **zero model calls** (Q4, P0). No attestation (legacy). Deterministic validators + existing policy decide. |
| V1 | V1 | has `llm_judged` | **AI blocked** (Q4): LLM criteria `UNVERIFIABLE` `LEGACY_TERMS_NO_INPUT_BOUNDARY`, zero model calls, human review. AI use requires a **newly approved V2 mandate and a new V2 deal**. |
| V1 | V2 | deterministic-only | Allowed (no floor to compare; attestation `POLICY_WITHIN_MANDATE` binds the V1 mandate digest). |
| V1 | V2 | has `llm_judged` | Refused at policy: `LANGUAGE_POLICY_REQUIRED` (a V1 mandate cannot authorise LLM criteria). |
| V2 | V1 | deterministic-only | Allowed; legacy terms, no attestation. |
| V2 | V1 | has `llm_judged` | Refused: V1 terms have no input boundary (`LEGACY_TERMS_NO_INPUT_BOUNDARY`). |
| V2 | V2 | any | Full V2 rules: strict schemas, floor check, human-approved attestation for LLM criteria, ModelRunner, binding checks. |
| any | unknown version | any | **Fail closed**: `UNSUPPORTED_SCHEMA_VERSION`; no downgrade parse, no field dropping. |

### 15.10.3 Objects

| Legacy object | Decision | Why |
|---|---|---|
| V1 mandate documents, signatures, digests, `canonicalJson` strings | **Untouched.** Verified with the unchanged V1 cryptography (§15.5.3); the only addition is the post-verification strict-shape guard (Q13). Hashes are always computed over the stored string, never a re-serialisation. | no rewrite, no re-signing |
| Terminal deals | Read-only; historical results immutable; no re-verification. | evidence integrity |
| Non-terminal V1 deterministic-only deals | Continue under original immutable terms; **model calls stop** (P0). This can only remove AI-only escalations; deterministic validators and severe deterministic flags still escalate. Owner-approved (Q4). | removes an unauthorised exposure |
| Non-terminal V1 deals with `llm_judged`, **before** verification | AI blocked → NEEDS_HUMAN with closed reason; principal may let it expire/cancel under existing rules, or open a new V2 deal under a new V2 mandate. Never auto-upgraded. | the original approval had no input boundary or language policy |
| Non-terminal V1 deals **already verified** | Existing immutable result stays valid; settlement proceeds under existing rules. Intake accepts a `binding`-less result **only** for V1 terms and `verifierVersion ∈ {"gate4-1"}` (frozen set). | no retroactive invalidation |
| Historical `VerificationRun`, `Delivery`, ledger events | Unchanged (immutable triggers). New columns nullable. | |
| Deals approved by both parties (terms locked, reserved, order created) | Unchanged. In-flight V1 deals complete under V1 rules; V2 attestation requirements never apply to them. | the approval they received is what they keep |
| Deployments without classification config | V1 deals unaffected; V2 LLM-criteria deals cannot be created until floor + registry are configured and valid (fail closed). | |
| Existing `opaqueColumns` env / `LanguagePolicy` | Honoured for nothing once P0 lands for V1 (no model calls); for V2 only as an overlay that can **tighten**; never the source of classification. Deprecated variables removed per Q8. | |
| Historical verification results from the pre-P0 era that *did* involve model calls on deterministic-only deals | Remain as recorded (immutable). They are not re-run. A **note** in the audit log of this design records that those results may have exposed artifact text to a configured model. | honesty about the past |

### 15.10.4 Budget continuity (Q9)

A V2 mandate has its own `budgetTotal`. **There is no automatic carry-over.** Unused budget on a V1 mandate stays on that mandate; the old mandate remains usable for deterministic-only deals until exhausted, expired or revoked. An exceptional, human-approved carry-over is specified in §15.19 and may be implemented later; the `carryOver` field is reserved (`null`) in the V2 document from day one so enabling it does not require another document version.

### 15.10.5 Detector governance and policy pinning (Q10)

Every signed/terms policy pins `detector.version` **and** `vocabularyHash`. A new detector release (§15.18) therefore **never applies to an existing approved mandate or locked terms by default**. A release that is *more permissive* (it classifies any previously held-out UNSUPPORTED/UNCERTAIN fixture as SUPPORTED, or adds supported languages) is selectable only by **new** mandates. A *stricter* release may be adopted by a deployment through the floor (comparator rule: `supersedes` + `notMorePermissive: true` recorded in the release record). A release found defective is placed on a deployment **revocation list**: deals pinned to it fail closed with `LANGUAGE_DETECTOR_REVOKED` (LLM criteria `UNVERIFIABLE`), never silently upgraded.

### 15.10.6 Pre-implementation read-only checks (to run before any migration)

Every stored `termsJson` parses under the strict V1 schema; every stored `canonicalJson` hashes to its `mandateDigest`; no stored V1 object contains `schemaVersion`; the three mandate shapes all pass the strict V1 document guard; count of non-terminal deals per row of the matrix above; **the four Sandbox orders and `.spike/state.json` are not touched** (standing constraint).

### 15.10.7 Migration test requirements

G1 every stored V1 terms/mandate in a fixture corpus (all three shapes) verifies and hashes identically after the change; G2 V1 deterministic-only deal completes with **zero** model calls (model-boundary canary); G3 V1 LLM-criteria deal → AI blocked, human review, zero calls; G4 V1 post-verification deal settles from its `binding`-less result, and a `binding`-less result is refused for V2 terms; G5 old-reader guard rejects unknown `schemaVersion`/unknown keys; G6 simulated rollback (V2 data + P1 reader) fails closed; G7 downgrade matrix rows of §15.10.2 each asserted; G8 historical rows unchanged byte-for-byte (checksum of `Mandate`, `Deal.termsJson`, `VerificationRun.resultJson` before/after the migration on a copy).

---

## 15.11 Database changes proposed (NOT applied; no migration written)

All **additive, nullable or defaulted**; no table rewrite; no change to existing rows; no touch to ledger hash-chain inputs for old events.

| Table | Change | Purpose |
|---|---|---|
| `Mandate` | `schemaVersion Int @default(1)`; `languagePolicyHash String?` | mirrored columns for queries only — **the signed `canonicalJson` stays authoritative** (existing rule) |
| `Deal` | `termsSchemaVersion Int @default(1)`; `languagePolicyHash String?` | query/triage; authoritative values come from locked `termsJson` + ledger |
| `VerificationRun` | `termsSchemaVersion Int?`; `bindingHash String?` (index) | find stale/legacy runs; `resultJson` carries the full `binding` and is immutable (trigger unchanged) |
| `AgentRun` | `inputManifestHash String?` | tie each model call row to its manifest |
| `LedgerEvent` payloads | new optional keys on `TERMS_LOCKED` (`termsSchemaVersion`, `languagePolicyHash`) and `DEAL_CREATED` (`mandateSchemaVersion`) | audit trail; old events unchanged |
| `TermsAttestation` (new, Q1 approved) | `id, dealId @unique, mandateId, mandateDigest, termsHash, termsSchemaVersion, languagePolicyHash, mappingHash, approvalKind, actorKind, actorId, approvedAt, approvalNonce @unique, keyVersion, payloadJson (the exact signed payload string), signature, createdAt`; immutable trigger (no UPDATE/DELETE) | the signed bytes are authoritative; columns are for queries |
| `Mandate` (V2 additions, Q14) | `sealVersion Int @default(1)`; `@@unique([mandateDigest])`; `mandateNonce String? @unique`; later (P6, Q9) `closedAt`, `closedReason`, `successorMandateId @unique`, `carryOverFromMandateId @unique` | identity/uniqueness; closure for carry-over |
| `DealEvent` payload (`HUMAN_REVIEW_DECISION`, V2) | adds `termsHash`, `attestationId`, `approvalNonce` | closes W15 |
| `DetectorRelease` / `DetectorRevocation` (P7, separately approved) | immutable release manifest rows (id, version, `vocabularyHash`, review record hashes, approval) and a revocation list | Q10 |

Migration name proposal: `language_policy_contract` (single, additive). Immutability triggers for any new immutable table mirror the existing `*_immutable` pattern.

---

## 15.12 API changes proposed (internal TypeScript APIs; no new HTTP routes now)

Only `/api/auth/{login,logout,session}` and `/api/health` exist; mandate/deal/verification endpoints have **not been built** (UI/webhooks not started), so there is no external API to break. Internal changes:

* `previewMandate`/`approveMandate` (`src/domain/mandates.ts`): accept an optional `languagePolicy` → V2 document (with pre-allocated `mandateId` and `nonce`, Q14); preview returns a human-readable rendering of the policy plus the digest; V1 path unchanged. `openSealedMandate` is replaced by a version-dispatching verifier returning the **parsed strict object** (never a cast) with closed-enum error codes (§15.5.3).
* New: `previewDealApproval` / `approveDealWithAttestation` (extends `resolvePreAuthReview`, `deals.ts:167-186`): the two-step preview/confirm of §15.5.5, issuing the nonce, writing the `TermsAttestation` and the extended `HUMAN_REVIEW_DECISION` event in one transaction. The legacy `humanApproved` waiver (`deals.ts:113`) must not apply to reason `LLM_MAPPING_APPROVAL_REQUIRED`.
* New: `GuardedProvider` / `ModelGate` / `assertModelIsolation` (§15.9.0); settlement engine gains the attestation check before PayPal order creation (V2 only).
* `parseTerms` (new, dispatch on `schemaVersion`); `lockTerms` accepts V1 or V2; V2 runs the full §15.7 validation before hashing.
* `evaluatePolicy`: new reasons `LANGUAGE_POLICY_REQUIRED`, `LANGUAGE_POLICY_WEAKER_THAN_MANDATE`, `CLASSIFICATION_INVALID` (closed enum).
* `PipelineDeps`: `ai`/`skeptic` become a single `ModelRunner` interface; `language` replaced by an injected `LanguageDeployment` from the composition root.
* `callLLM`: parameter becomes the branded `ModelInput`; raw `user: string` removed from the verification path.
* `resolveEvidence(refs, allowedFieldIds)`.
* `submitVerificationToSettlement`: adds the binding check.
* Seller wire contract (`taskSpecSchema`): **does not** carry `inputFields`, classification or the policy (so a seller is not told which fields a model reads); it carries the closed field list and supported languages so honest sellers can avoid `UNVERIFIABLE`. (Q7)
* Future HTTP endpoints (when built) must return the policy and classification in the mandate/brief preview for human confirmation.

---

## 15.13 Security threat matrix

For each threat: **P**recondition · **B**oundary · **C**ontrol · **T**est · **R**esidual.

**T1 Prompt injection in an OPAQUE field.**
P: seller controls a cell/metadata value declared OPAQUE. B: artifact → model input builder. C: opaque fields cannot be placed in any `AuthorizedView`; `buildModelInput` is the only prompt constructor; `resolveEvidence` refuses refs to opaque fields; no model-output chaining. T: M1 canary test — every opaque cell/header/metadata value holds a unique canary token; assert **no** `ScriptedLlm` request (verifier pass 1/2, skeptic, any role, error/retry paths) contains it; mutation test (disable the filter → test fails). R: deterministic flags may still escalate to human; a human reading the opaque field is outside this design.

**T2 Injection inside a declared criterion field.**
P: attacker writes instructions into a `CRITERION_INPUT` field. B: that field is model-readable by design. C: existing deterministic prescan (verifier-targeted instructions, hidden chars), delimiter-wrapped untrusted text, evidence-required output, two-pass agreement, **AI signals only escalate** (AGENTS.md #16), per-criterion isolation limits blast radius, model never decides capture alone. T: existing injection cases re-run against V2 + new case where the injection tries to flip a *different* criterion's verdict (cross-criterion). R: **a model can still be misled within the one criterion it reads**; the control is that its verdict can only help or escalate, and `required` criteria should be deterministic where possible.

**T3 Multilingual injection.**
P: injection written in a language outside the supported set, or mixed. B: language assessment of exactly the sent text. C: unsupported/uncertain → fail closed (no call); detector vocabulary hash is part of the signed policy. T: L-series (13 override languages × injection phrase; supported-language injection still caught by prescan). R: the lexical detector is not exhaustive; languages absent from its vocabulary may classify as `UNCERTAIN` (safe) but a crafted text that *looks* supported could pass (see T5).

**T4 Short unsupported-language instructions.**
P: ≤ N-character command in an unsupported language. C: `shortText: NO_EXEMPTION`; short non-structural text is `UNCERTAIN` unless in a supported vocabulary. T: boundary tests at lengths 1–N for each override-language imperative. R: very short supported-vocabulary tokens that happen to be commands in another language (homographs) — recorded count, human reviewable.

**T5 Unicode / mixed-script obfuscation.**
P: homoglyphs, zero-width, bidi, tag characters, NFC/NFD tricks, mixed scripts. C: existing hidden/bidi/tag detectors (severe, deterministic) + field-ID and NFC rules + script-mix → `UNCERTAIN`. T: fuzz corpus with confusables; property test that normalisation cannot turn UNCERTAIN into SUPPORTED. R: confusables outside the shipped tables.

**T6 Field-mapping manipulation.**
P: attacker (seller, or a compromised agent) tries to widen `inputFields`, reclassify a field, or smuggle a field via naming. B: negotiation and terms lock. C: V2 strict schema, bijection check, `detectTermsDrift` over V2 fields / hash comparison, policy engine, `termsHash` lock, closed-world delivery check, seller wire contract cannot carry mapping. T: mutate each mapping element post-lock → drift/hash mismatch; negotiation attempt to add a field → `TERMS_DRIFT`. R: a *principal* who authors a bad mapping is within authority; the human preview mitigates (Q2).

**T7 Deployment configuration weakening the signed policy.**
P: operator/env drift sets fewer restrictions or more languages. C: `stricterOf` is monotone; weaker dimensions recorded; startup validation; detector registry. T: property tests on `stricterOf` (never weaker than P); config matrix (every dimension weakened → effective unchanged and `deploymentWeakerDimensions` populated). R: an operator can still *remove* the whole LLM feature (safe direction) or alter code (outside the config trust boundary — covered by release integrity, not by this design).

**T8 Terms-hash omission or canonicalisation ambiguity.**
P: a new field not covered by the hash; list-order or Unicode variants hashing differently/equally. C: all new fields inside the hashed object; normalisation rules (§15.4); duplicates rejected; domain-separation tags. T: hash coverage test enumerates every property of the V2 schema and asserts that mutating it changes `termsHash` (schema-walk, so a future field cannot be forgotten); reorder tests; cross-version non-collision. R: JS/JSON number and string edge cases are constrained by existing `canonicalJson` (safe integers only).

**T9 Stale verification result from an older policy.**
P: a result produced under a weaker/other policy or older detector is submitted after terms/policy/mandate changed. C: `binding` check in intake (terms hash, policy hash, mandate digest, detector/vocab, `verifierVersion`); legacy `binding`-less results only for V1 + frozen version set. T: tamper each binding element → intake rejects; replay a gate4 result against V2 terms → rejected; bump detector version → previous results stale. R: V1 legacy results stay acceptable by design (§15.10).

**T10 Model context leakage via logging or secondary calls.**
P: raw prompt/response written to logs/ledger/AgentRun; model output reused in another call; error paths echo input; the buyer/seller agent receives verification detail. C: `AgentRun` keeps `promptHash` + manifest hash only (existing `outputRedacted`); no model-output chaining; `VerificationResultPublicView` for any other consumer; error objects carry closed codes only; logger redaction test. T: M5 (capture logs, ledger payloads, AgentRun rows, thrown error messages under canary load → no canary), M6 (buyer-prompt trace), M7 (no output chaining). R: a model provider's own retention is outside our boundary (real LLM is not validated in this project).

**T11 Invalid or missing language-detector output.**
P: detector throws, times out, returns malformed/empty/unknown label, or is absent in the build. C: every non-valid output ⇒ `UNCERTAIN`/`SCAN_INCOMPLETE` ⇒ fail closed; registry mismatch ⇒ `LANGUAGE_DETECTOR_MISMATCH`; prescan work budget/deadline retained. T: inject each failure mode via a stub detector → 0 model calls, criteria `UNVERIFIABLE`. R: availability — a broken detector makes all LLM criteria need human review (by design).

Rows added in Revision 2 — **T15 attestation replay / transplant** (P: attacker reuses a valid attestation for another deal or edited terms; B: engine gate; C: `unique(dealId)`, single-use nonce, bound `dealId`/`termsHash`/`mandateDigest`/`mappingHash`, purpose tag, key registry; T: transplant to another deal, edited terms, expired/revoked key → engine refuses; R: an attacker holding the application key can mint attestations — the key's protection is outside this design); **T16 attestation mis-described as a user signature** (P: UI/docs claim cryptographic user consent; C: fixed wording in §15.5.4, lint test over UI/docs strings; R: social, not technical); **T17 downgrade of a V2 mandate/terms to V1 parsing** (C: §15.5.3 dispatch + Q13 guard + P1 readers; T: S4, G5, G6; R: none known); **T18 carry-over double spend** (C: §15.19 atomic closure, unique successor; T: concurrency tests; R: depends on P6 implementation); **T19 detector release poisoning** (C: §15.18 review, immutable hashes, revocation; R: reviewer error remains possible); **T20 isolation-layer bypass** (a new code path calls a provider directly: C: `GuardedProvider` + static call-site test + assertion layer; T: M8, P0 mutation tests).

Additional rows beyond the 11 requested: **T12** model call on a deterministic-only deal (W1) — control D5, tests D1–D6; **T13** rollback/downgrade reading V2 data with old code (W4) — control D9 and tests G5/G6; **T14** evidence-reference to a field the model never saw (W8) — control `resolveEvidence(allowedFieldIds)`, test M4.

---

## 15.14 Test plan and rollout order

### 15.14.1 Tests (Vitest; DB tests against `mandate_test`; scripted LLM only; mocked PayPal only)

**Schema / validation (V)** — V1 missing classification; V2 duplicate field; extra field; conflict (bijection broken); `OPAQUE` with criteria; `CRITERION_INPUT` with empty criteria; deterministic criterion with `inputFields`; `llm_judged` without `inputFields`; wildcard/"all" rejected; unknown criterion/field IDs; invalid policy (each enum/subset rule); unknown keys rejected (strict) and unknown `schemaVersion` rejected; field-ID Unicode rules.
**Canonical / hash (H)** — golden hashes for fixed V1 documents (proves V1 untouched, run on the checked-in fixtures); V2 golden vectors; schema-walk coverage test (every property changes the hash); list reorder invariance; duplicate rejection; V1/V2/policy cross-domain non-collision.
**Signing / approval (S)** — V2 mandate digest covers `languagePolicy` (mutate → `openSealedMandate` null); V1 mandate verifies byte-identically; preview renders the policy and the digest; two-step confirmation unchanged; `LANGUAGE_POLICY_WEAKER_THAN_MANDATE` and `LANGUAGE_POLICY_REQUIRED`; attestation verifies and tamper fails (Q1 approved; A-series below).
**Model-input boundary (M)** — *at the actual model boundary* (`ScriptedLlm.requests`, both verifier passes and skeptic): **M1** canary in every opaque field/header/metadata/undeclared field never appears in any request; **M2** each criterion group's request contains only its fields (and canaries of other groups' fields are absent); **M3** manifest ⊆ authorisation (post-hoc checker also tested with a corrupted manifest); **M4** evidence refs to non-authorised fields refused; **M5** logs/ledger/AgentRun/error messages contain no canary; **M6** buyer/seller agent prompts built from a full delivery contain no fragment or model text; **M7** no model-output chaining; **M8** static: only the `ModelRunner` module imports `callLLM`/provider; `callLLM` rejects a non-branded input at compile time (type test).
**Deterministic-only (D)** — **D1** terms with no `llm_judged` ⇒ `modelCallsPermitted=false`; **D2** with verifier and skeptic *configured* and a hostile artifact, **0** requests (counting provider that fails the test if invoked); **D3** indirect paths: AI extraction helpers, summaries, buyer agent, error paths — canary absent; **D4** settlement decision identical with models absent vs present (differential test over the Attack Lab artifacts); **D5** a V2 deal that carries `artifactSchema`/`languagePolicy` but no LLM criterion still makes 0 calls; **D6** construct the LLM-criterion variant of the same deal ⇒ V2 validation demands policy + mapping + V2 mandate. This replicates and replaces the read-only probe (which currently *fails* the expectation: 2 verifier + 1 skeptic calls).
**Language (L)** — table in §15.9.2 row by row; each of the 13 override languages; short text lengths; mixed script; detector failure modes (T11); scan-budget exceed; per-criterion scope (an unsupported-language cell in an `OPAQUE` column is ignored; in a `CRITERION_INPUT` field of another criterion's group does not block the first group).
**Deployment (C)** — `stricterOf` property tests (fast-check or exhaustive small lattice); config matrix; startup failure on invalid config; registry mismatch; overlay can only tighten.
**Migration (G)** — **G1** every stored V1 terms/mandate in a fixture corpus (including the three mandate shapes found in W5) parses and hashes to the stored digest/hash after the change; **G2** V1 deterministic-only deal runs to completion with no model call; **G3** V1 LLM deal pre-verification → `LEGACY_TERMS_NO_INPUT_BOUNDARY`, NEEDS_HUMAN, 0 calls; **G4** V1 post-verification deal settles from its stored `binding`-less result; a `binding`-less result is refused for V2 terms; **G5** old-reader guard rejects an unknown `schemaVersion`/unknown key (the P0 reader); **G6** simulated rollback: V2 data + P0 reader ⇒ fail-closed, not silently weaker.
**Staleness (T)** — tamper each `binding` element; replay older result; detector/vocabulary bump.
**Revision 2 additions** — **S-series** of §15.5.3 (V2 seal: experiment regressions, per-step failure, downgrade matrix, duplicate-key/non-canonical, key registry); **A-series (attestation)**: payload binds every listed field (mutate each → engine refuses); one attestation per deal; nonce single-use; V2 LLM deal cannot reach `reserveForDeal`/order creation without it; legacy `humanApproved` path refused for `LLM_MAPPING_APPROVAL_REQUIRED`; preview renders each required element (criterion, type, permitted fields, excluded fields, policy, unsupported/uncertain consequences) — snapshot test; wording lint ("application attestation", never "user signed"); V1 deals unaffected; **P0-series**: the five guarantees of §15.9.0 including `GuardedProvider` throwing on a budget-0 call, `assertModelIsolation` failing a corrupted log, and canary at every listed boundary with a mutation partner each; **N-series (Q6)**: OPAQUE names never appear in any call; a model-visible name-like token → `UNVERIFIABLE`, zero calls for that group; a short non-name string is not flagged as malicious; no `ALLOW_COUNTED` value is accepted by the policy schema; **K-series (Q9, if P6)**: §15.19 tests; **D-series (Q10)**: release manifest hash reproducible, permissiveness delta computed, permissive release not selectable by an existing mandate, revoked release fails closed.

**Attack Lab additions** — new cases (cross-criterion injection, opaque-field canary, undeclared column, unsupported-language short command, policy-weakening config, stale-result replay) with the existing mutation harness extended with mutants: *remove the opaque filter, skip the classification check, ignore the floor merge, drop the binding check, call models on deterministic-only terms*. Each mutant must be killed. Measured numbers only; the real-LLM column stays "NOT VALIDATED".

### 15.14.2 Rollout order (Revision 2 — P0 is the W1 fix; each stage needs its own explicit approval)

* **P0 — W1 model isolation (no contract change, V1 and V2 agnostic):** §15.9.0 (decision layer, `GuardedProvider`/`ModelGate`, isolation assertion), canary and mutation tests, `VERIFIER_VERSION` bump (`gate5-iso-1`), correction of fixtures. After P0 **no model is called anywhere in verification** (V1 never; V2 does not exist yet). Reversible by revert (re-opens W1).
* **P1 — forward-compat guards (no new data):** reject unknown `schemaVersion`/unknown keys in `openSealedMandate` and `parseTerms` (no cast, no stripping); post-V1-verification strict shape guard (Q13); key registry. Behaviour-neutral for all existing data (proved by G1/G5/S3).
* **P2 — V2 seal verifier and dual-reader (no writer):** §15.5.2–15.5.3 verification, canonicalisation rules, policy-engine reasons, intake `binding` check.
* **P3 — V2 writers behind an explicit deployment switch (default off):** V2 mandate approval (with `mandateId`/`nonce`), TermsV2 lock, `TermsAttestation` issue and engine gate (§15.5.4–15.5.5).
* **P4 — V2 model use:** `ModelRunner` with per-criterion groups, field classification enforcement, language policy enforcement, manifests. LLM criteria become usable only here.
* **P5 — enforcement hardening:** V1 deprecation warnings; deprecated env removal (Q8).
* **P6 (optional, separately approved) — budget carry-over (§15.19).**
* **P7 (separately approved) — detector release tooling and governance (§15.18).**

Because P0 blocks all model use, the system is **strictly more conservative** at every stage than today.



---

## 15.15 Rollback strategy (and its limits) — Revision 2

* **P0 rollback** (revert the model gate): safe; it only re-opens W1 and should not be done without recording why.
* **P1 rollback:** do **not** roll back below P1 once any V2 mandate/terms/attestation exists. Old code would `JSON.parse(...) as MandateDocument` a V2 document and silently ignore the policy (S1). P1 exists precisely so that any build ≥ P1 fails closed on data it cannot interpret.
* **P2–P4 rollback:** turn the **V2 writer switch off** (P3) and leave dual-readers in place; in-flight V2 deals continue or go to human review; no V2 object is deleted or rewritten.
* **Database:** all columns additive/nullable; the "down" migration drops them only if no non-null value exists; historical data is never rewritten, so there is nothing to restore. New immutable tables (`TermsAttestation`) are never dropped while rows exist.
* **Key rotation / key compromise:** attestations and V2 seals are verified through a key registry keyed by `keyVersion`; a compromised version is marked revoked, and objects signed by it fail closed (`KEY_VERSION_REVOKED`) pending re-approval. (Secrets are never printed or stored in design artefacts.)
* **Detector/registry failure in production:** LLM criteria go to human review (fail closed); deterministic-only deals are unaffected (no AI dependency).
* **Emergency kill switch:** an operator can disable all model calls (the safe direction); verification continues deterministically and LLM criteria become `UNVERIFIABLE`.

---

## 15.16 Open questions requiring human approval (Revision 2)

### 15.16.1 Decided as architectural direction (not implementation approval)
Q1, Q2, Q4, Q6, Q9, Q10 approved; Q12 **not** approved; W1 designated P0; signature-scope correction accepted. See the decision matrix in §15.0A. No further input is needed on these unless the owner wishes to revise them.

### 15.16.2 Still UNDECIDED — full text. No decision has been inferred for any of these.

**Q3 — Should the signed mandate carry an explicit switch `allowLlmJudgedCriteria`?**
*Context.* In the design, whether a deal may use LLM-judged criteria is *derived*: the mandate must be V2 with a valid language-policy floor, the terms must be V2 with a valid mapping, and (Q1/Q2) a human must approve the mapping and the application must attest it. Nothing at the mandate level says "this principal permits AI judgement at all".
*Options.* (A) **Derived only** — no new field. (B) **Explicit signed boolean** in the V2 document, default `false`, displayed in the mandate preview; policy refuses LLM-criteria terms unless it is `true`.
*Trade-offs.* (A): one source of truth, smaller signed surface, fewer ways for two fields to disagree; the principal's consent to AI is expressed per deal at the attestation step. (B): a coarse, visible, per-mandate kill switch that is signed and cannot be enabled by terms alone; costs one more field, one more consistency rule (`true` is meaningless without a valid floor), and one more thing for the principal to understand at mandate time; because the per-deal human attestation already exists, (B) mainly adds defence in depth and clearer intent.
*Recommendation.* (A) derived only, with (B) as a reasonable choice if the owner wants mandate-level consent to be explicit. **Not decided.**

**Q5 — Cap on distinct model "groups" per deal (cost and attack-surface bound).**
*Context.* Per-criterion least privilege means criteria with identical `(inputFields, inputMaxRows)` share one call set; criteria with different views need separate call sets. Each group costs 2 verifier passes + 1 skeptic = 3 model calls. Terms already allow up to 20 criteria, so the worst case without a cap is 20 groups = 60 calls per delivery (plus latency and per-call failure/UNVERIFIABLE surface).
*Options.* (a) cap 1 (all LLM criteria must share one view — simplest, weakest isolation between criteria); (b) cap 3; (c) cap 5; (d) no cap beyond the 20-criterion limit; (e) cap set per deployment vs. fixed in the signed policy vs. fixed in code.
*Trade-offs.* A low cap bounds cost, latency and the number of distinct prompts to test, but pushes deal authors toward wider shared views (weaker least-privilege). A high cap gives finer least-privilege but multiplies cost and failure modes and enlarges the test matrix. A cap stored in the *signed* policy is tamper-evident but cannot be changed without a new mandate; a cap in deployment can only be tightened (never raised above the signed value) under the monotone-merge rule.
*Recommendation.* 5, enforced at V2 terms validation, tightenable by deployment. **Not decided.**

**Q7 — What the seller-facing wire contract may disclose about the field mapping.**
*Context.* The seller needs to know what to deliver; the mapping reveals which fields a model reads, which is useful to an attacker choosing where to place injected text.
*Options.* (A) disclose nothing new (sellers only learn of failures after `UNVERIFIABLE`); (B) disclose the **closed list of field names** and the **supported languages**, but not each field's classification, any criterion's `inputFields`, or the policy hash; (C) full disclosure including classification and per-criterion fields.
*Trade-offs.* (A) is least informative but makes honest sellers hit avoidable `UNVERIFIABLE` outcomes (e.g. delivering a column the terms never declared, or text in an unsupported language) and wastes human review time. (B) gives honest sellers what they need to comply while keeping the model-reading map private; the security controls must not depend on that secrecy (they do not: the map is hash-locked and enforced regardless of what the seller knows). (C) is simplest and most transparent but hands an attacker the targeting information for free.
*Recommendation.* (B). **Not decided.**

**Q8 — What to do with the deprecated deployment variables `MANDATE_SUPPORTED_LANGUAGES`, `MANDATE_LANGUAGE_SCOPE`, `MANDATE_OPAQUE_COLUMNS`.**
*Context.* After P0 no V1 deal calls a model, so these variables have no effect on V1. For V2 they may only tighten via the floor.
*Options.* (a) remove them immediately when V2 model use ships (P4); (b) keep them, log a deprecation warning for one release, then remove (starting to *fail startup if set* at removal); (c) keep them indefinitely as read-only inputs to the floor; (d) ignore them silently from P0.
*Trade-offs.* (a) is cleanest but breaks any deployment that still sets them with no warning period. (b) is the usual safe path but leaves a window in which an operator may believe the variables still control something. (c) keeps a second configuration surface that must be tested forever. (d) is the worst: silent no-ops invite false assurance, the very failure this design is meant to remove.
*Recommendation.* (b), with an explicit warning that they no longer control V1 behaviour from P0. **Not decided.**

**Q11 — Correcting `docs/14-attack-lab.md` (§14.20 and the G21 table row).**
*Context and a disclosure.* docs/14 claimed that a deal with no LLM-judged criterion "cannot be steered by any text" and that no model reads such text. The claim is true of the settlement decision and false of model exposure (W1, measured). **In the previous turn I already applied a two-place, documentation-only correction note to docs/14 (the §14.20 sentence and the G21 row) without waiting for your answer, because it corrects a factual error in the record; no code was touched.** That edit is in place now.
*Options.* (a) keep the notes as they are; (b) reword; (c) revert them and carry the correction only in docs/15; (d) additionally add an errata section listing every docs/14 statement affected (the "Model: n/a" annotations for G21–G23 and G36, and the §14.25 gate wording) and update the gate table in docs/09.
*Trade-offs.* (a) is minimal and keeps the record honest; (d) is more complete but is a larger documentation change and would be easier to do after P0, when numbers can be re-measured; (c) leaves a known-false statement uncorrected in the document most readers will consult.
*Recommendation.* (a) now, then (d) after P0 with re-measured numbers. **Not decided** (the existing note stays unless you say otherwise).

### 15.16.3 New questions raised by this revision — no decision inferred

**Q13 — Strict post-verification shape guard for V1 mandates.** Adds a rejection path after the unchanged V1 signature check (unknown keys, or any `schemaVersion`/`languagePolicy`/`carryOver`, are rejected; the three historical shapes are accepted). *Benefit:* closes the silent-ignore/downgrade hole (S1). *Risk:* a real V1 document with a key I have not seen would be rejected (none exist in the test corpus). *Recommendation:* yes, after the §15.10.6 corpus check. **Not decided.**

**Q14 — Pre-allocate `mandateId` and a 128-bit `nonce` inside the V2 signed document, plus a unique index on `mandateDigest`.** *Benefit:* the signature binds the mandate identity, attestations can bind a signed ID, identical documents cannot be re-inserted (S5). *Cost:* `approveMandate` must generate the id before sealing; id format fixed at creation. *Recommendation:* yes. **Not decided.**

**Q15 — Key registry (`keyVersion → public key`, with revocation) for V2 seals and attestations.** *Benefit:* unknown or revoked versions fail closed; rotation is possible (S6). *Cost:* a configuration surface for public keys (public material only; no private key is ever in the registry or in documents). *Recommendation:* yes; start with an environment/file registry. **Not decided.**

**Q16 — Attestation for deterministic-only V2 deals (`approvalKind: POLICY_WITHIN_MANDATE`).** The owner's text prefers consistency; code-read shows the existing workflow can host it for V2 only. *Trade-off:* it makes the engine depend on the attestation for every V2 deal (more consistent, one more failure mode), and it must always be labelled "recorded by the application under mandate policy" — never "approved by a human". *Recommendation:* yes, labelled as above. **Please confirm.**

**Q17 — Sequencing and test churn of P0.** P0 stops all model use in verification, so the existing scripted-AI Lab cases and tests that use V1 `llm_judged` terms will expect `UNVERIFIABLE` and the AI-dependent Lab numbers must be re-measured after V2 exists. *Recommendation:* approve P0 **separately and first** (it is small, independent of any signed-contract change, and fixes W1 now). **Not decided.**

### 15.16.4 What happens next
No implementation, schema or contract change will start until the owner explicitly approves a named stage (P0 … P7) in writing. Q12 stays "not approved": no code, credential, environment file or signing material goes to an external party without a separate explicit approval.

---

## 15.17 Acceptance-criteria traceability (design level — nothing here is *verified*, only *designed*)

| Acceptance criterion | Where the design satisfies it | Proving tests (to be written) |
|---|---|---|
| Every model-readable field explicitly authorised | §15.3.2, §15.7.1–2, `buildModelInput` | V*, M2, M3 |
| Every criterion has an explicit input boundary | §15.3.1 (`inputFields` mandatory for `llm_judged`), §15.8 | V*, M2 |
| Every opaque field excluded from every AI call | §15.7.5, D4 | M1, M5, M6, M7 |
| Language policy cryptographically bound to approved terms | §15.3.4, §15.4.2, §15.5, optional Q1 | S*, H* |
| Deployment can strengthen but not weaken | §15.6.2–3 | C* |
| Invalid/incomplete configs fail closed | §15.7.3, §15.9.1 steps 3–7 | V*, L*, C* |
| Deterministic-only deals have no AI dependency | D5, §15.9.1 step 4 | D1–D6 |
| Historical signatures not silently altered | §15.4.8, §15.10 | G1, G5, G6 |
| Stale results cannot authorise settlement under changed terms | D7, §15.9.1 step 9 | T* |
| Migration / backward compatibility addressed | §15.10, §15.14.2, §15.15 | G* |
| Approval event bound to exact terms and mapping, attributed to an actor, not mis-described | §15.5.4–15.5.5, D11–D12 | A-series, S-series |
| No model call for deterministic-only or V1 deals; no successful verification if isolation fails | §15.9.0 (P0) | P0-series, M*, D* |
| No automatic budget carry-over | §15.19, D13 | K-series |
| Detector changes cannot silently loosen an approved mandate | §15.10.5, §15.18, D14 | D-series |

**Not claimed:** that any of this is implemented; that the Attack Lab overall gate passes (it is PARTIAL); that a real LLM or real PayPal behaviour has been validated (neither has been run); that language detection is universal.


---

## 15.18 Detector governance (decision Q10)

**Principle.** A detector release changes what the signed language policy means. Therefore a release is a governed, immutable, reviewed artifact, and a policy pins the exact release (`detector.id`, `detector.version`, `vocabularyHash`). The shipped vocabulary has **not** been reviewed by native speakers (stated in docs/14); this section defines the process that must precede any claim of reviewed coverage.

**Release requirements (all mandatory before a release can be pinned by a new mandate):**
1. **Language/domain review** per supported or recognised language by a qualified reviewer, preferably a native speaker; the review record names the reviewer, date, scope and findings.
2. **Security review** for prompt injection, paraphrases, code-switching, mixed scripts and Unicode evasion; the review record lists the adversarial corpus used.
3. **Versioned immutable artifacts**: vocabulary files, script/confusable tables, detector code identity, evaluation fixtures — each with a sha256, assembled into a release manifest whose own hash is the `vocabularyHash` used in policies. Published releases are never edited; a change is a new version.
4. **Reproducible evaluation**: fixtures in the repository, a deterministic evaluation command, seeded generation, and a **held-out set that was not used for tuning**. Only measured numbers are reported (including misses; today's known open gap: short instructions outside the 13-language vocabulary, G26/G27).
5. **Explicit release approval and audit history**: owner approval recorded in an append-only release log (who, when, manifest hash, review records, evaluation results).

**Permissiveness rule.** A `permissivenessDelta` is computed mechanically between releases over the fixture corpus (strings whose class moves toward SUPPORTED, languages added, thresholds relaxed). Any release with a non-empty "more permissive" delta (a) cannot be selected by an already-approved mandate or locked terms (they pin the older hash), (b) is selectable only by **new** mandates, and (c) is flagged in the new mandate's preview. A strictly-not-more-permissive release may be adopted by a deployment through the floor without touching signed objects. A defective release is added to a revocation list: pinned deals fail closed.

**What is not claimed.** No universal multilingual robustness. Unsupported or unlisted languages are handled by failing closed (UNCERTAIN/UNSUPPORTED → `UNVERIFIABLE` + human review), which preserves safety at the cost of review volume, not by claiming detection.

## 15.19 Budget carry-over specification (decision Q9) — default: none; this is the exceptional path

**Default.** A new mandate starts with its own budget. Unused budget on any earlier mandate is **not** transferred.

**Exceptional carry-over** is allowed only as an explicit, human-approved authorisation **inside the new signed mandate document** (`carryOver` object, otherwise `null`):

```jsonc
// ILLUSTRATIVE — not implemented
"carryOver": {
  "previousMandateId": "...",
  "previousMandateDigest": "...",
  "snapshot": {                                 // computed server-side under the old mandate's row lock, shown in the preview, then signed
    "previousBudgetTotal": "100.00",
    "committedAmount": "40.00",                  // active reservations + captured/settled amounts
    "outstandingReservations": [ { "dealId": "...", "amount": "25.00" } ],
    "remainingEligibleAmount": "60.00"
  },
  "carriedAmount": "50.00",                       // <= remainingEligibleAmount, chosen by the human
  "newBudgetCeiling": "150.00",                   // the new mandate's budgetTotal, signed; >= carriedAmount
  "reconciliation": "CLOSE_PREVIOUS_ATOMICALLY"
}
```

**Atomic closure / reconciliation (one database transaction):**
1. Lock the previous mandate row (the existing `lockMandate` primitive) and recompute the snapshot; if it differs from the previewed/signed snapshot, abort and require a new preview (no stale carry-over).
2. Insert the new mandate with `carryOverFromMandateId` (unique — a mandate can have **at most one** successor) and mark the previous mandate `closedAt` / `closedReason = CARRY_OVER` / `successorMandateId`.
3. A closed mandate refuses any **new** reservation. Its existing reservations stay attributed to it and settle against it; any amount later **released** from it does **not** re-enter any budget (it is not carried again without a second explicit human-approved carry-over). This is what prevents double reservation across versions.
4. Invariant checked by a reconciliation query and a test: for every mandate chain, `Σ committed ≤ Σ approved ceilings − carried amounts counted once`.

**Tests:** concurrent reservation racing the closure; second carry-over attempt from the same predecessor (unique violation); release after closure (does not increase any budget); snapshot drift between preview and approval; carried amount > remaining eligible (rejected); carry-over without human confirmation (rejected); the carry-over object tampered after sealing (signature invalid).

**Status.** Schema field reserved now (`null`); implementation and DB columns (`closedAt`, `closedReason`, `successorMandateId`, `carryOverFromMandateId`) are stage P6 and need separate approval.

## 15.20 Independent audit scope — PREPARED ONLY; NOTHING HAS BEEN SENT (decision Q12)

**Status:** external audit is **not approved**. No repository code, credential, environment file, database dump, key or signing material has been or will be sent to any external party without the owner's separate explicit approval. Under the user's AQG policy the eventual implementation is `deep` (signed contract, crypto-adjacent, data model, irreversible migration risk) and will need an independent audit once approved.

**Proposed scope (for the owner to approve or edit):**
1. V2 mandate seal: payload definition, canonical-form and duplicate-key handling, dispatch/downgrade rules, key registry and revocation (§15.5.1–15.5.3).
2. `TermsAttestation`: payload, binding set, nonce/replay handling, engine gate, honesty of the "application attestation, not user signature" wording (§15.5.4–15.5.5).
3. Model-isolation guarantee: `ModelGate`/`GuardedProvider`/`assertModelIsolation`, completeness of canary boundaries, mutation resistance (§15.9.0).
4. Field classification and per-criterion mapping validation; evidence-reference restriction.
5. Language-policy lattice (`stricterOf`) — monotonicity proof/property tests, detector pinning, permissiveness rule (§15.6, §15.18).
6. Migration/compatibility: V1 invariance, downgrade matrix, rollback fail-closed behaviour (§15.10, §15.15).
7. Carry-over atomicity and double-spend prevention (§15.19), if P6 is approved.

**Proposed method (if later approved):** the auditor receives this design document and a sanitised specification/test list first; implementation excerpts only on a separate, itemised approval; **never** `.env*`, `.spike/*`, signing keys, API keys, database contents or logs containing artifacts. Output required: findings by severity with reproduction steps; exit criterion: no unresolved blocking/critical/major finding (`deep`). Auditor output is evidence, not authority; the owner adjudicates.

**Questions the owner should answer before any submission:** which auditor(s); what redaction is acceptable; whether review is of the design only or also code; retention/deletion terms.

## 15.21 P0 implementation record (2026-11-07) - stage P0 ONLY

Owner approval: P0 (V1 model isolation) only. P1 and later stages are NOT started and NOT approved. Nothing else in this document is implemented.

* **What changed (source):** `src/verification/model-gate.ts` (new: `modelPolicyFor`, fail-closed on empty / unknown criterion types), `src/verification/pipeline.ts` (verifier and skeptic reachable only through the gated `models` handle; `hasLlmCriteria` is no longer discarded; V1 `llm_judged` criteria are `UNVERIFIABLE` with reason `LEGACY_TERMS_NO_INPUT_BOUNDARY`; `provenance.isolation` records the decision and the number of model calls made), `src/verification/contracts.ts` (`VERIFIER_VERSION` = `p0-iso-1`; optional `provenance.isolation`).
* **Not changed:** Prisma schema and migrations, `.spike/state.json`, mandate documents, signatures, canonical terms, `src/domain/*`, the settlement engine, the orchestrator, the buyer agent.
* **Evidence (mock PayPal, scripted models, real PostgreSQL `mandate_test`):** 21 model-boundary probes, each with a unique canary in an artifact cell and in manifest metadata and a configured, would-answer verifier and skeptic: verifier calls 0, skeptic calls 0, provider requests 0, AgentRun rows 0, canary observed false in all 21. A positive control (`tests/unit/model-gate.test.ts`) shows the canary IS visible at the provider when a model is called directly. Mutating the gate to permit models makes 3 of 10 unit and 10 of 18 DB tests fail.
* **What this does and does not establish:** the tests prove, for the paths they drive (direct pipeline, orchestrator advance/replay, delivery replay, claim takeover, retry, restarted orchestrator, challenge re-verification, buyer context), that no model is called for a V1 deal. It does **not** prove anything about a real LLM, about V2, or about model providers outside the pinned call sites; the layers 2 and 3 of §15.9.0 (`GuardedProvider`, post-call isolation assertion) are **not implemented** at P0, so the guarantee rests on the decision layer plus the static call-site tests.
* **Behaviour changes:** V1 deals with an `llm_judged` criterion now end `NEEDS_HUMAN` (previously a scripted/real verifier could pass them); the Lab scenarios and the DB tests that depended on a model call for a V1 deal were updated as described in docs/14 §14.26, and three DB test files replace the gate in their own test process only, to keep exercising the now-dormant AI-handling code.

## 15.22 Mutation baseline repair record (2026-11-08) - no P1 work

Before P1, the post-P0 mutation regression (22 killed / 6 survived / 1 invalid against the historical 29/29) was repaired as a TEST-HARNESS task only: two independent suites (docs/14 §14.27) - Layer A (P0 boundary) 17/17 killed; Layer B (dormant downstream defences, isolated test-only harness) 7/7 killed - plus two new real-gate probes that closed genuine test gaps (M24, M27) and a repository-wide architecture test. The two premature, unwired P1 files (`src/lib/strict-json.ts`, `tests/unit/strict-json.test.ts`) were deleted; `src/` is byte-identical to its pre-P1 state (56 files, digest 0478c058...efb8d). Application behaviour, Prisma, canonical terms, signatures and mandate readers are unchanged. **P1 is NOT started.**

## 15.23 P1 implementation record (2026-11-08) - forward-compatibility guards ONLY

Owner approval: P1 only. P2 and later stages are NOT started and NOT approved. P1 changes how authorization-bearing documents are READ; it writes no new document version, changes no Prisma schema, no migration, no canonical serialization, no V1 signature, no key and no stored record.

### Supported shapes (inventory)
* **Mandate documents** carry no version field. Exactly three shapes are read, each recognised STRUCTURALLY (which of the two behaviour flags exist) and validated by its own strict schema:

  | Shape | Keys | Stored rows when inventoried (test DB) |
  |---|---|---|
  | `V1_BASE` | the 9 base keys (`principalId, currency, budgetTotal, perDealMax, requireHumanAbove, allowedTaskTypes, counterparties, injectionPolicy, expiresAt`) | 64 (62 digest-consistent) |
  | `V1_NO_CANCELLATION_FLAG` | base + `allowPartialSettlement` | 969 |
  | `V1_FULL` | base + `allowPartialSettlement` + `allowPreDeliveryCancellation` | 13,083 |

  The cancellation flag WITHOUT the partial flag matches no shape and is refused (`UNRECOGNISED_SHAPE`). An absent flag stays absent (nothing is added or defaulted) and is consumed as "not granted" (`=== true` tests). 125 of 16,297 inventoried rows are deliberate tamper fixtures whose digest does not match their bytes; they are refused before parsing (`DIGEST_MISMATCH`), as before P1.
* **Locked terms**: one version, V1 = no version field and exactly the keys of `termsSchema`. Criteria: `deterministic` (id, text, required, weight, validator, params) and `llm_judged` (id, text, required, weight).
* **Session token body** (also authorization-bearing): exactly `uid, email, exp, csrf`.

### Version-dispatch rules (all fail closed)
1. Mandate text is parsed by the strict JSON reader (`src/lib/strict-json.ts`): malformed, trailing text, a duplicate key at any depth (compared after escape decoding), `__proto__`, depth over 32, size over 256 KB -> refused.
2. Not a plain object -> `NOT_AN_OBJECT`.
3. **Any** explicit `schemaVersion` (any value, including 1) -> `UNSUPPORTED_SCHEMA_VERSION`. Terms: `schemaVersion` on the terms -> `TERMS_VERSION_UNSUPPORTED`; on any criterion -> `CRITERION_VERSION_UNSUPPORTED`. A future document is never read as V1 and never stripped down to V1.
4. Unknown field -> `UNKNOWN_FIELD` (mandate) / `TERMS_INVALID` (terms). **A few new properties never make a document "V2":** without a `schemaVersion` they are simply unknown fields.
5. Missing base field -> `MISSING_FIELD`; flag combination outside the three shapes -> `UNRECOGNISED_SHAPE`; wrong type or value -> `INVALID_FIELD` / `TERMS_INVALID`.
6. The returned object is the strict schema's output; nothing is cast. `JSON.parse(...) as MandateDocument` and the non-strict `termsSchema.parse` on stored terms no longer exist on any read path (architecture tests).
7. V1 cryptography is untouched: same digest rule, same signed payload, same order (digest, then signature, then the new strict read). Verified by re-sealing each historical fixture and reproducing its stored bytes, digest and signature.

### Mixed-version and downgrade handling
Only V1 is readable, so every mixed or unsupported combination fails at the reader that meets the unsupported side, before negotiation, verification or settlement can use it. A future mandate + V1 terms: the opener returns null (policy `MANDATE_SEAL_INVALID`, engine `NEEDS_HUMAN`, integrity `MANDATE_SEAL_INVALID`, orchestrator `HALTED`). A V1 mandate + future-version or extra-field terms: policy `TERMS_VERSION_UNSUPPORTED` / `TERMS_INVALID`, delivery `TERMS_NOT_LOCKED`, pipeline `TERMS_DRIFT`, intake `STALE_VERIFICATION`, engine `TERMS_DRIFT`, integrity `TERMS_CHANGED_AFTER_LOCK`. Executed on PostgreSQL, including with a column-consistent recomputed hash and with a validly signed forged mandate (`tests/db/authorization-readers.db.test.ts`).

### Reader inventory (every place a stored authorization document is read)

| Document | Reader | Consumers |
|---|---|---|
| mandate | `openSealedMandate(Detailed)` -> `readMandateDocument` (only via `verifiedDocument`) | createDeal, negotiation ceiling, policy re-evaluation, settlement engine (settle, cancel), orchestration integrity |
| terms | `readTerms` / `readTermsOrThrow` / `termsMatchLock` | policy engine, drift detection (negotiation), delivery intake, verification pipeline, verification intake, settlement engine (record, challenge, re-verify, settle, human decision), integrity |
| session token | `verifySession` (strict JSON + strict schema) | auth routes |
| ledger payload digests | `stringField` in integrity (no cast) | integrity |

Writers of terms (`lockTerms`, the negotiation draft) use the same strict `termsSchema`, so an unknown field can no longer be persisted either.

### Duplicate-key handling
`JSON.parse` keeps the last duplicate (measured: `{"budgetTotal":"1.00","budgetTotal":"999999.00"}` reads 999999.00). Mandate documents are TEXT (`Mandate.canonicalJson`), so they are protected by the strict reader; adversarial fixtures cover a budget raised or lowered, the per-deal maximum, the human-review threshold removed, flags switched on, counterparties, expiry, principal, escaped-key spellings, nested duplicates and `__proto__`, each also as a validly signed copy. `Deal.termsJson` is JSONB: PostgreSQL collapses duplicate keys before the application sees the value, so duplicates cannot be detected there; terms are protected by the strict schema and the hash lock instead. Known limitation: a duplicate in a JSONB value is already resolved by PostgreSQL (last wins) and can only be caught at the writer, which receives a JavaScript object (it cannot hold duplicates).

### Release order and rollback
1. **Deploy the guarded readers (this build) first, to every consumer**: web instances, orchestrator workers and sweepers, any process that opens a mandate or loads terms. Restart long-running workers; a worker still running the old build is an unguarded reader.
2. **Verify**: `GET /api/health` returns `authorizationReaders` (`guard: "p1-strict-v1"`, the three mandate shapes, terms versions `[1]`, `v2Writers: "absent"`). Workers expose no HTTP endpoint: verify they run the same build artifact (process restarted after the deploy). Before deploying to a database run `npm run check:authorization-corpus` against it (read-only): every digest-consistent stored mandate must be readable.
3. **Old readers cannot be trusted with future documents**: the pre-P1 opener accepts a validly signed future document and ignores what it does not understand; the pre-P1 terms reader strips unknown fields while the hash still matches (both demonstrated by tests). Therefore no writer of a new version may be enabled until steps 1-2 hold for EVERY consumer and no pre-P1 instance remains.
4. **P1 has no V2 writers** (architecture test: nothing assigns a `schemaVersion`; `buildMandateDocument` emits exactly the V1_FULL keys). No V2 document exists or can be created by this build.
5. A future V2 rollout (P3) needs its own approval and a deployment gate that refuses to enable writes unless the reader guard is confirmed everywhere.

**Rollback.** Restoring a pre-P1 build is safe **only while no document of a newer version exists**, which is guaranteed throughout P1 (no writer, no schema change, no data change: a pre-P1 build reads exactly the same data). Once any future-version document has been written (not before P3), rolling back below P1 is forbidden: the old mandate opener would accept it and silently ignore its new fields, and the old terms reader would fail closed only by accident (hash mismatch). Rolling back from P1 to P0 changes nothing for stored V1 data.

### Known legacy limitations
* A stored mandate whose bytes are outside the three shapes (none found in the inventoried corpus) would be refused and the deal halted, not migrated; the remedy is a controlled migration with human re-approval, never an in-place rewrite.
* Mandate text is not required to be in canonical form (pre-existing V1 behaviour, kept; duplicate keys, the only canonical-form ambiguity that could change meaning, are rejected). A canonical-form check belongs to P2.
* JSONB cannot show duplicate keys (above). The seller client, the simulated seller and the PayPal client still use `JSON.parse` for counterparty / external bodies; they are not authorization documents and are validated by strict wire schemas.
* `detectTermsDrift` keeps its existing result for unreadable terms (`drift:false`); such terms are blocked by the policy engine and every settlement path.

### P1 evidence (measured; mock PayPal, scripted models, `mandate_test` only)
* **Tests**: unit 658/658 (24 files), PostgreSQL 468/468 (17 files), typecheck, lint and production build clean. P0 isolation tests (`model-isolation.db.test.ts`, 21 canary probes) still pass unchanged and the three historical shapes complete full deals with 0 model calls.
* **Golden compatibility**: for each of the three mandate shapes and two locked-terms fixtures (immutable copies of real stored rows, `tests/helpers/legacyFixtures.ts`): the stored bytes hash to the stored digest / lock; the strict reader returns an object equal to `JSON.parse` of the stored text (no key added, none removed); re-sealing reproduces the same bytes, digest and signature. One historical row selected first (the oldest base-shape row) turned out to be a deliberate tamper fixture with a non-matching digest; the selection rule (oldest row whose digest matches) is recorded in the fixture file.
* **Stored-corpus check** (`npm run check:authorization-corpus`, read-only, test database, rows created before the first P1 fixture): 16,573 digest-consistent mandates, **all accepted** (V1_BASE 62, V1_NO_CANCELLATION_FLAG 964, V1_FULL 15,547), 0 refused; 127 digest-mismatch tamper fixtures refused before parsing as before. Locked terms: 16,193 rows, 15,775 readable with hash equal to the stored lock, 288 readable but hash differs (drift fixtures), 130 refused as `TERMS_INVALID` (deliberate invalid-terms fixtures), and **0 rows that the pre-P1 reader would have accepted as a valid lock but the strict reader refuses**. Run against the whole test database the tool also reports 18 digest-consistent refused mandates: these are the forged unsupported / duplicate-key / ambiguous mandates created by `authorization-readers.db.test.ts` itself (expected; the tool exits non-zero on them by design).
* **Mutation (separate, labelled `post-p1`; earlier reports untouched, hash-verified)**: Layer A (P0 boundary) 17/17 killed; Layer B (dormant downstream) 7/7 killed; **new Layer C (P1 reader guards) 21 defined, 20 killed, 1 survived on the first run (`P1-C21`)**. `P1-C21` re-introduced an unvalidated cast of a ledger payload in `integrity.ts`. Explanation: behaviourally equivalent (the compared value is checked with strict equality, so a wrong-typed value can never match); it is a type-safety regression, and nothing pinned it. Closed by an architecture rule that pins the set of ledger-payload casts (`authorization-reader-architecture.test.ts`); re-run under `post-p1-c21`: killed. The first Layer C report keeps the survivor on record. Killers include the strict-JSON unit tests (duplicate key, `__proto__`, trailing text), the adversarial reader tests (unsupported version, unknown / missing field, ambiguous shape, cast bypass, loosened schemas) and the architecture tests (new parsing module, direct `termsSchema` read, new version writer, `schemaVersion` emitted by the writer).
* **Restoration**: `src/` hashed before and after every run (identical digests, 58 files); per-file comparison with the pre-P1 manifest shows only the intended files differ (health route, compat, mandate, negotiation, policy, terms, session, strict-json, integrity, engine, delivery, pipeline). `.spike/state.json` and `prisma/schema.prisma` untouched; no migration.
* **Not done / not claimed**: no V2 writer, no V2 seal verification (P2), no TermsAttestation, no schema change. Nothing here is evidence about a real LLM or real PayPal. The reader guard is verifiable per web instance through `/api/health`; workers have no endpoint, so their upgrade is an operational step (restart and confirm the same build), not something this code can prove.

## 15.24 P2 implementation record (2026-11-08) - the V2 seal VERIFIER, isolated and operationally disabled

Owner approval: P2 only, and only the V2 cryptographic seal verification capability with its isolated tests. P2 does NOT create V2 mandates or terms, activate V2 deals, connect to negotiation / policy / settlement, change Prisma, or generate or touch any production key. P3 and later stages are NOT started and NOT approved.

### Exact scope
* **New (production source):** `src/domain/mandate-v2.ts` (verifier: `verifyV2MandateSeal`, strict schemas, error taxonomy), `src/domain/key-registry.ts` (public-key registry). Both are pure, verify-only and **imported by nothing else in `src/`**.
* **Changed (type-level / marker only):** `src/domain/mandate.ts` gains `schemaVersion?: never` on the V1 `MandateDocument` *type* (no runtime effect) so that a V2 document is not assignable to the V1 type the policy and settlement engines consume; `src/domain/compat.ts` adds the marker `v2SealVerifier: "isolated-not-connected"`.
* **Unchanged:** V1 serialization, V1 signatures and keys, V1 payloads, V1 locked terms, V1 key lookup (`openSealedMandate` still takes its single configured public key), every V1/P1 read path, the Prisma schema, all stored records.
* **Test-only:** ephemeral Ed25519 keys generated in memory; the test signer (`tests/helpers/v2Seal.ts`) is the only V2 signing code in the repository and builds the payload from the specification by its own code. Frozen golden vectors (`tests/helpers/v2GoldenVectors.ts`) were computed by an independent script that imports nothing from the repository.

### Interpretation of the approved specification (every point where the design left room, resolved conservatively)
| Point | Resolution |
|---|---|
| Signed payload | Exactly the format of section 15.5.2: `purpose "mandate-seal"`, `sealVersion`, `schemaVersion`, `keyVersion`, `mandateId`, `principalId`, `mandateDigest`, `languagePolicyHash`, `carryOverHash`, an echo of the ten authorization fields, `approvedBy`, `approvedAt`, `approvalMethod`. No field was added or removed. |
| "Signature algorithm context" | The approved payload carries none. The algorithm comes from the REGISTRY record (`ed25519` only) and is checked there; the envelope may not carry an algorithm or key field (strict envelope). |
| Nonce | 128-bit lowercase hex (32 characters). It is part of the document, hence of the digest and of the signature. It is not a separate payload key (the approved payload has none). |
| Mandate id | Pattern `^c[a-z0-9]{24}$` (a Prisma `cuid()` as `Mandate.id` is generated today). A later change of id format changes this one constant. |
| Document format | Money exactly `^(0|[1-9][0-9]*)\.[0-9]{2}$` and positive; instants in the canonical `toISOString()` form; `allowedTaskTypes` and `counterparties` strictly ascending (sorted, duplicate-free); `perDealMax <= budgetTotal`, `requireHumanAbove <= perDealMax`; `carryOver` must be `null` (carry-over is a later stage). |
| Language policy | Strict schema from section 15.3.3: `schema "mandate.languagePolicy/1"`, `policyVersion 1`, supported languages a non-empty ascending subset of en/fr/zh, detector id/version/`sha256:` vocabulary hash, behaviours `UNVERIFIABLE_HUMAN_REVIEW` or `REJECT_DELIVERY` (no "allow"), `nameLikeBehavior "UNCERTAIN"`, `shortText "NO_EXEMPTION"`, ascending `criterionScope` (empty for a mandate floor), `humanReview.required`. |
| Check order | Follows section 15.5.3 with the envelope checked first and the identity checks (id, nonce) after the signature. |
| Error codes | The design's `MANDATE_IDENTITY_MISMATCH` is split into `MANDATE_ID_MISMATCH` and `NONCE_MISMATCH`; `VERIFIER_ERROR` (an unexpected exception) was added so the verifier never throws. |

### Signed bytes
`message = canonicalJson(payload)`, where `canonicalJson` is the repository's existing function (keys sorted by UTF-16 code unit, no whitespace, safe integers only, throws on anything else) and the signature is Ed25519 over `message` as UTF-8. `mandateDigest = sha256(document text as received)`; because the text must equal `canonicalJson(parsed)` byte for byte, this is also `sha256(canonicalJson(document))`. The payload is REBUILT inside the verifier from the parsed document and the envelope; no caller-supplied echo is trusted.

### Canonicalization algorithm
1. Parse the received text with the strict reader (duplicate keys at any depth including escaped spellings, `__proto__`, malformed JSON, trailing content, depth > 32, size > 32 KB all refused).
2. Compute `canonicalJson(parsed)`.
3. Require it to equal the received text exactly. Otherwise `NON_CANONICAL_DOCUMENT`. **The verifier never replaces the received text with its canonical form**: a validly signed but non-canonical text (key order, whitespace, `\u` escapes, number spellings such as `2.0`, a trailing newline) is refused, never "fixed". NFC/NFD and confusable spellings are different bytes and are never normalised.

### Verification sequence (all fail closed; exact codes)
1 dispatch (`ENVELOPE_MALFORMED`, `UNSUPPORTED_SEAL_VERSION`) - 2 strict envelope (`ENVELOPE_INVALID`; every field exact, no unknown field, and the signature must be CANONICAL base64 of 64 bytes - the 86th character carries only 4 significant bits, so a different spelling of the same bytes is refused rather than accepted as a second valid string; found while checking a flaky test) - 3 digest, constant time (`DIGEST_MISMATCH`) - 4 strict JSON (`MALFORMED_JSON`, `DUPLICATE_KEY`, `FORBIDDEN_KEY`, `TOO_DEEP`, `TOO_LARGE`) - 5 version peek (`UNSUPPORTED_SCHEMA_VERSION`) - 6 canonical bytes (`NON_CANONICAL_DOCUMENT`) - 7 strict schema (`DOCUMENT_INVALID`) - 8 key from the registry: unknown / mismatched version (`KEY_VERSION_UNKNOWN`), algorithm (`KEY_ALGORITHM_UNSUPPORTED`), `REVOKED` (`KEY_REVOKED`), any other non-ACTIVE status (`KEY_DISABLED`), fingerprint (`KEY_FINGERPRINT_MISMATCH`) - 9 signature (`SIGNATURE_INVALID`) - 10 identity: signed mandate id equals the external record id (`MANDATE_ID_MISMATCH`), nonce equals the expected nonce when supplied (`NONCE_MISMATCH`). Anything unforeseen: `VERIFIER_ERROR`. The result is a typed `MandateDocumentV2` plus the key version and fingerprint, returned only after every check passed.

### Key registry contract
Exact-match lookup by `keyVersion` over an in-memory set of records built by `createKeyRegistry` (strict records: `keyVersion`, `algorithm "ed25519"`, `publicKeyB64` (SPKI DER), `fingerprint` (SHA-256 of the DER bytes), `status ACTIVE|DISABLED|REVOKED`). Construction throws for any invalid record, duplicate version, non-Ed25519 or unparsable key, or fingerprint mismatch. No default key, no fallback, no remote fetch, no trust-on-first-use, no environment loading, no private key anywhere in the verifier or the registry. The only registry the production build constructs is the empty one.

### Rotation and revocation behaviour and limitations
* A seal names its key version inside the signed payload, so it cannot be re-pointed at another version that holds the same key.
* `REVOKED` (compromise) and `DISABLED` (suspended) are both refused; a seal under a non-ACTIVE key is not verifiable until the key is ACTIVE again (DISABLED) or the mandate is re-approved under a new key (REVOKED).
* **Limitation:** there is no "retired but still trusted" state and no validity window. Rotating a key means keeping the old version ACTIVE until every mandate sealed under it has expired or been re-approved; disabling it earlier invalidates those mandates. Time-bounded trust (a revocation instant, so seals made before a compromise stay valid) is not implemented.
* The registry is static for the life of the process; changing statuses needs a new registry and a restart (an operational procedure for P3).

### Nonce limitation (not claimed)
The verifier checks the nonce's structure and signed binding and compares it with an expected value when the caller has one. **It does not and cannot prevent replay or reuse of a nonce across records**; two different sealed mandates sharing one nonce both verify (a test records this explicitly). Durable uniqueness needs a unique index and the V2 write path, which belong to the later authorized database / write stage.

### V1 immutability
All three immutable V1 golden fixtures and the golden terms hashes still hold (P1 tests unchanged and green); re-sealing each reproduces the stored bytes, digest and signature. A V2 envelope given to the V1 opener fails its signature check (the V1 payload differs); a V2 document signed with the V1 rules is refused by the V1 reader (`UNSUPPORTED_SCHEMA_VERSION`, the P1 guard); a V1 envelope or a V1 document wrapped in a V2 envelope is refused by the V2 verifier. No V1 rejection rule was added under the name of P2.

### V2 operational status: DISABLED
Proven by static tests (`tests/unit/v2-verifier-isolation.test.ts`): no production module imports the verifier or the registry; no live layer (negotiation, policy, verification, orchestration, settlement, agents, HTTP routes, deals, mandates, ledger) mentions them; the verifier's import closure is exactly seven pure files (no settlement, PayPal, database, orchestration, verification, agent or HTTP code) so even a future caller could not make it trigger a payment; it imports only `verifyMessage` from the signing module, contains no signing, private-key, environment, network or filesystem code, and exports no function other than `verifyV2MandateSeal`. No V2 record was written to any database.

### Required follow-up for P3 (separately approved)
V2 mandate writer and approval flow (preview showing the language-policy floor, `mandateId`/`nonce` allocation, the V2 seal producer holding the private key); `Mandate` columns (`sealVersion`, `mandateNonce` with a unique index, unique `mandateDigest`) and the dual-reader integration (V1 vs V2 dispatch at the single opener) behind an explicit deployment gate that refuses to enable V2 writes unless the reader guard is confirmed everywhere; key-registry loading and status management for operations; the time-bounded revocation decision; then TermsV2 / `TermsAttestation`.

### P2 evidence (measured; mock PayPal, scripted models, ephemeral test keys, `mandate_test` only; no V2 record was written to any database)
* **Tests**: unit 800/800 (27 files), PostgreSQL 468/468 (17 files), typecheck, lint and production build clean. One earlier PostgreSQL run showed two Lab failures (`L2`, `L4`) whose recorded durations were 519 s and 1,882 s against a 90 s limit: a host suspension, the same environment effect documented in docs/14 §14.12; the full suite was re-run on the identical code and passed 468/468. It is reported here, not hidden.
* **V2 vectors** (`tests/unit/mandate-v2-seal.test.ts`, 115 tests; `key-registry.test.ts`; frozen golden vectors computed by an independent script): valid canonical seal (the golden payload bytes signed verbatim by an ephemeral key verify, which is only possible if the verifier rebuilds the approved bytes exactly); wrong purpose tag; wrong schema version / seal version in the payload and in the document; wrong mandate id; wrong nonce; wrong digest; wrong language-policy hash; every authorization field missing, unknown, tampered (digest recomputed, old signature) and omitted from the signed echo; duplicate keys top-level, nested, in arrays and escaped; non-canonical but correctly signed text (key order, whitespace, escapes, `2.0`, trailing newline); NFC/NFD and homoglyph edge cases (never normalised); unsupported algorithm, unknown key version, wrong key, key confusion (signed as k1, presented as k2), revoked and disabled keys, a public key smuggled in the document or envelope; tampered signature at every byte position; non-malleable base64; V1 envelope under the V2 verifier, V1 document in a V2 envelope, V2 envelope under the V1 opener, V2 document under V1 rules; 700 random single-character mutations (never accepted); hostile inputs (the verifier never throws); every published error code is produced by at least one test.
* **Findings made while testing (fixed before the numbers below):** (1) the first verifier THREW on a document with an invalid amount or date because a cross-field refinement ran on already-invalid values: refinements are now total and the verifier has a top-level fail-closed wrapper (`VERIFIER_ERROR`); (2) a flaky test led to the discovery that the signature field accepted non-canonical base64 (several spellings of the same 64 bytes): now refused; both have named mutants.
* **V1 immutability**: the three immutable V1 fixtures, the golden terms hashes and all P0/P1 tests pass unchanged; re-sealing each fixture reproduces its stored bytes, digest and signature. Source diff against the pre-P2 manifest: two new files (`mandate-v2.ts`, `key-registry.ts`), one type-only line in `mandate.ts` (`schemaVersion?: never`), one marker in `compat.ts`. No change to Prisma, V1 key lookup, V1 payloads, locked terms or any record; `.spike/state.json` untouched.
* **Operational isolation**: `tests/unit/v2-verifier-isolation.test.ts` (static): nothing imports the verifier; no live layer mentions it; its import closure is seven pure files; it imports only `verifyMessage`; no signer, private key, environment, network, filesystem or database code; exactly one exported function. A V2 document is not assignable to the V1 `MandateDocument` type (compile-time test).
* **Mutation** (separate suites, labelled `post-p2-final`, run on the final code; earlier reports hash-verified unchanged; a first full run `post-p2` on the code before the base64 fix is kept as a historical record and is superseded): Layer A (P0 boundary) 17/17 killed; Layer B (dormant downstream) 7/7; Layer C (P1 readers) 21/21; **new Layer D (V2 verifier and registry) 31 defined, 31 killed, 0 survived, 0 invalid, 0 unreached.** Layer D mutants: signature-check bypass, digest-check bypass, purpose-tag bypass (an alternative purpose also accepted), schema-version bypass, mandate-id mismatch accepted, nonce mismatch accepted, unknown key accepted (registry fallback; verifier version check), revoked key, disabled key, duplicate-key acceptance (`JSON.parse`), non-canonical acceptance, four authorization-field omissions from the signed payload, V1/V2 downgrade acceptance, fingerprint bypass, algorithm bypass, non-constant-time compare, loosened envelope / document schemas, non-null carry-over, exception propagation, registry fingerprint and algorithm validation, base64 malleability, and four isolation violations (a live bridge module, a V1 module importing the verifier, a V2 signer export, an environment-loaded registry). `src/` hashed before and after (identical, 60 files, digest `63c1a2ba...dd16c`).
* **Not claimed**: nothing here is evidence about a real LLM or real PayPal; the verifier has never been run against a production key; durable nonce uniqueness, key-registry operations and any integration are not done.

## 15.25 P3 + P4 + P5 + P7 implementation record (2026-11-08)

Implemented as one coherent V2 lifecycle; the full record (architecture, owner-question handling, migration inventory and rollback, evidence, threat matrix, mutation results, benchmarks, residual risks, commands) is **docs/16-v2-lifecycle.md**. Deviations from the design text, each stricter or equal: group cap defaults to 1 (Q5 recommendation was 5, which is now the absolute maximum); a different detector triple is never ranked or treated as a successor (no registered-successor rule); deterministic-only V2 deals also require a HUMAN_PREAUTH attestation (no POLICY_WITHIN_MANDATE); the header row and manifest fields are always OPAQUE; AI-judged V2 criteria need a deployment switch (default off) because Q3 is unresolved.
