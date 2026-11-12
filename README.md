# MANDATE

**Buyer-authorized AI commerce with negotiated terms, verifiable delivery and conditional PayPal settlement.**

> Hackathon build for the PayPal AI Hackathon 2026. **PayPal Sandbox only: no real money.** Production is not enabled and is a documented NO-GO. Demo video: *(link to be added after upload)*.

![A real PayPal Sandbox deal, captured: order, authorization and capture ids, and why it was paid](docs/submission/screenshots/11-real-sandbox-capture-completed-full.png)

## The problem

AI agents can now negotiate and buy services. Giving them an open wallet is dangerous: they can overpay, be talked into paying for work that was never done, or be steered by hostile text hidden inside a deliverable. Most "AI payments" stop at a spending limit.

**Who it is for first:** small businesses that outsource structured digital services (for example data cleaning) to independent providers and want to delegate the procurement step to an AI agent **without** giving that agent unrestricted financial authority. This is the initial use case the demo covers; it is not a claim that MANDATE supports every service market today.

## The solution

MANDATE connects an **AI-negotiated service agreement** to **evidence-backed delivery verification** and **conditional PayPal settlement**.

| Ordinary agentic commerce | MANDATE |
|---|---|
| find, negotiate, buy | the buyer defines authority (a signed mandate) |
| | agents negotiate **within deterministic limits** |
| | the agreed terms are **locked** before payment authority advances |
| | the seller delivers **evidence** |
| | evidence is checked **against the negotiated criteria** |
| | settlement follows a **deterministic decision** |
| | PayPal executes the permitted authorization and capture |

Design principle: **humans define authority, AI proposes and negotiates, deterministic software validates authority and price, evidence substantiates delivery, the human keeps decision rights, PayPal executes.** MANDATE is not escrow, and its delivery verifier is not an AI.

## Key features

* **Signed buyer authority:** an Ed25519-sealed mandate (budget, per-deal cap, "ask me above" threshold, allowed sellers, expiry), re-checked at every step.
* **AI-assisted price negotiation inside limits:** an optional Groq buyer agent with no tools, no database access and no payment authority; every offer is re-validated by code.
* **Agreement-bound delivery verification:** deterministic validators check a delivered CSV against criteria locked into the agreement; a scanner flags hidden instructions in the data.
* **Conditional settlement policy:** a challenge window, a computed (never user-supplied) amount, and a decision the dashboard explains.
* **PayPal Sandbox integration:** Orders v2 and Payments v2 authorization, capture and void through the official PayPal Server SDK; mock mode by default.
* **Audit evidence and dashboard:** a hash-chained ledger, status chips that label mock versus Sandbox, and a reconciliation step for unknown PayPal outcomes.

## How this differs

Designs that put an AI model in the "was the work good?" seat can be talked into an answer by the very text they are judging. MANDATE keeps the AI where it is useful (negotiating a price inside limits it cannot override) and takes it **out of the decision that moves money**: the delivery is checked by deterministic code against criteria the human locked into the agreement, and the engine computes the amount.

| | AI shopping assistant | Payment guard (spend limit, approval step) | MANDATE |
|---|---|---|---|
| Limits what the agent can spend | sometimes | yes | yes (signed mandate, per-deal cap, "ask me above") |
| Fixes what "done" means before paying | no | no | yes (criteria locked by hash into the terms) |
| Checks the delivery against that agreement | no | no | yes, by deterministic code, not a model |
| Hostile text inside the deliverable | not applicable | not applicable | scanned; a flagged delivery stops for a human |
| Pays only on evidence, and shows why | no | a log | yes: decision, basis and a hash-chained audit trail |

Related work: Google's **Agent Payments Protocol (AP2)** uses signed "mandates" to prove what a user authorised an agent to *buy*. MANDATE uses the word for a similar idea but is a separate project and **does not implement or claim compatibility with AP2**; it addresses the step after the purchase is authorised: whether the agreed work was delivered and who decides to pay. The limits of this approach: deterministic verification suits structured deliverables (a CSV against a schema, duplicate rows, date formats), not subjective ones.

## How the workflow runs

