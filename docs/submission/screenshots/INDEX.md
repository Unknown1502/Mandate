# Screenshot index

Every image is a real capture of the running application. Nothing is mocked up or edited. Labels in the title say whether the payment shown is **MOCK** (in-memory simulation, no PayPal call) or **real Sandbox**, and whether the Buyer Agent was **rule-based** or the **live Groq model**.

Captured 2026-11-09 and 2026-11-10. Images 01, 04-09, 15-16 come from the automated browser journey on a disposable database (`mock-journey/`, 73 of 73 checks passed on the final build). Images 06 and 11-14 come from a read-only capture of the real, completed Sandbox deal (`real-sandbox/`, 14 of 14 checks passed, 0 state-changing browser requests). Image 02 is from the earlier real Groq run. Image 10 is the real deal before capture, from the earlier UI.

No screenshot shows a password, a token or a client secret. Sign-in screens are not part of the curated set.

| File | Required state | What it shows | Payment | Buyer Agent |
|---|---|---|---|---|
| `01-mandate-created.png` | 1. Mandate created | The signed mandate: budget, per-deal cap, "ask me above" threshold, allowed seller, expiry, "Seal verified". | none yet | n/a |
| `02-negotiation-live-groq-4-rounds.png` | 2. Negotiation (live AI) | **Real Groq `openai/gpt-oss-20b`** negotiating against the labeled haggler simulator for four rounds (18.00, 20.00, 21.29, 21.50 against 24.89, 22.58, 22.00, 22.00). "Model calls recorded for this deal: 4 (4 succeeded, 0 failed)" with latency and prompt hashes. Ends **without a deal** (`NO_AGREEMENT_WITHIN_ROUNDS`); no PayPal order. | MOCK, none created | **Live AI: groq** |
| `04-negotiation-agreement-haggler-mock-paypal.png` | 3. Negotiation agreement | Rule-based buyer vs the labeled haggler: opening 20.00, seller counter 25.59, buyer concession 22.80, "accept". Terms locked at 22.80; the page says no AI model was called. | MOCK | Rule-based |
| `05-seller-delivery-verified-decision-explainer.png` | 4. Seller delivery + 5. evidence | The simulated seller's `cleaned.csv`, three deterministic checks all PASS, and the **three outcomes of the open challenge window** (accept now / do nothing = expired-window rule, not an acceptance / request review). | MOCK | Rule-based |
| `06-evidence-verification-real-deal.png` | 5. Evidence verification | The same delivery card on the real Sandbox deal: hash, rows, required and optional criteria with PASS and the line "AI assessment in this verification: none". | real Sandbox | Rule-based |
| `07-human-review-hidden-instruction.png` | 6. Human review | A delivery containing a hidden instruction stops for a human decision; payment is not computed from model or seller text. | MOCK | Rule-based |
| `08-challenge-review-request-form.png` | 6. Human review (challenge) | The decision box with its three outcomes (Accept now / Do nothing = expired-window rule / Request review) and the "Request review of one criterion" form with a criterion chosen and a reason typed. The longer explanation of what a review does (same delivery, original locked terms, no new amount, limits, 72-hour timeout never auto-pays or auto-voids) sits just below this crop; it is visible in image 05 and in the live app. | MOCK | Rule-based |
| `09-payment-authorized-MOCK.png` | 7. Payment authorized (mock) | "Authorized: a hold on the buyer's funds at PayPal, not captured and not escrow ... (MOCK, simulated)". | MOCK | Rule-based |
| `10-real-sandbox-authorized-verified-before-capture.png` | 7. Payment authorized (**real**) | The real Sandbox deal after authorization and verified delivery, before capture. Earlier UI revision (before the wording changes). | real Sandbox | Rule-based |
| `11-real-sandbox-capture-completed-full.png` | 8. Capture completed | The whole dashboard for the real deal: "Paid (captured)", "Captured (PayPal Sandbox)", $20.00, the settlement card with its basis. | **real Sandbox** | Rule-based |
| `12-real-sandbox-paypal-card-ids.png` | 8. Capture completed | The PayPal card: order `4YJ97804H20584006`, authorization `19070882T8512554U` (CAPTURED), capture `02U8827748683101W` (COMPLETED), HTTP 200/201 for each operation. | **real Sandbox** | Rule-based |
| `13-real-sandbox-settlement-basis-expired-window.png` | 8. Capture completed | "Settlement decision: full capture - $20.00 ... Basis: Paid under the expired-window rule: verification passed and the challenge window ended with no review request. **No explicit acceptance was recorded for this deal.**" | **real Sandbox** | Rule-based |
| `14-real-sandbox-capture-mobile.png` | 8. (mobile) | The same completed deal at 390 px wide; the layout holds. | **real Sandbox** | Rule-based |
| `15-explicit-acceptance-path-MOCK.png` | extra | For contrast: when the buyer **does** press Accept, the basis reads "Paid after you accepted the delivery ... the amount came from the locked criteria, not from the acceptance" (mock). | MOCK | Rule-based |
| `16-failed-delivery-voided-MOCK.png` | extra | A delivery with duplicate rows fails a required criterion: the authorization is voided, nothing is paid. | MOCK | Rule-based |

## Honest notes

* **"Negotiation in progress" has no separate screen.** The agents' rounds run inside one request, so the dashboard shows the finished transcript. Images 02 and 04 show every round; there is no mid-negotiation capture, and none was staged.
* The top chip is labelled **"Buyer Agent for new deals"**: it reports the server's configuration, not what happened in an existing deal. Each deal's own transcript says which brain negotiated it. In images 11-14 the server was configured for Groq but this deal's transcript says "No AI model was called for this deal".
* The real-deal audit ledger includes one `PAYPAL_READ_FAILED` event (a locally refused read, see `PAYPAL-EVIDENCE.md`).
* `mock-journey/` holds all 25 captures of the browser journey (login errors, validation errors, injected network and server failures, mobile view, seller scenarios) and `report.json` with the 73 checks. `real-sandbox/` holds the per-card crops, the mobile crops and `report.json`.
