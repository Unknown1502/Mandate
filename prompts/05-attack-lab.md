Phase 5 — Attack Lab.
Implement attack/cases.ts from docs/05 §5.2 (all 32), harness.ts (3 runs per case, real LLM, sandbox PayPal for a subset, policy/state cases may stop before PayPal), metrics.ts (block rate, false-positive rate, per-category), and /attack-lab page + /api/attack/run.
Do not hardcode or estimate results. Produce a JSON report from real runs. Investigate every failure, fix the root cause (not the test), rerun, and keep before/after reports. Report real numbers and model ids.
