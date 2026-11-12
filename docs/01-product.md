# 1. Product

## Statement
**Mandate lets AI agents buy work from other AI agents without trusting them.** Money is only reserved until a verification pipeline and deterministic rules decide what the delivery earned.

## Problem
Agent commerce has a trust gap: a buyer agent can be talked into overpaying, a seller agent can deliver junk or hide instructions in its output, and "pay" is usually irreversible. PayPal's authorize/capture/void gives a natural primitive: reserve first, settle later. Nothing connects that primitive to *verified delivery* and *human-signed limits*. Mandate does.

## Users
- **Principal:** a person/business letting its agent buy small services within limits.
- **Judge:** wants real PayPal calls, real agent behavior, and an attack that fails.

## P0 task types (build one first, add the second if time)
1. `data_cleaning` — seller cleans a CSV. **Mostly deterministic checks** (schema, duplicate count, null rate, row count, forbidden values). Strongest demo: verification does not rely on an LLM.
2. `brief_writing` — seller writes a short brief from provided sources. Mix of deterministic (word count, required sections, cites only provided source IDs) and LLM-judged criteria (accurate to sources, covers required points).

## Mandate
Fields: `id`, `principal`, `currency` (USD only), `budgetTotal`, `perDealMax`, `allowedTaskTypes[]`, `counterpartyAllowlist[]`, `requireHumanAbove`, `expiresAt`, `revokedAt`, `approvedBy`, `approvedAt`, `approvalMethod`, `mandateDigest`, `keyVersion`, `injectionPolicy` (`HUMAN_REVIEW`|`BLOCK`), and `signature` (application Ed25519 seal over the human-approved mandate — "human-approved, application-signed"; tamper-evident, not a PKI claim).

## Criteria
`id`, `text`, `type: deterministic | llm_judged`, `required: boolean`, `weight` (integers summing to 100), and for deterministic: `validator` + `params`.

## Outcomes
`CAPTURED`, `PARTIALLY_CAPTURED`, `VOIDED`, `BLOCKED` (before authorization), `NEEDS_HUMAN`, `EXPIRED`, `FAILED`.

## Promise / non-promise
Promise: funds are only reserved until verified delivery; the settlement amount is computed by code from checked criteria; every decision is auditable.
Not promised: perfect attack detection, legal escrow, guaranteed capture (PayPal: capture success is subject to risk and fund availability), production readiness.

## Out of scope
Live money, marketplace payee splits, approval-free autonomous payment, dispute creation via API (buyers open disputes; see docs/03 §3.8), crypto/smart contracts.
