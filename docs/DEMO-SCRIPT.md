> **SUPERSEDED (2026-11-10).** This file was written before the real PayPal Sandbox transaction and the real Groq negotiation runs and may describe them as not yet done. The current, evidence-checked submission material is in [docs/submission/](submission/) (start with the README and docs/submission/PAYPAL-EVIDENCE.md). Kept unchanged below for the history of the build.

# Demo script (about 2 min 45 s)

Written for: the person recording the video. Every spoken claim below is true of the build as it stands; do not add claims about Sandbox or a live model unless that run really happened (the chips at the top of the screen must match what you say).

**Before recording** – see `docs/DEMO-CHECKLIST.md`. Start the seller simulator and the app (README quick start), `DEMO_CHALLENGE_WINDOW_SECONDS=15`. Say which mode you are in out loud.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Title / top chips | "AI agents can negotiate, but nobody wants to hand them an open wallet. MANDATE lets an agent negotiate while the money, the rules and the final say stay with the buyer. Money moves only when the work is verified." |
| 0:15 | Point at the five chips | "Every integration is labeled. Buyer Agent: [Live AI / Rule-based]. Seller: a local simulator. Verification: deterministic code. PayPal: [Mock / Sandbox]. Nothing here pretends to be more than it is." |
| 0:30 | Mandate card → Preview → Confirm | "First the buyer signs a mandate: a hundred dollars total, sixty per deal, ask me above fifty. I must echo the digest of exactly what I'm signing. The seal is verified on every use." |
| 0:50 | New deal → Open deal & negotiate | "The buyer agent now negotiates the price. It can only send typed price messages, and the orchestrator checks every price against my mandate." |
| 1:05 | Transcript + the model-runs box | "Here's the transcript. [If live: the box lists the real model calls recorded for this deal — model, latency, prompt hash.] [If not: this deal used the deterministic rule and the box says so.]" |
| 1:20 | PayPal card | "Terms are locked under a hash and PayPal authorizes the funds. Nothing is paid yet. [Mock: I'm simulating the buyer's checkout.] [Sandbox: I approve on PayPal's page with the sandbox buyer account.]" |
| 1:40 | Delivery card → "Delivery with a hidden instruction" | "Now the seller delivers. This one hides an instruction aimed at the verifier inside a cell." |
| 1:55 | Flags + NEEDS HUMAN | "The scanner flags it and the deal stops for a human. No payment, no automatic refund. A model never decided anything." |
| 2:05 | New deal → "Clean delivery" | "A clean delivery: the criteria all pass." |
| 2:15 | Verification table → Accept | "Every criterion is checked by code. I can accept now or challenge a criterion. The settlement engine computes the amount from the locked terms." |
| 2:30 | PayPal card + settlement box | "Captured exactly the negotiated twenty dollars [Mock/Sandbox]. The audit history below is hash-chained." |
| 2:40 | Footer | "Production isn't enabled and the seller is a simulator, not an OS sandbox. MANDATE: agents negotiate, code decides, PayPal moves the money." |

**Backup lines** – if a step fails on camera, show the red/refusal banner: the UI never shows success for something the server did not confirm, and saying so is part of the story.
