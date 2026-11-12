Phase 2 — Core domain (no LLM, no UI).
Implement: money.ts (decimal.js, USD, round-down to cents), canonical JSON, Ed25519 mandate signing/verification (key script included), terms.ts + termsHash, statemachine.ts as a typed transition table (throw on illegal), policy.ts with every check in docs/04 §4.3 returning reason codes, ledger.ts hash chain + verify, Prisma migrations from prisma/schema.prisma.
Tests (Vitest): each policy check pass/fail; each illegal transition; ledger tamper detection at the exact seq; Decimal edge cases; termsHash drift.
Report actual test counts. Do not start Phase 3.
