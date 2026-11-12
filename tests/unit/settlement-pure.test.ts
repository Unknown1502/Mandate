/** Unit-tested pure logic: settlement decision + authorization validation. No I/O. */
import { describe, expect, it } from "vitest";
import { D, fmt } from "@/domain/money";
import { decideSettlement, flagSchema, type CriterionResult, type Flag, type SettlementInput } from "@/domain/settlement";
import type { Criterion } from "@/domain/terms";
import { validateAuthorization } from "@/settlement/engine";

const det = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "deterministic", validator: "no_duplicate_rows", params: {}, required, weight });
const llm = (id: string, weight: number, required: boolean): Criterion => ({ id, text: id, type: "llm_judged", required, weight });
const r = (criterionId: string, status: CriterionResult["status"], source: CriterionResult["source"] = "deterministic"): CriterionResult => ({ criterionId, status, source });

const base = (over: Partial<SettlementInput> = {}): SettlementInput => ({
  price: new D("20.00"),
  authorizedAmount: new D("20.00"),
  criteria: [det("a", 50, true), det("b", 30, false), det("c", 20, false)],
  results: [r("a", "met"), r("b", "met"), r("c", "met")],
  flags: [],
  injectionPolicy: "HUMAN_REVIEW",
  authorizationOk: true,
  partialAllowed: true,
  ...over,
});
const out = (d: ReturnType<typeof decideSettlement>) => `${d.decision}:${d.earned}:${fmt(d.amount)}`;

describe("decideSettlement: amounts", () => {
  it("everything met -> FULL_CAPTURE for exactly the locked price", () => {
    expect(out(decideSettlement(base()))).toBe("FULL_CAPTURE:100:20.00");
  });
  it("partial earned values: 50/70/80 -> price*earned/100 rounded down, only when allowed", () => {
    const cr = [det("a", 50, true), det("b", 20, false), det("c", 10, false), det("d", 20, false)];
    expect(out(decideSettlement(base({ criteria: cr, results: [r("a", "met"), r("b", "met"), r("c", "not_met"), r("d", "not_met")] })))).toBe("PARTIAL_CAPTURE:70:14.00");
    expect(out(decideSettlement(base({ criteria: cr, results: [r("a", "met"), r("b", "not_met"), r("c", "not_met"), r("d", "not_met")] })))).toBe("PARTIAL_CAPTURE:50:10.00");
    expect(out(decideSettlement(base({ criteria: cr, results: [r("a", "met"), r("b", "met"), r("c", "met"), r("d", "not_met")] })))).toBe("PARTIAL_CAPTURE:80:16.00");
  });
  it("rounds DOWN to cents and never above the price", () => {
    const cr = [det("a", 49, true), det("b", 1, false), det("c", 50, false)];
    const d = decideSettlement(base({ price: new D("0.99"), authorizedAmount: new D("0.99"), criteria: cr, results: [r("a", "met"), r("b", "met"), r("c", "not_met")] }));
    expect(out(d)).toBe("PARTIAL_CAPTURE:50:0.49");
    expect(d.amount.lte(new D("0.99"))).toBe(true);
  });
  it("a partial amount that rounds to zero is not captured", () => {
    const cr = [det("a", 50, true), det("b", 50, false)];
    expect(decideSettlement(base({ price: new D("0.01"), authorizedAmount: new D("0.01"), criteria: cr, results: [r("a", "met"), r("b", "not_met")] })).reasons).toEqual(["PARTIAL_AMOUNT_ROUNDS_TO_ZERO"]);
  });
  it("partial settlement unavailable (mandate/Sandbox gate) -> NEEDS_HUMAN, never a guessed amount", () => {
    const cr = [det("a", 60, true), det("b", 40, false)];
    const d = decideSettlement(base({ partialAllowed: false, criteria: cr, results: [r("a", "met"), r("b", "not_met")] }));
    expect(d.decision).toBe("NEEDS_HUMAN");
    expect(d.reasons).toEqual(["PARTIAL_SETTLEMENT_NOT_AVAILABLE"]);
    expect(d.amount.isZero()).toBe(true);
  });
  it("earned < 50 via deterministic failures -> VOID (0 and 49)", () => {
    const cr = [det("a", 49, true), det("b", 51, false)];
    expect(out(decideSettlement(base({ criteria: cr, results: [r("a", "met"), r("b", "not_met")] })))).toBe("VOID:49:0.00");
    expect(out(decideSettlement(base({ criteria: [det("a", 100, false)], results: [r("a", "not_met")] })))).toBe("VOID:0:0.00");
  });
  it("amount is capped: a lower authorization blocks, it is never clamped silently", () => {
    expect(decideSettlement(base({ authorizedAmount: new D("19.99") })).reasons).toEqual(["AUTHORIZED_AMOUNT_BELOW_PRICE"]);
  });
});

