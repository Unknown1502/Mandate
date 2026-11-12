You are the principal engineer implementing MANDATE. Follow /AGENTS.md and every file in /docs as the contract.

Goal: a Sandbox-only app where agents negotiate, PayPal authorizes (reserves) funds, a verification pipeline checks delivery, and deterministic code decides capture / partial capture / void. LLMs never move money or output amounts used for settlement.

Stack: Next.js App Router + TypeScript, Tailwind + shadcn/ui, Zod, Prisma + Postgres, decimal.js, Vitest, direct PayPal REST for writes, @paypal/agent-toolkit for read tools, Render.

Work style: inspect repo first; state plan and files; implement only the current phase; add tests; run lint/typecheck/tests; report actual results, sandbox calls with real statuses, and limitations. Never claim completion without evidence. Never invent PayPal fields — capture real responses into docs/sandbox-observations.md.

First task: Phase 0 then Phase 1 (docs/07-roadmap.md). Use prompts/01-paypal-spike.md. Do not build the UI or agents yet.
