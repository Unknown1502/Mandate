# 7. Roadmap and Gates

Build in gated phases. Do not start a phase until the previous exit gate passes.

## Phase 0 — Repo
Next.js + TS, Prisma 6 + Postgres (`npx prisma validate` passes), Zod env validation, authenticated principal (session + CSRF), lint/typecheck/test scripts, MIT license visible, `.env.example`. **Gate:** app boots, migration runs, `/api/health` OK, no secrets in Git.

## Phase 1 — PayPal spike (highest risk, do first)
**First action: check that partial capture is enabled for the sandbox merchant account; if not, enable it or fall back to full-or-void.** Then run docs/03 §3.12. Save real responses to `docs/sandbox-observations.md`. **Gate:** one real full capture, one real partial capture (remainder released), one real void, idempotent repeat captured, all with real IDs. **If partial capture or void behaves differently than documented, adapt the design here — before building anything else.**

## Phase 2 — Core domain
Mandate approval flow, budget reservation, PayPalOperation tracking + reconciler, money utils (Decimal), canonical JSON, Ed25519 mandate signing, terms + hash, state machine table, policy engine, hash-chain ledger + verify. **Gate:** unit tests for every policy check, every illegal transition, ledger tamper detection.

## Phase 3 — Agents
LLM adapter, Buyer/Seller/Skeptic/Verifier, pre-scan, quote validation, negotiation loop (≤4 rounds). **Gate:** honest negotiation completes and locks terms; schema-invalid LLM outputs are rejected; quote validation unit-tested.

## Phase 4 — Delivery + settlement
Deterministic validators for `data_cleaning`, verification pipeline, settlement function with exhaustive tests, real PayPal settlement wiring, sweeper. **Gate:** end-to-end sandbox: full capture, partial capture, void; replays cannot double-capture.

## Phase 5 — Attack Lab
Implement cases, harness, metrics, report page. **Gate:** report generated from real runs; fix discovered failures; rerun; keep before/after.

## Phase 6 — Dashboard
Timeline, verification table, ledger view, mandate screen, approval screen. **Gate:** whole demo script executable by a stranger from the UI.

## Phase 7 — Webhooks, deploy, release
Webhook route with signature verification + dedupe + fresh GET; deploy to Render (+ Postgres); README judge quickstart; test from a fresh browser; record video; submit.

## Cut order if time compresses
Keep: Phase 1 truth, policy+settlement correctness, one task type, void-on-attack demo, ledger verify, measured attack report.
Cut first: second task type → reauthorize → MCP server export → AG Grid → fancy animations → extra attack cases beyond ~20.
Never cut: invariants in AGENTS.md, webhook signature verification, quote validation, idempotency.

## Known unknowns to resolve early
1. Exact order-approval link `rel` and experience_context fields in sandbox.
2. What happens to the unused authorization after a partial capture with `final_capture: true`.
3. Void response code/status in sandbox.
4. Which webhook event names fire for your flow.
5. Whether sandbox authorization behavior matches production honor-period semantics (it may not; do not claim it does).
6. LLM latency per deal (keep total verification < ~20 s for the demo; use 2 verifier passes in parallel).

## Revision log
- v2 (5 Nov 2026): applied external-review fixes — LLM-only flags escalate to NEEDS_HUMAN (never auto-void), PayPalOperation crash-safe writes, SETTLEMENT_PENDING, budget reservation, human-approved/application-signed mandates, auth + CSRF, webhook events (DECLINED + DENIED), partial-capture enablement check, expanded metrics, schema rewritten (one enum value per line; **`prisma validate` NOT run — the build sandbox could not download Prisma engines; run it first in Phase 0**).