1. **Mandate.** The human signs a mandate: budget, per-deal cap, "ask me above" threshold, allowed sellers, expiry (Ed25519 seal, re-checked at every step).
2. **Negotiation.** The Buyer Agent (a live Groq model, or a deterministic rule-based brain) negotiates the **price only** against a Seller Agent. Every offer is validated by code (below). Agreement locks the terms: task, price and acceptance criteria.
3. **PayPal order and approval.** The server creates a PayPal Orders v2 order with `intent: AUTHORIZE`, bound to the deal id and locked price. The buyer approves on PayPal. The app learns the result by *reading the order from PayPal*, never from a redirect.
4. **Authorization.** The server authorizes the order: a **hold** on the buyer's funds. Not a payment, not escrow.
5. **Delivery.** The seller submits a deliverable (a CSV plus a manifest bound to the locked terms).
6. **Verification.** Deterministic validators check each criterion (schema, duplicates, dates); a scanner flags instructions hidden in the data. A failed required criterion means no payment; a flagged or unverifiable delivery stops for a human.
7. **Challenge window.** The buyer may accept early, request review of one criterion (re-verified against the *original* locked terms), or do nothing, in which case the engine settles when the window ends. Settling on expiry is **not** recorded as an acceptance, and the dashboard says so.
8. **Settlement.** The engine computes the amount in code from the locked terms and the verification result, then captures exactly that amount against the stored authorization (or voids it). Unknown PayPal outcomes are reconciled by reading PayPal.
9. **Audit.** Everything lands in a hash-chained ledger the buyer can read in the dashboard.

## What is real, and what is simulated (read this first)

The dashboard shows the same labels at the top of every screen.

| Capability | Status | Evidence |
|---|---|---|
| Authenticated buyer boundary, signed mandates, settlement engine, audit ledger | **Real code, real PostgreSQL** | unit and PostgreSQL suites |
| **Real PayPal Sandbox payment** | **Done once, end to end**: order, buyer approval, authorization, verified delivery, one capture of **20.00 USD**, `COMPLETED`, reconciled | `docs/submission/PAYPAL-EVIDENCE.md`, `docs/qa/paypal-e2e-stage*.json` |
| **Real Groq negotiation** (`openai/gpt-oss-20b`) | **Done**: 7 real requests across 3 runs on a throwaway database with mock PayPal | `docs/submission/GROQ-EVIDENCE.md`, `docs/qa/live-groq/`, `docs/qa/negotiation-m4/` |
| Latest negotiation prompt | **Validated offline only** (fake SDK); not yet run against the real model | `GROQ-EVIDENCE.md` |
| Delivery verification | **Deterministic validators**, no model (V1 deals never call one) | UI "Verification" chip |
| Seller | **Local simulator** on loopback with synthetic data, not an external merchant | UI "Seller" chip |
| Webhooks, production deployment | **Not built** | n/a |
| V2 contract format (model-judged criteria) | **Disabled** | UI "V2: Disabled" |

**Two separate verified runs.** The real Groq negotiation and the real PayPal capture were **different transactions**. The PayPal deal was negotiated by the rule-based buyer; the Groq runs used mock PayPal. They are not edited together. For the captured transaction the buyer's challenge window expired without a challenge, so settlement followed the expired-window rule: **no explicit buyer acceptance event was recorded**, and the dashboard states that.

## Real Groq integration

The Buyer Agent can be `openai/gpt-oss-20b` on Groq, called server-side through the official `groq-sdk`. It has **no tools, no database access and no payment authority**. It returns one typed intent per turn; the orchestrator re-validates it. A provider failure blocks that negotiation with the reason: there is **no silent fallback** to the rule-based buyer, and the UI shows the exact provider and model and lists every recorded model call. Gemini (`@google/genai`) is an alternative provider in the code; only one vendor is used per run, selected by `LLM_PROVIDER`, and the other vendor's key never substitutes.

## PayPal Developer Platform integration

* **Orders v2** (`intent: AUTHORIZE`) and **Payments v2** (authorization read, capture, void) through the official **PayPal Server SDK** (`@paypal/paypal-server-sdk` 2.5.0), imported only by `src/paypal/sdk-gateway.ts`.
* A **PayPal JavaScript SDK v6** checkout button is implemented (`src/app/ui/paypal-checkout.tsx`) and tested against fakes. The real Sandbox transaction used PayPal's hosted approval page for the order instead (the button's callback triggers authorization, which needed its own approval step).
* Every write carries a stable `PayPal-Request-Id`, is recorded locally *before* it is sent, and an unknown outcome is resolved by a GET. A database rule allows at most one live capture or void per deal. Sandbox writes stay refused unless the operator sets `PAYPAL_SANDBOX_WRITES=authorized`.
* **Authorization versus capture.** An order is not an authorization; an authorization is a hold, not a payment; only a recorded capture is a payment. Capture is impossible before eligible delivery verification. **Honor period:** PayPal documents a 29-day authorization period but recommends capturing within a 3-day honor period; later capture is subject to PayPal's risk and funds checks and normally needs a reauthorization. MANDATE does **not** implement reauthorization: an authorization that has expired sends the deal to a human with nothing sent. The demo's challenge window is minutes, well inside the honor period.

