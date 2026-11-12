# MANDATE: project description (Devpost)

Written for: Devpost judges of the PayPal AI Hackathon (PayPal and AI/agentic-commerce focus, not necessarily familiar with the codebase). Paste the sections below into the matching Devpost fields; each is self-contained.

**Name:** MANDATE
**Tagline:** Buyer-authorized AI commerce with negotiated terms, verifiable delivery and conditional PayPal settlement.

## Inspiration

AI agents can now find, negotiate and buy services for us. The uncomfortable part is the money. Handing an agent an open wallet means it can overpay, be talked into paying for work that was never done, or be steered by hostile text hidden inside the deliverable. Most "AI payments" stop at a spending limit. We wanted to see how far you can go the other way: let an AI agent negotiate, but keep authority, price boundaries and the decision to pay in deterministic code, and tie the payment to evidence that the agreed work was actually delivered.

## What it does

MANDATE connects an **AI-negotiated service agreement** to **evidence-backed delivery verification** and **conditional PayPal settlement**.

* **Buyer defines authority.** The human signs a mandate: budget, per-deal cap, an "ask me above" threshold, allowed sellers, expiry.
* **Agents negotiate within deterministic limits.** A Buyer Agent (a live Groq model, or a rule-based brain) negotiates the price against a Seller Agent. Code validates every offer: the opening may not exceed the buyer's target, concessions are bounded, the mandate ceiling can never be crossed, and the seller never learns the buyer's limits. Agreement locks the terms: task, price and acceptance criteria.
* **PayPal holds the funds, it does not pay yet.** The app creates a PayPal order with `intent: AUTHORIZE` bound to the deal, the buyer approves, and the app authorizes: a hold.
* **The seller delivers evidence.** Deterministic validators check each locked criterion (schema, duplicate rows, date formats); a scanner flags instructions hidden in the data; flagged work stops for a human.
* **Settlement is a deterministic decision.** The engine computes the amount in code from the locked terms and the verification result and captures exactly that against the stored authorization, or voids it. The buyer can accept early, request review of one criterion (re-verified against the original terms), or do nothing and the engine settles when the challenge window ends. No model output and no human input can carry an amount.
* **A hash-chained audit ledger** records every step for the buyer to read.

MANDATE is not escrow, and its delivery verifier is deterministic code, not an AI.

**What is different from "an AI reviews the work".** Designs that use an AI model to judge the delivery can be persuaded by the very text they judge. MANDATE takes the model out of the decision that moves money: the criteria are deterministic validators locked into the agreement by hash, and the engine computes the amount in code. The AI is used where it helps and is contained: negotiating the price inside limits it cannot override. The trade-off is scope: deterministic checks suit structured deliverables such as a CSV against a schema, not subjective work. Google's Agent Payments Protocol (AP2) uses signed "mandates" for a related idea (proving what a user authorised an agent to buy); MANDATE is a separate project, does not implement AP2, and addresses the step after the purchase is authorised.

## Who it is for

Small businesses that outsource structured digital services (for example, cleaning a customer data file) to independent providers and want to delegate the procurement step to an AI agent without giving that agent unrestricted financial authority. That is the initial use case the demo covers. We do not claim it supports every service market today.

## The real AI contribution

The Buyer Agent is `openai/gpt-oss-20b` on **Groq**, called server-side through the official `groq-sdk`, with no tools, no database access and no payment authority. Three real runs (7 requests) negotiated against a labeled simulated seller: a smoke test, a one-round deal, and a four-round negotiation that ended **without a deal** because the seller's private floor was above what the policy allowed the buyer to concede, which is the safe outcome and is shown in the demo. The first run's price was above the buyer's target, which led us to add the deterministic bargaining policy and a sharper prompt. The latest prompt is validated offline against a fake SDK only; we have not claimed a live result for it. A provider failure blocks the negotiation visibly: there is no silent fallback to the rule-based buyer.

## How we use the PayPal Developer Platform

