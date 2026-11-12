# 11. Agents and Negotiation (Gate 3)

Evidence level of everything below: **unit-tested / DB-tested / process-tested**, with **scripted or rule-based** agents.
**No real LLM has been run** (no API key was available). `AnthropicProvider` is written to the public API shape and has never executed.

## Components and trust
| Component | Where | Can touch | Cannot touch |
|---|---|---|---|
| Buyer Agent | `src/agents/buyer.ts` (+ `llm.ts`) | a frozen `BuyerContext` (task text, private target/ceiling, round, sanitized history, canary) | database, mandate, PayPal, settlement, signing, sessions, env, other agents' prompts |
| Seller Agent (simulated, rule-based, NOT an LLM, NOT an independent merchant) | `seller-service/` (separate OS process) | the shared wire contracts only | everything else; sees no sensitive env var names |
| Orchestrator | `src/domain/negotiation.ts` | database, sealed-mandate snapshot, lock terms | PayPal / settlement engine (not imported) |

* Agents emit **typed intents** only (Zod `.strict()`); there is no tool-calling parameter anywhere in `llm.ts`.
* Counterparty text enters a prompt only through `sanitizeUntrusted` (strips zero-width/bidi/tag/control characters, neutralises angle brackets, truncates) and `wrapUntrusted` (`<untrusted_seller_message id="m#">`). It never appears in a system prompt.
* The principal's brief authors the criteria, deadline and target price. Neither agent can change them; the seller contract has no field for them.

## Protocol (max `MAX_NEGOTIATION_ROUNDS` = 4 rounds)
Round 1 the buyer must `propose`; later rounds `counter` | `accept` | `walk_away`. Seller answers `accept` | `counter{price}` | `decline`.
The agreed price is the buyer's last price when the seller accepts, or the seller's last quote when the buyer accepts. Then `lockTerms` hashes the terms
(`termsHash`) and the deal is `TERMS_LOCKED`; `checkPolicy` runs afterwards as before. No agreement within the limit, a walk-away, a decline,
a protocol violation or any rejected intent ends in `BLOCKED` with a ledgered reason.

## Deterministic gates between the model and the system of record
1. `validateBuyerIntent`: opening must be `propose`; `propose` only in round 1; price must be a valid positive decimal **at or below the ceiling**; `counter` may not exceed the seller's ask; `accept` needs a prior quote that is at or below the ceiling.
   The ceiling = min(`perDealMax`, remaining budget, `requireHumanAbove`), computed by the orchestrator from the **signed** mandate; it is not a prompt instruction.
2. `checkOutbound` on the buyer's free text: protected values (budget, per-deal max, threshold, remaining budget, ceiling, target, ids, principal email, the prompt canary) and secret patterns. A violating message is **dropped** (price still sent) and ledgered without the leaked text.
3. Seller replies must satisfy the strict contract. A smuggled `criteria`, `amount`, deadline or "approved" flag is a **protocol violation → BLOCKED**, not an ignored extra field.
4. After the lock, `detectTermsDrift` compares any restated price / deadline / criteria with the locked terms. While the deal can still be blocked (before an order exists) it is **BLOCKED** and any reservation released; afterwards the attempt is ledgered and the **locked terms govern**.
5. The mandate is never given to an agent; the orchestrator works from a deep-frozen snapshot, and the buyer's context object is deep-frozen (mutation throws).

## Not covered / UNVERIFIED
* Real LLM behaviour of any kind (buyer or seller). Injection tests use a buyer **scripted to obey the attacker**; they show the deterministic gates hold, not that a model resists.
* The outbound guard is pattern-based: a paraphrase ("a hundred dollars") of a protected number is not caught. The buyer's system prompt contains its own ceiling, so a real model could leak it in words; the guard reduces but does not eliminate this.
* The seller's attack set is 6 fixed payloads plus a tamper mode. The measured Attack Lab is Gate 5.
* Process isolation is **environment and import isolation on one machine under one OS user**, not a sandbox: the seller process could still read files the OS user can read.
* The seller HTTP endpoint is unauthenticated on loopback.
* Deadline negotiation is not supported. Agent runs are recorded (`AgentRun`) only for LLM brains.
* Drift detection runs when called; wiring it to deliveries is Gate 4.
