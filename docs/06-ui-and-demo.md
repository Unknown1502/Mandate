# 6. UI and Demo

## 6.1 Design principle
A calm financial-trust product, not an AI toy. Dark-neutral or light-neutral, high contrast, one accent color, strong typography. The star is the **timeline** that shows agents talking, money states, and verdicts in one vertical flow. Optional: AG Grid (sponsor) for the ledger/attack tables — only if it saves time.

## 6.2 Screens
1. **Mandate** — create/sign: budget, per-deal max, task types, counterparties, expiry; shows signature status and remaining budget (captured + committed).
2. **Deal timeline** (`/deals/[id]`) — vertical live timeline: negotiation messages (agent avatars), terms lock card (with `termsHash`), policy result, PayPal order card (state: created → approved → AUTHORIZED, with amount and auth id suffix), delivery card, verification table, settlement card (CAPTURED/PARTIAL/VOIDED with computed math shown), webhook confirmations.
3. **Verification table** — each criterion row: badge `deterministic` or `LLM-judged`, status, evidence quote, and for deterministic the actual measured value. Skeptic flags shown separately with severity.
4. **Ledger** — events with hashes; **Verify chain** button; a "tamper demo" dev-only control that edits a row so verification fails.
5. **Attack Lab** — case list, run buttons, latest report with measured block rate and false-positive rate, per-case drill-down to the timeline.
6. **PayPal approval step** — clear "You are approving a reservation, not a payment" copy, deal summary, then redirect to PayPal sandbox.

## 6.2b Positioning line (use in UI, README, video)
"A prototype of authorization-based conditional settlement for agent-mediated work. The seller agent is simulated; sandbox funds go to the connected merchant account."

## 6.3 Copy rules
- Say "reserved/authorized" until capture completes; "captured" only after PayPal confirms.
- Say "simulated seller agent" in the UI wherever it appears.
- Never say "escrow", "guaranteed", "secure payments", or "100% attack protection".
- Show math for partial captures: `earned 70/100 → $14.00 of $20.00`.

## 6.4 Demo script (target ≤ 2:50)
| Time | Visual | Narration |
|---|---|---|
| 0:00–0:12 | Split screen: an agent about to pay a stranger agent | "AI agents are starting to buy from each other. Today, paying means trusting." |
| 0:12–0:30 | Mandate screen; sign mandate; budget bar | "A human signs the limits first." |
| 0:30–0:55 | Negotiation + terms lock + policy OK + PayPal approval + AUTHORIZED | "Agents agree on terms. PayPal reserves the money. Nothing has moved." |
| 0:55–1:20 | Honest delivery → verification table → CAPTURED | "Checks pass; code computes the amount; PayPal captures." |
| 1:20–1:55 | **Attack:** delivery with a hidden instruction **and** a CSV that fails a required check → deterministic validator fails → VOIDED; show PayPal void state | "The seller tries to talk the verifier into paying. The agreed checks still fail, so the reservation is voided." |
| 1:55–2:15 | Partial delivery → 70% criteria → partial capture with math | "Partial work earns partial pay, computed by code, not by an LLM." |
| 2:15–2:35 | Ledger verify; tamper a row; verify fails | "Every decision is in a hash-chained ledger." |
| 2:35–2:50 | Attack Lab: measured results | "N runs, M attacks succeeded. Here's what we found and fixed." (use real numbers) |
| 2:50 | Logo + tagline | "Mandate. Money moves only when the work is verified." |

Rules: show only steps that passed on the deployed build; use real PayPal sandbox screens; no third-party logos/music beyond PayPal sandbox UI; upload to YouTube public.
