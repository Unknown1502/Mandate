> **SUPERSEDED (2026-11-10).** This file was written before the real PayPal Sandbox transaction and the real Groq negotiation runs and may describe them as not yet done. The current, evidence-checked submission material is in [docs/submission/](submission/) (start with the README and docs/submission/PAYPAL-EVIDENCE.md). Kept unchanged below for the history of the build.

# 8. Judge Readiness

## Submission gates
- [ ] Hosted URL **or** complete local setup instructions (do both)
- [ ] Meaningful PayPal integration (Orders AUTHORIZE, authorize, capture/partial, void, webhooks)
- [ ] Meaningful AI (negotiation, adversarial skeptic, verifier, attack lab)
- [ ] Public repo (GitHub/GitLab/Bitbucket) with OSI license visible in About + LICENSE file
- [ ] README: setup, env vars, sandbox account steps, API usage, architecture, honest limitations, tools used and how
- [ ] Public YouTube video < 3 min, shows the real app running
- [ ] No third-party trademarks/copyrighted music/material
- [ ] Devpost fields: name, elevator pitch, project story, repo, video, description, tools list

## Five equal criteria
| Criterion | Evidence in Mandate |
|---|---|
| Technological implementation | Real authorize/capture/partial/void, signature-verified webhooks, hash-chained ledger, deterministic settlement, quote-validated LLM outputs |
| Design | Single timeline that makes agent + money state legible; copy that separates "reserved" from "captured" |
| Potential impact | Trust layer enabling agent-to-agent commerce; safe-by-construction limits |
| Innovation | Conditional settlement + adversarial verification + mandate; "AI proposes, code decides" |
| Presentation | Attack-fails-live moment; measured results; honest limits |

## Special awards to target
Best Agentic Commerce; Best Use of PayPal and AI; Most Creative; Best Demo Delivery. Partner prize candidates (only if truly used): AG Grid, Render.

## Do not claim
- "Escrow", "legal protection", "guaranteed capture"
- "Secure against prompt injection" (say: "measured N/M attacks blocked on our suite")
- That the Agent Toolkit performs authorize/capture/void
- That the seller agent is a real third-party business
- Any number not produced by your harness
- Production readiness or live-money use

## Pre-submit checklist
Fresh-browser run of every demo step on the hosted build; secrets scan (repo, bundle, logs); confirm webhook registered to the hosted URL; confirm sandbox accounts/credentials valid for judging period; keep demo environment alive; re-read all rules.