describe("decideSettlement: who may decide what", () => {
  it("required deterministic criterion failed -> VOID, even with an injection flag present", () => {
    const flags: Flag[] = [{ code: "INSTR_OVERRIDE", severity: "HIGH", source: "llm" }, { code: "HIDDEN_TEXT", severity: "HIGH", source: "deterministic", severe: true }];
    const d = decideSettlement(base({ results: [r("a", "not_met"), r("b", "met"), r("c", "met")], flags }));
    expect(d.decision).toBe("VOID");
    expect(d.reasons).toEqual(["REQUIRED_DETERMINISTIC_FAILED:a"]);
  });
  it("a verifier cannot assert a deterministic criterion (source mismatch -> NEEDS_HUMAN)", () => {
    const d = decideSettlement(base({ results: [r("a", "met", "verifier"), r("b", "met"), r("c", "met")] }));
    expect(d.decision).toBe("NEEDS_HUMAN");
    expect(d.reasons).toContain("SOURCE_MISMATCH:a");
  });
  it("a deterministic checker cannot assert an LLM-judged criterion", () => {
    const d = decideSettlement(base({ criteria: [det("a", 50, true), llm("q", 50, false)], results: [r("a", "met"), r("q", "met", "deterministic")] }));
    expect(d.decision).toBe("NEEDS_HUMAN");
  });
  it("LLM-only failure of a required criterion never voids", () => {
    const d = decideSettlement(base({ criteria: [det("a", 50, true), llm("q", 50, true)], results: [r("a", "met"), r("q", "not_met", "verifier")] }));
    expect(d.decision).toBe("NEEDS_HUMAN");
    expect(d.reasons).toEqual(["LLM_REQUIRED_NOT_MET:q"]);
  });
  it("any unverifiable or missing or duplicated result -> NEEDS_HUMAN (never a partial payout on a guess)", () => {
    expect(decideSettlement(base({ results: [r("a", "met"), r("b", "met"), r("c", "unverifiable")] })).decision).toBe("NEEDS_HUMAN");
    expect(decideSettlement(base({ results: [r("a", "met"), r("b", "met")] })).reasons).toContain("MISSING_RESULT:c");
    expect(decideSettlement(base({ results: [r("a", "met"), r("a", "not_met"), r("b", "met"), r("c", "met")] })).decision).toBe("NEEDS_HUMAN");
  });
  it("results for criteria that are not in the locked terms are ignored (cannot add criteria)", () => {
    const d = decideSettlement(base({ results: [...base().results, r("bonus", "met")] }));
    expect(out(d)).toBe("FULL_CAPTURE:100:20.00");
  });
  it("flags only escalate: HIGH flag or severe deterministic flag -> NEEDS_HUMAN with full marks", () => {
    expect(decideSettlement(base({ flags: [{ code: "X", severity: "HIGH", source: "llm" }] })).decision).toBe("NEEDS_HUMAN");
    expect(decideSettlement(base({ flags: [{ code: "HIDDEN_TEXT", severity: "MED", source: "deterministic", severe: true }] })).reasons).toEqual(["DETERMINISTIC_MANIPULATION_FLAG"]);
    expect(decideSettlement(base({ injectionPolicy: "BLOCK", flags: [{ code: "HIDDEN_TEXT", severity: "MED", source: "deterministic", severe: true }] })).reasons).toEqual(["INJECTION_POLICY_BLOCK"]);
  });
  it("the two escalation rules are INDEPENDENT (Attack Lab M07/M08): each alone suffices, and the severe rule does not depend on severity", () => {
    const severeLow = decideSettlement(base({ flags: [{ code: "HIDDEN_TEXT", severity: "LOW", source: "deterministic", severe: true }] }));
    expect([severeLow.decision, severeLow.reasons]).toEqual(["NEEDS_HUMAN", ["DETERMINISTIC_MANIPULATION_FLAG"]]); // step 4 only: a HIGH-flag rule would not see this
    const highOnly = decideSettlement(base({ flags: [{ code: "AUTHORITY_SPOOF", severity: "HIGH", source: "deterministic", severe: false }] }));
    expect([highOnly.decision, highOnly.reasons]).toEqual(["NEEDS_HUMAN", ["HIGH_SEVERITY_FLAG"]]); // step 5 only: not severe
    const both = decideSettlement(base({ flags: [{ code: "INSTR_OVERRIDE", severity: "HIGH", source: "deterministic", severe: true }] }));
    expect(both.reasons).toEqual(["DETERMINISTIC_MANIPULATION_FLAG"]); // the more specific rule reports first
    // an LLM flag can never be 'severe' evidence: only a deterministic one triggers step 4
    expect(decideSettlement(base({ flags: [{ code: "INSTR_OVERRIDE", severity: "MED", source: "llm", severe: true }] })).decision).toBe("FULL_CAPTURE");
  });
  it("UNSCANNED_LANGUAGE (language uncertainty) only escalates, from any source: never a capture, never a void, never an amount", () => {
    for (const source of ["deterministic", "llm"] as const) {
      const d = decideSettlement(base({ flags: [{ code: "UNSCANNED_LANGUAGE", severity: "HIGH", source, severe: false }] }));
      expect([d.decision, d.reasons, fmt(d.amount)]).toEqual(["NEEDS_HUMAN", ["HIGH_SEVERITY_FLAG"], "0.00"]);
    }
    // with a required deterministic failure the contract failed on its own merits: the flag neither causes nor prevents that outcome
    const failed = (flags: SettlementInput["flags"]) => decideSettlement(base({ results: [r("a", "not_met"), r("b", "met"), r("c", "met")], flags }));
    expect(failed([]).decision).toBe("VOID");
    expect(failed([{ code: "UNSCANNED_LANGUAGE", severity: "HIGH", source: "deterministic", severe: false }]).decision).toBe("VOID");
  });
  it("LOW/MED non-severe flags are informational and do not block an honest full capture", () => {
    expect(decideSettlement(base({ flags: [{ code: "URGENCY_PRESSURE", severity: "MED", source: "llm" }, { code: "N", severity: "LOW", source: "llm" }] })).decision).toBe("FULL_CAPTURE");
  });
  it("invalid authorization -> NEEDS_HUMAN regardless of results", () => {
    expect(decideSettlement(base({ authorizationOk: false })).reasons).toEqual(["AUTHORIZATION_NOT_VALID"]);
  });
  it("a result carries no amount: extra fields cannot be smuggled through the flag schema", () => {
    expect(flagSchema.safeParse({ code: "X", severity: "LOW", source: "llm", amount: "999" }).success).toBe(true); // stripped, not used
    expect("amount" in flagSchema.parse({ code: "X", severity: "LOW", source: "llm", amount: "999" })).toBe(false);
  });
  it("output amount is always 0 unless a capture decision, and never exceeds the price (property sweep)", () => {
    for (let earnedA = 0; earnedA <= 100; earnedA += 5) {
      const cr = [det("a", earnedA === 0 ? 1 : earnedA, false), det("b", 100 - (earnedA === 0 ? 1 : earnedA), false)];
      for (const resB of ["met", "not_met"] as const) {
        const d = decideSettlement(base({ criteria: cr, results: [r("a", "met"), r("b", resB)] }));
        if (d.decision === "FULL_CAPTURE" || d.decision === "PARTIAL_CAPTURE") expect(d.amount.lte(new D("20.00"))).toBe(true);
        else expect(d.amount.isZero()).toBe(true);
      }
    }
  });
});

