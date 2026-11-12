# Gemini provider + browser UI audit – report (2026-11-09)

Source manifest (110+ files, src/prisma/package): `1cf9538c80066c1f620e547af29e87daeb9a3dfe4ff591d606971f2dd814d44e` (was 4dd49c22…531c).

**Gemini:** `GeminiProvider` (official `@google/genai` 3.0.0, server-side, no tools). LLM_PROVIDER=gemini, GEMINI_API_KEY, LLM_MODEL_AGENTS. **No model call has been made**: no key is configured, the smoke test has not been authorised. Verified with a fake SDK client only.
**Browser audit:** real Chrome (playwright-core), desktop 1366x900 and mobile 390x844, final run 90/90 checks, screenshots in docs/qa/ui-audit/final. Defects found and fixed: stale deal detail race (deal 3 stuck on "Loading"), mobile overflow of the PayPal table (grid min-width), money without decimals, step bar wrong for flagged/blocked deals, green "passed" next to a severe flag, unlabeled review-reason input, missing favicon.
**Regression:** tsc, eslint, build clean; unit 962/962; PostgreSQL 594/594; mutant P0-A16 (provider creation boundary) killed with src restored byte-for-byte.
**Not done / still mocked:** real Gemini call, any PayPal call (mock only), Sandbox writes locked.