## Deterministic negotiation policy

Implemented in `src/domain/negotiation-policy.ts` and enforced on every offer, whatever the model says: the **opening may not exceed the buyer's target**; a **counter needs a seller price first**, may **not retreat** from the buyer's own last offer, may move **at most half the remaining gap per round**, and may **never exceed the mandate ceiling**; at most 4 rounds. Violations fail closed (the deal is blocked, nothing is paid). The model's free-text message is checked before it reaches the seller: a message that contains the mandate ceiling, the buyer's target, other protected values or a secret-looking pattern is dropped (an `OUTBOUND_MESSAGE_BLOCKED` event is recorded without the text) and the negotiation continues with the typed price only; the seller never receives the buyer's confidential limits. If the seller's floor is above what the policy allows, the negotiation ends without a deal and nothing is locked.

## Seller simulator

The seller is a **local simulator** (`npm run seller`, a separate process on a fixed loopback URL) with synthetic data. It is not an external merchant and not an operating-system sandbox: it has no database, no PayPal access and no mandate, and it cannot approve or pay. `SELLER_MODE` selects `honest`, `haggler` (a private price floor of 22.00, above the 20.00 target, for a multi-round negotiation), `greedy`, `adversarial` or `tamper`. Its "duplicate rows" and "hidden instruction" deliveries demonstrate a release of the hold and a stop for a human.

## Delivery evidence verification

The deliverable is checked by deterministic code against the criteria locked into the agreement. Required criteria must all pass for a full capture; results, flags and "unverifiable" criteria are shown honestly. Text inside the data is treated as hostile: a scanner flags instruction-like content, and flagged deliveries wait for a human who may only give verdicts on criteria the machines could not resolve. There is no unrestricted "reject": the criteria decide.

## Architecture

```mermaid
flowchart TD
    H["Human Buyer"]
    M["Ed25519-Signed Mandate"]
    A["Buyer Agent<br/>(Groq model or rule-based)"]
    G["Groq AI Negotiation<br/>(optional)"]
    L["Locked Service Agreement"]
    PA["Buyer-Approved PayPal Authorization<br/>(a hold, not a payment)"]
    S["Seller Simulator"]
    D["Submitted CSV Deliverable"]
    V["Deterministic Delivery Validators"]
    C["Challenge Window and Settlement Policy"]
    R["Failed Verification, Human Review or Void<br/>(no payment)"]
    P["PayPal Capture<br/>(amount computed in code)"]
    E["Audit Events and Reconciliation"]

    H --> M
    M --> A
    A --> G
    G -->|"Price negotiation within authority<br/>(every offer re-validated by code)"| L
    L --> PA
    PA --> S
    S --> D
    D --> V

    V -->|"Verification passes"| C
    V -->|"Verification fails or delivery is flagged"| R

    C -->|"Settlement permitted by policy"| P
    C -->|"Review or no settlement"| R

    P --> E
    R --> E
```

MANDATE separates AI-assisted negotiation from deterministic authority enforcement, delivery verification and settlement policy. The seller simulator is used in the demonstration. PayPal authorization and capture are distinct payment operations, not escrow.

In the implemented flow the authorization (a hold) is created before delivery, and a capture happens only after verification passes and the settlement policy permits it. PayPal runs in the in-memory mock by default and in Sandbox mode when the operator enables it; production is not enabled.

### Component view

```mermaid
flowchart LR
  H["Buyer (human)\nsigned session"] -->|"origin + session + CSRF + ownership"| API["Next.js API routes\n(principal guard)"]
  API --> ORCH["Orchestrator\n(deterministic workflow)"]
  ORCH -->|"typed price messages only"| BA["Buyer Agent\nGroq model or rule-based\nno tools, no DB, no payment authority"]
  ORCH -->|"typed price messages, locked contract"| SA["Seller simulator\nseparate process, loopback,\nsynthetic data"]
  SA -->|"artifact + manifest"| ORCH
  ORCH --> POL["Policy engine\nbudget, limits, expiry,\nsigned mandate"]
  ORCH --> VER["Verification\ndeterministic validators +\nhidden-instruction scanner"]
  POL --> SET["Settlement engine\ncomputes the amount in code"]
  VER --> SET
  SET -->|"authorize / capture / void"| PP["PayPal\nMock (default) or Sandbox"]
  ORCH --> DB[("PostgreSQL\nsigned mandates, hash-chained ledger")]
  SET --> DB
```