describe("validateAuthorization (strict)", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  const good = { id: "A1", status: "CREATED", amount: { currency_code: "USD", value: "20.00" }, expiration_time: "2026-12-01T00:00:00Z" };
  const v = (over: Record<string, unknown> = {}, exp: { authId: string | null; fallbackExpiry?: Date | null } = { authId: "A1" }) =>
    validateAuthorization({ ...good, ...over } as never, exp, now, 5 * 60_000);

  it("accepts a CREATED, USD, unexpired authorization with the expected id", () => {
    expect(v()).toMatchObject({ ok: true });
  });
  it.each([
    [{ id: "OTHER" }, "AUTH_ID_MISMATCH"],
    [{ status: "VOIDED" }, "AUTH_STATUS_VOIDED"],
    [{ status: "CAPTURED" }, "AUTH_STATUS_CAPTURED"],
    [{ status: "PARTIALLY_CAPTURED" }, "AUTH_STATUS_PARTIALLY_CAPTURED"],
    [{ status: "PENDING" }, "AUTH_STATUS_PENDING"],
    [{ status: "created" }, "AUTH_STATUS_created"],
    [{ amount: { currency_code: "EUR", value: "20.00" } }, "AUTH_CURRENCY_NOT_USD"],
    [{ amount: undefined }, "AUTH_CURRENCY_NOT_USD"],
    [{ amount: { currency_code: "USD", value: "twenty" } }, "AUTH_AMOUNT_INVALID"],
    [{ expiration_time: "2026-11-05T00:00:00Z" }, "AUTH_EXPIRED_OR_EXPIRING"],
    [{ expiration_time: "2026-11-06T00:04:00Z" }, "AUTH_EXPIRED_OR_EXPIRING"], // inside the 5-minute margin
  ])("rejects %j as %s", (over, reason) => {
    expect(v(over)).toEqual({ ok: false, reason });
  });
  it("fails closed when no expiry is known anywhere, and uses the stored fallback when PayPal omits it", () => {
    expect(v({ expiration_time: undefined })).toEqual({ ok: false, reason: "AUTH_EXPIRY_UNKNOWN" });
    expect(v({ expiration_time: undefined }, { authId: "A1", fallbackExpiry: new Date("2026-12-01T00:00:00Z") })).toMatchObject({ ok: true });
    expect(v({}, { authId: null })).toEqual({ ok: false, reason: "AUTH_ID_MISMATCH" });
  });
});
