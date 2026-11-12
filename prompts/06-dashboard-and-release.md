Phase 6–7 — Dashboard, webhooks, deploy.
Dashboard per docs/06: mandate screen, deal timeline, verification table (deterministic vs LLM-judged badges, measured values), ledger with Verify chain button, approval screen ("reserving, not paying"), Attack Lab. Use frontend-design guidance; calm financial style; accessible; mobile usable.
Webhook route per docs/03 §3.10 (signature verify, dedupe, fresh GET, idempotent). Deploy to Render + Postgres. Provide README judge quickstart, MIT license in repo About, demo seed script (mandate + sandbox buyer instructions).
Test every demo-script step on the hosted build from a fresh browser. Scan repo/bundle/logs for secrets. Report evidence, not assertions.