Trust and security boundaries are described in [docs/ARCHITECTURE-DEMO.md](docs/ARCHITECTURE-DEMO.md): who decides what, what each boundary checks, and the honest limits.

## Demo Evidence and Execution Boundaries

```mermaid
flowchart TB
    subgraph Interactive["Interactive Walkthrough"]
        UI["MANDATE Dashboard"]
        MOCK["In-memory Mock PayPal"]
        BUYER["Rule-Based Buyer"]
        SYN["Synthetic Demo Data"]

        UI --> MOCK
        UI --> BUYER
        UI --> SYN
    end

    subgraph AI["Separate Stored AI Run"]
        GROQ["Groq Negotiation"]
        RESULT["Closed at $25.00 against $20.00 target"]
        GROQ --> RESULT
    end

    subgraph PAYMENT["Separate PayPal Sandbox Transaction"]
        ORDER["Sandbox Order"]
        AUTH["Payment Authorization"]
        CAPTURE["Completed $20.00 Capture"]
        EXPIRED["Expired-window settlement rule"]

        ORDER --> AUTH
        AUTH --> CAPTURE
        CAPTURE --> EXPIRED
    end
```

> **These are separate evidence sequences, not one continuous live transaction.** The interactive walkthrough uses mock PayPal and a rule-based buyer. The Groq negotiation is a separate recorded execution. The $20 PayPal Sandbox capture is another separate transaction. The challenge window expired unused, and no explicit buyer acceptance event was recorded.

Sources: the Groq run is documented in [docs/submission/GROQ-EVIDENCE.md](docs/submission/GROQ-EVIDENCE.md) (live negotiation 1: 25.00 proposed against a 20.00 target and accepted by the simulated seller); the Sandbox transaction is documented in [docs/submission/PAYPAL-EVIDENCE.md](docs/submission/PAYPAL-EVIDENCE.md).

## Screenshots

Full index with descriptions and mock-versus-real labels: [docs/submission/screenshots/INDEX.md](docs/submission/screenshots/INDEX.md).

| Real Groq negotiation (4 recorded model calls, no deal) | Real Sandbox payment (ids and basis) |
|---|---|
| ![](docs/submission/screenshots/02-negotiation-live-groq-4-rounds.png) | ![](docs/submission/screenshots/12-real-sandbox-paypal-card-ids.png) |

The two images above were captured with the dashboard layout used before 2026-11-11 (same data and decisions, earlier layout). The current dashboard, in mock mode on synthetic data, is shown in [docs/qa/ui-update-20261111/](docs/qa/ui-update-20261111/README.md).

## Technology stack

Next.js 16 (App Router) and React 19, TypeScript 5.9, PostgreSQL 16 with Prisma 6, Zod 4 at every untrusted boundary, decimal.js for money, Ed25519 mandate signing, Tailwind CSS 4, `groq-sdk` 1.6.0 (Groq) and `@google/genai` (alternative provider), `@paypal/paypal-server-sdk` 2.5.0 and the PayPal JS SDK v6 button, Vitest for unit and PostgreSQL tests, `playwright-core` (driving installed Chrome) for the browser journeys.

## Setup

### Prerequisites

* Node.js 22 or newer (`engines.node` is `>=22`) and npm.
* PostgreSQL 16: Docker is the easiest way, or any local PostgreSQL 16. The app and the tests use two separate databases.
* Optional: Google Chrome, for the scripted browser journeys (`playwright-core` drives the installed Chrome).
* Optional: a Groq API key (real negotiation) and PayPal Sandbox credentials (real Sandbox payments). Neither is needed for the default mock demo.

### Installation and database setup

