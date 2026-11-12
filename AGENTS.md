# Instructions for AI Coding Agents — MANDATE

Read all of `/docs` before architectural changes.

## Non-negotiable invariants

1. **LLMs never move money and never output money amounts that are used.** Capture amount is computed by the settlement engine from criteria results using Decimal math.
2. **Only the Settlement Engine module may call PayPal write endpoints** (create order, authorize, capture, void, reauthorize). Agents emit typed intents; the engine validates them against state machine + mandate.
3. All counterparty content (negotiation messages, deliveries) is **untrusted data**. Wrap in explicit delimiters, never place it in a system prompt, never let it set state.
4. Skeptic and Verifier agents have **no tools**. Buyer agent has only typed intent outputs.
5. Terms are locked with a `termsHash` before the PayPal order exists. Any later change to price/criteria/deadline → `BLOCKED`.
6. Never exceed: agreed price, mandate per-deal max, mandate remaining budget (authorized-but-uncaptured counts as committed).
7. Every state transition and every PayPal/LLM call appends a ledger event (hash-chained). No silent transitions.
8. Webhooks: signature-verified, deduplicated by event id, reconciled with a fresh GET before changing state. Mock simulator events are for route testing only.
9. Idempotency: every PayPal write sends `PayPal-Request-Id`; every settlement is guarded by a DB unique constraint per deal.
10. Never expose PayPal secret, access tokens, LLM keys to browser/logs/Git. No `NEXT_PUBLIC_` secrets.
11. Money is decimal strings/`Decimal`. No JS floats. Demo currency: USD only.
12. Never invent PayPal fields/enums/behaviors. Verify against official docs and **captured sandbox responses** (store them in `docs/sandbox-observations.md`).
13. Do not weaken tests to pass. Do not claim completion without real run output.
14. Quote validation: any LLM-claimed evidence quote must be found verbatim (after whitespace normalization) in the source; otherwise the claim is downgraded to `unverifiable`.
15. Report only measured numbers (attack block rate etc.). Never hardcode or estimate them.

16. An LLM-only signal (Skeptic flag, Verifier fail) may escalate to `NEEDS_HUMAN` but never triggers VOID or CAPTURE by itself.
17. Every PayPal write is preceded by a persisted `PayPalOperation` with a stable request id; on timeout, GET the resource before any retry; never blind-retry a capture.
18. Atomically reserve budget before creating a PayPal order; allocate ledger `seq` inside a locked transaction.
19. All state-changing routes require an authenticated principal + CSRF protection; mandates are human-approved (explicit confirmation) and application-signed. Do not claim user-held-key signing.
20. A capture that returns PENDING is `SETTLEMENT_PENDING`, not captured. Only a fresh GET showing COMPLETED counts.
21. Run `npx prisma validate` after any schema change.

## Discipline

- One vertical slice at a time; inspect repo before editing; small typed modules.
- Zod at: HTTP input, LLM output, PayPal response normalization.
- After each phase: lint, typecheck, tests; report files changed, commands, actual test counts, sandbox calls + real statuses, limitations, next phase.
- Log PayPal debug ids/request ids/duration; never log auth headers or full artifacts.

## Scope

P0: mandate, negotiation (≤4 rounds), terms lock, policy engine, PayPal authorize/capture/partial/void, delivery verification (deterministic + LLM), ledger + verify, attack lab with measured results, timeline dashboard, webhook verification, deploy.
P1: reauthorize flow, MCP server exposing Mandate, dispute-evidence export, second task type.
Out of scope: live PayPal, multi-merchant payee routing, real-money anything, autonomous approval without human PayPal approval, legal/escrow claims.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
