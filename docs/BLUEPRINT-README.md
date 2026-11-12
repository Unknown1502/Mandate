# MANDATE — Implementation Blueprint

**Tagline:** Money moves only when the work is verified.

Mandate is conditional settlement for agent-to-agent commerce on PayPal. A human signs a **mandate** (budget + rules). A buyer agent negotiates with a seller agent. Terms are locked, PayPal **authorizes** (reserves) the funds, the seller delivers, an adversarial verification pipeline checks the delivery, and deterministic code decides: **capture**, **partial capture**, or **void**. Every step lands in a hash-chained audit ledger.

> **Core rule:** LLMs propose, read, and judge. Deterministic code decides. PayPal moves the money. The human stays the authority.

## The flow

1. Human signs a mandate (budget, task types, counterparties, expiry).
2. Buyer agent ⇄ Seller agent negotiate; terms (price, acceptance criteria, deadline) are locked under a `termsHash`.
3. Policy engine + Skeptic agent check the deal. Outcome: `OK`, `NEEDS_HUMAN`, or `BLOCKED`.
4. App creates a PayPal order with `intent: AUTHORIZE`; the human approves it in PayPal (sandbox personal account). Funds are reserved, not moved.
5. Seller agent delivers an artifact.
6. Verification: deterministic validators + Skeptic scan + Verifier agent (2 passes, quote-validated).
7. Settlement engine computes the amount **in code** and calls PayPal: capture / partial capture (`final_capture: true`) / void.
8. Ledger records everything; `/api/ledger/verify` re-computes the hash chain.

## Technology decisions

| Layer | Choice | Why |
|---|---|---|
| App | Next.js App Router + TypeScript | One deployable full-stack app |
| UI | Tailwind + shadcn/ui | Fast, consistent |
| Validation | Zod | Every untrusted boundary (LLM output, HTTP, PayPal responses) |
| DB | PostgreSQL + Prisma | Ledger, deals, webhooks |
| Money | decimal.js | Never floats |
| LLM | Provider adapter (default Anthropic; model id from env) | Swappable, server-side only |
| PayPal writes | Direct REST via server-side `fetch` | Authorize/capture/void are not exposed as dedicated Agent Toolkit tools (see docs/03) |
| PayPal reads/tools | `@paypal/agent-toolkit` (get_order, list_disputes, list_transactions) | Legitimate Agent Toolkit usage for agents' read tools |
| Tests | Vitest | Rules engine + attack harness |
| Hosting | Render Web Service + Render Postgres | Public HTTPS webhook endpoint |

Do **not** add Redis, a vector DB, an agent framework, or a message broker. Use a DB-backed job table and in-process orchestration.

## Read in this order

1. `AGENTS.md` — non-negotiable invariants for the coding agent
2. `docs/01-product.md`
3. `docs/02-architecture.md` — state machine, trust boundaries, file layout
4. `docs/03-paypal-contract.md`
5. `docs/04-agents-and-settlement.md`
6. `docs/05-attack-suite.md`
7. `docs/06-ui-and-demo.md`
8. `docs/07-roadmap.md`
9. `docs/08-judge-readiness.md`
10. `docs/SOURCES.md`
11. `prompts/` — copy-ready coding-agent prompts

## First run

1. Create PayPal Developer app (Sandbox). Create **US** Sandbox Business + Personal accounts (see docs/03 §1).
2. Copy `.env.example` → `.env.local`, fill values.
3. Let the coding agent create `package.json` with pinned versions + lockfile.
4. Run `prompts/01-paypal-spike.md` **before anything else**.

## Honest limitations (put these in your README and video)

- Sandbox only. PayPal does not know about the mandate; Mandate enforces policy in the app layer and uses PayPal's authorize/capture/void as the money primitive.
- It is **not escrow** and gives no legal protection. Say "authorization-based conditional settlement".
- Buyer approval of each PayPal order is a human step. Agents negotiate and verify; the human approves the reservation in PayPal.
- Capture success is "subject to risk and availability of funds" per PayPal. The honor period is 3 days; authorization lasts 29 days.
- The seller agent is a **simulated counterparty** for testing. Label it as such everywhere.
- Single sandbox merchant account receives funds (no marketplace/partner payee routing). Position it as: "a prototype of authorization-based conditional settlement for agent-mediated work". Do not claim two independent merchants settle with each other.
- Mandates are **human-approved and application-signed** (not user-key-signed).

## Definition of done

Against real Sandbox + real LLM calls: (1) honest deal → full capture, (2) injected delivery → void, (3) partial delivery → partial capture with code-computed amount, (4) price drift after lock → blocked before authorization, (5) ledger verify passes and detects tampering, (6) attack suite reports measured numbers, (7) hosted app + webhook verified, (8) public repo + MIT license + <3 min video.