```bash
# 1. dependencies, then the typed Prisma client (required before typecheck, build and tests)
npm ci
npx prisma generate

# 2. PostgreSQL (example: Docker, port 55432) and two databases: the app's and the tests'
docker run --name mandate-pg -e POSTGRES_PASSWORD=change-me -p 55432:5432 -d postgres:16-alpine
docker exec mandate-pg psql -U postgres -c "CREATE DATABASE mandate;" -c "CREATE DATABASE mandate_test;"

# 3. configuration: copy the template and fill it in (never commit .env.local)
cp .env.example .env.local
#    set DATABASE_URL / TEST_DATABASE_URL (e.g. postgresql://postgres:change-me@127.0.0.1:55432/mandate),
#    APP_URL, SESSION_SECRET (>= 32 random chars), PRINCIPAL_EMAIL, PRINCIPAL_LOGIN_SECRET
npm run gen-keys -- --write-env      # writes the Ed25519 signing keys into .env.local without printing them (replaces the template's placeholders; refuses to overwrite a real key)
#    the template's LLM_PROVIDER / GEMINI_API_KEY / LLM_MODEL_* lines are placeholders: leave them (the dashboard then says "Rule-based (AI NOT configured)")
#    or delete them for the plain "Rule-based (no AI)" label. Real model keys are optional (see below).

# 4. database migrations (both databases). The Prisma CLI reads .env, NOT .env.local, so pass each URL on the command line
#    (PowerShell: $env:DATABASE_URL="<url>"; npx prisma migrate deploy)
DATABASE_URL=<your DATABASE_URL> npx prisma migrate deploy
DATABASE_URL=<your TEST_DATABASE_URL> npx prisma migrate deploy

# 5. run: the simulated seller, then the app (mock PayPal and rule-based buyer by default)
SELLER_PORT=4010 npm run seller                    # in one terminal
# SELLER_MODE=haggler SELLER_PORT=4010 npm run seller   # multi-round: the seller's private floor (22.00) is above the 20.00 target
npm run build
SELLER_URL=http://127.0.0.1:4010 DEMO_CHALLENGE_WINDOW_SECONDS=15 npx next start -p 3000
```

