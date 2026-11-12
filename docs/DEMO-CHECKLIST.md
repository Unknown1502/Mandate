> **SUPERSEDED (2026-11-10).** This file was written before the real PayPal Sandbox transaction and the real Groq negotiation runs and may describe them as not yet done. The current, evidence-checked submission material is in [docs/submission/](submission/) (start with the README and docs/submission/PAYPAL-EVIDENCE.md). Kept unchanged below for the history of the build.

# Screenshot and recording checklist

Written for: the person capturing the submission evidence.

## Before you start
- [ ] Fresh deals only; do **not** reuse or open the four original spike orders (`.spike/state.json`).
- [ ] API keys live in an env file **outside** OneDrive; nothing secret is visible on screen (hide the terminal env output, the address bar is fine).
- [ ] Seller simulator running (`SELLER_PORT=4010 npm run seller`; for the multi-round negotiation use `SELLER_MODE=haggler SELLER_PORT=4010 npm run seller`, a labeled simulated seller that counteroffers), app started with `SELLER_URL=http://127.0.0.1:4010` and `DEMO_CHALLENGE_WINDOW_SECONDS=15`.
- [ ] Decide the mode and say it in the video: PayPal **Mock** (default) or **Sandbox** (needs `PAYPAL_MODE=sandbox`, Sandbox credentials, your approval of the transaction matrix, and `PAYPAL_SANDBOX_WRITES=authorized` set by you).
- [ ] If you claim a **live AI** run: `npm run ai:smoke -- --env-file <file> --authorize-calls` passed first, the app was started with the same env file, and the chip reads "Live AI · <gemini|groq> · <model>".
- [ ] Browser at 1280×720 or larger; light theme; zoom 100%.

## Screenshots to capture (name the files as shown)
1. `01-status-chips.png` – the five chips and the five-step bar (proves the labels).
2. `02-mandate-preview.png` – the digest confirmation.
3. `03-negotiation.png` – transcript plus the "model calls recorded" box (live) or the "no AI model was called" note (rule-based).
4. `04-paypal-authorized.png` – PayPal card with the operations table (order created and authorization confirmed).
5. `05-flagged-delivery.png` – hidden-instruction delivery with the scanner flag and "Needs your decision".
6. `06-clean-verification.png` – criteria table, all PASS.
7. `07-settlement.png` – settlement decision and amount, deal state "Paid (captured)".
8. `08-audit-history.png` – the ledger list.
9. If Sandbox was really used: `09-paypal-sandbox-approval.png` (PayPal's own approval page, account email blurred) and the Sandbox dashboard showing the authorization/capture.

## Recording
- [ ] Follow `docs/DEMO-SCRIPT.md`; keep it under three minutes.
- [ ] Say "mock" or "Sandbox", and "rule-based" or "live AI", exactly as the chips show.
- [ ] Do not describe anything as production-ready; say "Sandbox only".
- [ ] After recording, revoke or rotate any key that appeared on screen.

## Evidence to attach to the submission
- [ ] `docs/qa/eod-release-readiness-report.md` and this repository's `docs/ARCHITECTURE-DEMO.md`.
- [ ] `docs/qa/ai-smoke-*.json` (if the smoke test was run) and the Sandbox ids from the dashboard (if used).
