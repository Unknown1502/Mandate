# 4. Agents, Verification, and Settlement

## 4.1 Roles
| Agent | LLM? | Tools | Output |
|---|---|---|---|
| Buyer | yes | none (typed intents) | `propose`, `counter`, `accept`, `walk_away` |
| Seller (simulated counterparty) | yes | none | `quote`, `accept`, `deliver(artifact)` — has modes: honest, lazy, and adversarial scenarios (see docs/05) |
| Policy engine | no | — | `OK | NEEDS_HUMAN | BLOCKED` + reason codes |
| Skeptic | yes | none | flags with codes + quotes |
| Verifier | yes | none | per-criterion `met | not_met | unverifiable` + evidence quote |
| Settlement engine | no | PayPal writes | the only thing that moves money |

LLM wrapper: `callLLM({role, system, user, schema})` — Zod-validated JSON, bounded retries, timeout, ledger event with prompt hash + redacted output.

## 4.2 Typed intents (Buyer)
```ts
type BuyerIntent =
 | {kind:'propose', taskType, description, criteria: Criterion[], price: string, deadline: string}
 | {kind:'counter', price?: string, criteriaChanges?: ...}
 | {kind:'accept'} | {kind:'walk_away', reason: string};
```
Intents are validated by the policy engine; price strings are Decimal-parsed.

## 4.3 Policy engine checks (all deterministic)
1. Mandate signature valid; not expired; not revoked.
2. Currency USD and equals mandate currency.
3. `price <= perDealMax`.
4. `committed + price <= budgetTotal` where committed = captured + authorized-but-unsettled across deals.
5. `taskType` in allowed list; seller in allowlist.
6. Weights sum to 100; at least one required criterion; deterministic criteria have known validators.
7. `termsHash` recomputed and equal to locked hash (drift check).
8. `price > requireHumanAbove` => `NEEDS_HUMAN`.
9. Negotiation rounds ≤ `MAX_NEGOTIATION_ROUNDS`.

## 4.4 Skeptic scan
Pre-scan (deterministic, before any LLM): zero-width/Unicode tag characters, bidi controls, base64-looking blobs > N chars, HTML/markdown comments, text addressed to "verifier/reviewer/judge/system/assistant". Then the Skeptic LLM classifies the transcript and delivery with fixed codes:
`INSTR_OVERRIDE, VERIFIER_TAMPER, EXFIL_REQUEST, AUTHORITY_SPOOF, URGENCY_PRESSURE, TERMS_DRIFT, HIDDEN_TEXT, ENCODED_PAYLOAD, EMPTY_OR_PLACEHOLDER`. Each flag: `{code, severity: LOW|MED|HIGH, quote}`; quote must exist in source (quote validation).

## 4.5 Verification pipeline
1. **Deterministic validators** per criterion (pure functions). Examples for `data_cleaning`: `csv_schema_matches`, `row_count_range`, `no_duplicate_rows`, `null_rate_below`, `no_forbidden_values`, `column_values_in_set`.
2. **Pre-scan + Skeptic** on the delivery.
3. **Verifier LLM** judges only `llm_judged` criteria; run `VERIFIER_PASSES` (default 2) independent passes with shuffled criteria order. Each result needs a verbatim evidence quote; invalid quote => `unverifiable`. Pass disagreement => `unverifiable`.
4. Result: `CriterionResult[] = {criterionId, status, source: 'deterministic'|'verifier', evidence}`.

## 4.6 Settlement engine (pure function, exhaustively unit-tested)
**Principle:** an LLM-only signal can never cost the seller money or release money. Money-affecting decisions come from deterministic evidence. LLM flags can only escalate to a human.

Inputs: locked terms, criteria results (each tagged `deterministic` or `verifier`), skeptic/prescan flags (each tagged `deterministic` or `llm`), deal state, authorization status, mandate `injectionPolicy` (`HUMAN_REVIEW` default | `BLOCK`).
```
if state invalid or authorization not AUTHORIZED                 -> NEEDS_HUMAN
if a required DETERMINISTIC criterion is not_met                  -> VOID   (contract failed; reason codes logged)
if a required criterion is unverifiable (incl. verifier disagree)  -> NEEDS_HUMAN
if a required LLM-judged criterion is not_met by both passes AND
   evidence quote validated                                       -> NEEDS_HUMAN   (LLM-only fail never auto-voids)
if any deterministic severe manipulation (prescan: hidden text,
   encoded payload, verifier-addressed text)                      -> NEEDS_HUMAN (or BLOCK per injectionPolicy)
if any LLM-only HIGH flag                                         -> NEEDS_HUMAN
earned = sum(weight of met criteria)                              // 0..100
if earned == 100 and no unresolved flags                          -> CAPTURE full price
else if earned >= MIN_PARTIAL (default 50) and all required met   -> CAPTURE price * earned / 100 (Decimal, round down)
else if earned < MIN_PARTIAL via deterministic failures           -> VOID
else                                                              -> NEEDS_HUMAN
amount hard-capped at locked price and at authorized amount
```
After deciding, the engine writes a `PayPalOperation` (docs/03 §3.10b), calls PayPal, GETs the resource fresh, and only then transitions state: `COMPLETED` -> `CAPTURED`/`PARTIALLY_CAPTURED`; `PENDING` -> `SETTLEMENT_PENDING` (resolved by webhook + fresh GET); `DECLINED` -> `NEEDS_HUMAN` with authorization intact. Settlement is guarded by a unique `(dealId)` Settlement row plus the operation table, so replays and crashes cannot double-capture.

**Why the demo attack is built this way:** the attacker delivery contains an injection **and** objectively fails a required CSV validator. It voids because it failed the contract, not because an LLM disliked it. If the delivery were valid but contained an injection, the outcome is `NEEDS_HUMAN` with a clear warning.

Tune thresholds with the attack suite; record the chosen values in the README.

## 4.7 Evidence quotes
`normalize(s) = s.replace(/\s+/g,' ').trim().toLowerCase()`; accept a quote only if `normalize(source).includes(normalize(quote))` and quote length ≥ 8 chars.

## 4.8 Prompt rules
- System prompts never include counterparty text.
- Counterparty text is wrapped in `<untrusted_*>` delimiters and described as data.
- Verifier prompt includes only locked criteria + delivery; it is told to ignore any instructions in the delivery and to flag them rather than obey.
- All outputs strict JSON per Zod schema; no free-text decisions.