Open http://localhost:3000, sign in with `PRINCIPAL_EMAIL` / `PRINCIPAL_LOGIN_SECRET`, then follow the five steps at the top: mandate, negotiation, PayPal authorization (mock: "Simulate buyer checkout"), delivery and evidence, review and settlement. `SELLER_MODE=haggler` shows a multi-round negotiation, and the seller’s "duplicate rows" and "hidden instruction" deliveries show a release of the hold and a stop for a human.

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | app database; test database (must be named `mandate_test`) |
| `APP_URL`, `NODE_ENV`, `SESSION_SECRET`, `PRINCIPAL_EMAIL`, `PRINCIPAL_LOGIN_SECRET` | the single-buyer authentication boundary |
| `MANDATE_SIGNING_PRIVATE_KEY`, `MANDATE_SIGNING_PUBLIC_KEY`, `MANDATE_SIGNING_KEY_VERSION` | Ed25519 mandate sealing (`npm run gen-keys`) |
| `PAYPAL_MODE` | `mock` (default, no network) or `sandbox` |
| `PAYPAL_ENV=sandbox`, `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | required in sandbox mode; production values are rejected |
| `PAYPAL_SANDBOX_WRITES=authorized` | opens Sandbox writes for that process only; leave unset otherwise |
| `LLM_PROVIDER` (`gemini` or `groq`), `GROQ_API_KEY` or `GEMINI_API_KEY`, `LLM_MODEL_AGENTS` | optional real model for the Buyer Agent; without them the rule-based buyer runs |
| `SELLER_URL` (or `SELLER_SERVICE_URL`), `SELLER_PORT`, `SELLER_MODE` (`honest`, `haggler`, `greedy`, `adversarial`, `tamper`), `SELLER_FLOOR` | the simulated seller |
| `DEMO_CHALLENGE_WINDOW_SECONDS` | shortens the buyer's challenge window for a live demo (0-3600; default 900) |

Keep real keys in an env file **outside** the project folder and start the app with `node --env-file=<that file> node_modules/next/dist/bin/next start`.

### Optional: real AI and real PayPal Sandbox

* **Groq:** `npm run ai:smoke -- --env-file <file>` prints the plan and stops; add `--authorize-calls` to send at most 2 synthetic requests. Then start the app with `LLM_PROVIDER=groq`, a `GROQ_API_KEY` and `LLM_MODEL_AGENTS=openai/gpt-oss-20b`.
* **PayPal Sandbox:** create a Sandbox application and a Business and a Personal test account **in the same country with USD**, put the credentials in your env file, and run with `PAYPAL_MODE=sandbox`. Every write stays locked until you set `PAYPAL_SANDBOX_WRITES=authorized`. The staged scripts under `scripts/paypal-e2e-stage*.ts` show how each real step was run under an outbound allow-list guard; read their headers before using them.

### Development commands

```bash
npm run dev          # next dev (needs .env.local, the database and the seller simulator running)
npm run seller       # the simulated seller (SELLER_PORT, SELLER_MODE)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run gen-keys -- --write-env   # Ed25519 mandate signing keys into .env.local, without printing them
```

### Production build

```bash
npm run build
SELLER_URL=http://127.0.0.1:4010 npx next start -p 3000   # `npm start` is `next start`
```

This builds and serves the demo application. A hardened production deployment is **not** provided: production PayPal values are rejected by configuration, and production is a documented NO-GO (see Limitations).

## Tests

```bash
npm run typecheck && npm run lint && npm run build
npm test                # unit tests
npm run test:db         # PostgreSQL integration tests (mandate_test database only)
node scripts/e2e-mock-journey.mjs --out <dir>   # full browser journey on a disposable database (needs Chrome and Docker)
```

The last full runs (unit, PostgreSQL, browser journey, clean-checkout reproduction) are recorded in the final rows of [docs/DEMO-CHANGELOG.md](docs/DEMO-CHANGELOG.md). Earlier QA (mutation checks, an attack lab with 121 scripted scenarios) is under `docs/qa/` and `attack-lab/`; those numbers are mock-PayPal and scripted-AI results and are not Sandbox or real-model results.

## Security considerations

* **Authenticated boundary:** HttpOnly signed session cookie, same-origin check, a CSRF token on every mutation, per-principal rate limiting, and strict request schemas. A foreign deal looks exactly like a missing one.
* **Authority is signed and re-checked:** the Ed25519 mandate seal is verified at every step; no request can carry an amount or a principal.
* **The model has no authority:** no tools, no database access, server-side only; the provider key never reaches browser code; seller text is treated as untrusted data; a message containing the buyer's confidential limits is dropped before it reaches the seller.
* **Payments:** one gateway, called only by the settlement engine; writes carry stable request ids and are recorded before they are sent; unknown outcomes are resolved by reading PayPal; Sandbox writes stay locked until the operator opts in.
* **Secrets:** `.env.local` and keys are git-ignored; only `.env.example` (placeholders) is tracked. Keep real keys in an env file outside the project folder.
* The boundaries, and the limits of each, are listed in [docs/ARCHITECTURE-DEMO.md](docs/ARCHITECTURE-DEMO.md). This is hackathon software: production hardening (distributed rate limits, webhook verification, deployment, monitoring) is not done.

## Limitations and known gaps

* The seller is a **local simulator**, not an external marketplace merchant, and not an OS sandbox.
* Delivery verification is **deterministic**, not AI. Only the *price negotiation* can use a model.
* The real Groq negotiation and the real PayPal payment are **separate runs**.
* The latest negotiation prompt has **not** been validated against the real model.
* No explicit buyer acceptance was recorded for the captured Sandbox transaction.
* Not exercised against real PayPal: explicit acceptance, partial capture, void, refund, webhooks. Not built: webhooks, deployment, monitoring, distributed rate limits.
* One buyer account (single principal); no multi-user accounts.
* **Production is a NO-GO** and the V2 contract format is disabled. See `docs/qa/eod-release-readiness-report.md`.

## Documentation

* [docs/submission/](docs/submission/): PayPal and Groq evidence, project description, annotated screenshots
* [docs/ARCHITECTURE-DEMO.md](docs/ARCHITECTURE-DEMO.md): architecture and trust boundaries
* [docs/RELEASE-CANDIDATE.md](docs/RELEASE-CANDIDATE.md): what this tree is, how it was verified (including the failures met), how to run the demo safely, known limitations, security findings
* [docs/DEMO-CHANGELOG.md](docs/DEMO-CHANGELOG.md): what changed during the build, with source digests
* `docs/01`-`16`: the original design and build record; `docs/qa/`: sanitized test and transaction evidence

## AI use disclosure

* **Inside the product:** the optional Buyer Agent uses Groq's `openai/gpt-oss-20b` through `groq-sdk` (an alternative Gemini provider exists in the code and was never used in the evidence runs). The delivery verifier is deterministic and uses no model.
* **During development:** an AI coding assistant, Claude Code (Anthropic Claude models), was used to write and test code and documentation. The complete list of AI tools used is declared in the project's Devpost submission.

## License

MIT, see [LICENSE](LICENSE).