* **Orders v2** with `intent: AUTHORIZE`, and **Payments v2** authorization read, capture and void, through the official **PayPal Server SDK**.
* A **PayPal JavaScript SDK v6** checkout button in the dashboard (covered by tests against fakes; the real transaction used PayPal's hosted approval page for the order).
* **One real end-to-end Sandbox transaction:** order `4YJ97804H20584006`, buyer approval, authorization `19070882T8512554U`, verified delivery, and one capture `02U8827748683101W` of **20.00 USD**, status `COMPLETED`, reconciled with the provider (PayPal fee 1.19, seller net 18.81). Each step was separately approved and run under a network allow-list that refused any request outside the approved list.
* **Authorize first, capture later.** Capture is impossible before eligible delivery verification. Every write has a stable `PayPal-Request-Id`, is recorded before it is sent, and an unknown outcome is resolved by reading PayPal. A database rule allows at most one live capture or void per deal.
* The order must carry the deal's id and locked price or the app refuses to authorize.

## How we built it

Next.js 16 and TypeScript, PostgreSQL with Prisma, Zod at every untrusted boundary, decimal.js for money, Ed25519 for mandate sealing. The seller is a separate loopback process with synthetic data. Test-driven: over a thousand unit tests, more than six hundred PostgreSQL integration tests, a browser journey of 73 checks driven by Playwright on a disposable database, and an earlier attack lab and mutation checks (mock PayPal and scripted AI, not Sandbox or real-model numbers).

## Challenges

* Making "the model proposes, code decides" structural rather than a promise: the model client has no tool parameter, no engine input carries an amount, and tests pin which modules may touch a provider.
* Treating the counterparty's deliverable as hostile input.
* The "did PayPal apply it?" problem: unknown outcomes are reconciled by reading PayPal, never guessed.
* Real Sandbox surprises: a first Sandbox application could not receive USD (`UNSUPPORTED_PAYEE_CURRENCY`) and had to be replaced; PayPal's authorize response names the order, not the authorization, as its resource, which we caught while building the evidence view.
* Honest wording: when a deal settles because the challenge window expired, the UI must not suggest the buyer accepted it. It now states the basis explicitly.

## Accomplishments we are proud of

A complete buyer-authorized flow with an audit trail, an authenticated approval boundary, deterministic payment decisions that survive an adversarial seller, one real Sandbox payment verified end to end, and a real model that negotiates inside limits it cannot override.

## What we learned

Agents are most useful when their authority is small, typed and re-checked. The interesting work is at the boundaries: between model and money, between a PayPal response and what the system believes, and between what a UI says and what actually happened.

## Honest limitations

PayPal **Sandbox only**, no real money; production is a documented NO-GO. The seller is a **local simulator** with synthetic data, not an external merchant. Delivery verification is **deterministic**, not AI. The real Groq negotiation and the real PayPal payment were **separate runs**, not one continuous deal. For the captured transaction the challenge window expired without a challenge, so settlement followed the expired-window rule: **no explicit buyer acceptance event was recorded**. Webhooks, Payouts, refunds and a production deployment are not built; void, partial capture and explicit acceptance were not exercised against real PayPal. PayPal documents a 3-day honor period inside the 29-day authorization period; MANDATE does not implement reauthorization (an expired authorization goes to a human). There is no hosted demo: run instructions are in the repository. A V2 contract format with model-judged criteria exists in code but is disabled.

## What's next

Webhook verification, a real seller identity and marketplace integration, model-assisted verification behind the existing release gate, a live validation of the latest negotiation prompt, and independent security and language review. These are plans, not claims about today's product.

## Built with

PayPal Orders v2, PayPal Payments v2, PayPal Server SDK, PayPal JavaScript SDK v6, Groq (`openai/gpt-oss-20b`, `groq-sdk`), Next.js, React, TypeScript, PostgreSQL, Prisma, Zod, Tailwind CSS, Vitest, Playwright.
