# MANDATE: real Groq model evidence and the optional live validation

Written for: judges and reviewers who want to know exactly what the real AI did, and what it did not.

## What the model does (and cannot do)

The **Buyer Agent** can be a real language model: Groq's `openai/gpt-oss-20b`, called server-side through the official `groq-sdk` (pinned 1.6.0) with a JSON-object response, a token cap, low reasoning effort, **no tools** and no database access. It returns one typed negotiation intent per turn (`propose`, `counter` or `accept`, a price and a short message). Deterministic code then validates it: the opening may not exceed the buyer's target, a counter needs a seller price first, may not retreat from the buyer's own last offer, may move at most half the remaining gap per round, and may never exceed the mandate ceiling. A failed provider call blocks that negotiation with its reason; there is **no silent fallback** to the rule-based buyer, and the UI shows a failure as a failure. The model never sees the ceiling as authority, never learns the seller's private floor, and cannot carry an amount into settlement.

## Real Groq calls that happened (7 requests in total)

All used synthetic data, a throwaway database and **mock PayPal**. None involved a PayPal request. Evidence is in the repository.

| Run | Requests | Result | Evidence |
|---|---|---|---|
| Smoke test (run by the owner, 2026-11-09 15:00 UTC) | 2 | Both replies parsed into the schema, inside the ceiling, no ceiling or target leaked, an injected seller price was not accepted. 945 tokens in, 141 out; latencies 1.9 s and 2.1 s. | `docs/qa/ai-smoke-20261109150054.json` |
| Live negotiation 1 (2026-11-09 15:07 UTC) | 1 | The model proposed **25.00** against a **20.00** target and the simulated seller accepted, so the locked price was 25.00. 534 tokens in, 324 out, 730 ms. The price was inside the mandate but **above the buyer's target**: the model's opening was too generous, which is what motivated the negotiation policy below. | `docs/qa/live-groq/` (result.json, 2 screenshots) |
| Live negotiation 2 (2026-11-09 15:37 UTC) | 4 | Against the labeled **haggler** seller (private floor 22.00, never sent to the buyer) the model offered 18.00, 20.00, 21.29, 21.50 while the seller held 24.89, 22.58, 22.00, 22.00. **No agreement within 4 rounds**: the deal was blocked with `NO_AGREEMENT_WITHIN_ROUNDS`, nothing was locked and no PayPal order was created. 2,740 tokens in, 270 out; latencies 715, 355, 761, 289 ms. Every offer passed the policy. | `docs/qa/negotiation-m4/live-groq/` |

Both live runs are reported as they happened. The second ended without a deal; that is the policy working (the seller's floor was above what the buyer would concede in four rounds), not a failure to hide.

## What changed afterwards, and what is NOT yet validated live

After those runs the negotiation prompt was changed (open near 90% of the target, concede in controlled steps toward the highest price the policy allows, decisive counters) and the deterministic policy (`src/domain/negotiation-policy.ts`) was added. The policy is the authority; the prompt only gives the model its range.

* **The latest prompt has been validated offline only** (fake-SDK suites below). It has **not** been run against the real model.
* The policy was not loosened to manufacture an agreement.

## Offline validation (fake SDK, no network)

| Required case | Test |
|---|---|
| Seller counter near the target | `tests/db/negotiation-prompt-sim.db.test.ts` ("1. a near-target seller counteroffer") |
| Attainable seller floor | same file ("2. an attainable seller floor") and `negotiation-quality.db.test.ts` (rule-based buyer vs the haggler) |
| Seller floor above the buyer's ceiling | "3. a seller floor above the buyer's ceiling": never offers above the ceiling, stops safely, nothing locked |
| Seller refusal | "4. a seller that refuses to move" |
| Illegal model offer | "5. a model that proposes an illegal offer" and `negotiation-quality.db.test.ts` (opening above target, concession too large, retreat, schema extras all fail closed) |
| Ceiling-disclosure attempt | "6. a model that tries to disclose the buyer's ceiling or target": the message is dropped before it reaches the seller and the negotiation continues with the typed price only |

Plus `tests/unit/negotiation-policy.test.ts` and `tests/unit/groq-provider.test.ts` (no tools, no secrets in errors, vendor isolation). Run results are recorded in the final rows of `docs/DEMO-CHANGELOG.md`.

## Optional: one bounded live validation of the latest prompt (NEEDS USER APPROVAL)

Nothing below has been run. It makes real model requests and needs a fresh, explicit "go" from the owner.

* **Scope:** one deal, model `openai/gpt-oss-20b`, synthetic mandate (target 20.00), the labeled haggler seller (floor 22.00), mock PayPal, **at most 4 model requests** (one per round, round limit 4), no PayPal call, no customer data, no automatic fallback or rerun.
* **Record:** request count, tokens, latency, and the final result, whatever it is. If it fails or ends without a deal, that is reported as is; the transcript is not edited and the run is not repeated until it "works".
* **Steps (after approval):**
  1. Create a throwaway database and apply migrations: `DATABASE_URL=<throwaway> npx prisma migrate deploy`.
  2. Start the haggler seller: `SELLER_MODE=haggler SELLER_PORT=4012 npm run seller`.
  3. Start the app with mock PayPal and Groq on a spare port: `DATABASE_URL=<throwaway> PAYPAL_MODE=mock LLM_PROVIDER=groq LLM_MODEL_AGENTS=openai/gpt-oss-20b SELLER_URL=http://127.0.0.1:4012 node --env-file=<your env file with GROQ_API_KEY> node_modules/next/dist/bin/next start -p 3200`.
  4. `node scripts/live-run.mjs --out docs/submission/live-groq-latest-prompt --base http://localhost:3200` (signs in, creates a synthetic mandate, opens one deal, stops after the negotiation).
  5. Drop the throwaway database and stop both processes.
* **How the result may be used:** as a *separate* piece of evidence. It must not be edited together with the PayPal transaction.

## The two verified demonstrations, stated accurately

1. **Real AI negotiation** (Groq, mock PayPal, throwaway database).
2. **Real PayPal Sandbox payment** (rule-based buyer, local seller simulator, real database).

They are separate runs. MANDATE has not yet been shown doing a real model negotiation and a real PayPal authorization and capture in one continuous deal, and the submission does not claim it.
