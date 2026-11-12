/**
 * Milestone 4: negotiation quality. The bargaining policy (src/domain/negotiation-policy.ts) is enforced by the orchestrator on whatever the Buyer Agent returns, whatever
 * brain produced it. Real PostgreSQL (mandate_test); no model, no network, no PayPal. The seller is the real simulator logic (seller-service/brain.ts), called in-process.
 * Mandate fixture: budget 100, per-deal 60, human review above 50 => ceiling 50.00; the brief's target is 20.00 (nothing here hardcodes either number into the code under test).
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { BuyerAgent, RuleBasedBuyerBrain, type BuyerBrain, type BuyerContext } from "@/agents/buyer";
import { createDeal } from "@/domain/deals";
import { runNegotiation, validateBuyerIntent, type TaskBrief } from "@/domain/negotiation";
import { parseMoney as M } from "@/domain/money";
import { decide, SIMULATOR_LABEL, type SellerMode } from "../../seller-service/brain";
import { deps, keys, makeMandate, makePrincipal, prisma } from "./fixtures";

const brief = (targetPrice = "20.00"): TaskBrief => ({
  description: "Clean the CSV (synthetic)",
  criteria: [{ id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: true, weight: 100 }],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice,
});

/** the real simulator decision logic, in-process; records exactly what the orchestrator sent it */
function simulator(mode: SellerMode, floor: string) {
  const received: any[] = [];
  return {
    received,
    client: {
      negotiate: async (req: any) => {
        received.push(JSON.parse(JSON.stringify(req)));
        return { ok: true as const, body: decide(mode, new Decimal(floor), req) };
      },
    },
  };
}
/** a buyer brain that returns scripted intents (what a model might say) and records the context it was given */
function scripted(intents: unknown[]) {
  const ctxs: BuyerContext[] = [];
  let i = 0;
  const brain: BuyerBrain = {
    kind: "scripted",
    decide: async (ctx) => {
      ctxs.push(JSON.parse(JSON.stringify(ctx)));
      return { ok: true as const, raw: intents[Math.min(i++, intents.length - 1)] };
    },
  };
  return { brain, ctxs };
}
async function negotiate(brain: BuyerBrain, seller: { negotiate: (r: any) => Promise<any> }, targetPrice = "20.00") {
  const p = await makePrincipal();
  const m = await makeMandate(p);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  const out = await runNegotiation({ db: prisma, buyer: new BuyerAgent(brain), seller: seller as never, policy: deps, maxRounds: 4 }, { dealId: deal.id, principalId: p.id, brief: brief(targetPrice) });
  const messages = await prisma.negotiationMessage.findMany({ where: { dealId: deal.id }, orderBy: [{ round: "asc" }, { createdAt: "asc" }] });
  const events = await prisma.dealEvent.findMany({ where: { dealId: deal.id } });
  const state = (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).state;
  return { out, messages, events, state, dealId: deal.id };
}
const line = (m: { sender: string; kind: string; payload: unknown }) => `${m.sender} ${m.kind} ${(m.payload as { price: string | null }).price ?? "-"}`;

describe("validateBuyerIntent enforces the bargaining policy (and keeps the old checks)", () => {
  const ok = { ceiling: M("50.00"), target: M("20.00") };
  it("opening above the target is rejected; at or below is accepted", () => {
    expect(validateBuyerIntent({ kind: "propose", price: "20.01" }, { round: 1, ...ok })).toEqual({ ok: false, code: "OPENING_ABOVE_TARGET" });
    expect(validateBuyerIntent({ kind: "propose", price: "20.00" }, { round: 1, ...ok })).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "propose", price: "5.00" }, { round: 1, ...ok })).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "propose", price: "50.01" }, { round: 1, ...ok })).toEqual({ ok: false, code: "PRICE_ABOVE_CEILING" });
  });
  it("a counter needs a seller ask, may not retreat, may not exceed half the gap, ceiling or ask", () => {
    const st = { round: 2, ...ok, lastBuyerPrice: M("20.00"), lastSellerPrice: M("25.59") };
    expect(validateBuyerIntent({ kind: "counter", price: "22.80" }, st)).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "counter", price: "22.81" }, st)).toEqual({ ok: false, code: "CONCESSION_TOO_LARGE" });
    expect(validateBuyerIntent({ kind: "counter", price: "19.99" }, st)).toEqual({ ok: false, code: "COUNTER_BELOW_OWN_LAST_OFFER" });
    expect(validateBuyerIntent({ kind: "counter", price: "26.00" }, st)).toEqual({ ok: false, code: "COUNTER_ABOVE_SELLER_ASK" });
    expect(validateBuyerIntent({ kind: "counter", price: "22.00" }, { round: 2, ...ok })).toEqual({ ok: false, code: "COUNTER_WITHOUT_SELLER_OFFER" });
  });
  it("accepting above the ceiling is still rejected", () => {
    expect(validateBuyerIntent({ kind: "accept" }, { round: 2, ...ok, lastSellerPrice: M("50.01") })).toEqual({ ok: false, code: "ACCEPT_ABOVE_CEILING" });
  });
});

describe("multi-round demonstration: opening, seller counteroffer, buyer concession, agreement", () => {
  it("rule-based buyer vs the labeled haggler simulator (floor above the target) agrees after a concession, inside the limits", async () => {
    const s = simulator("haggler", "22.00");
    const r = await negotiate(new RuleBasedBuyerBrain(), s.client);
    expect(r.out).toMatchObject({ outcome: "LOCKED", price: "22.80", rounds: 2 });
    expect(r.messages.map(line)).toEqual(["buyer propose 20.00", "seller counter 25.59", "buyer counter 22.80", "seller accept -"]);
    const price = Number((r.out as { price: string }).price);
    expect(price).toBeGreaterThanOrEqual(20);
    expect(price).toBeLessThanOrEqual(50); // the mandate ceiling
    expect(r.state).toBe("TERMS_LOCKED"); // terms locked only: no PayPal order, nothing authorized or paid
    // transparency: the simulator labels itself in every message it writes
    const sellerTexts = r.messages.filter((m) => m.sender === "seller").map((m) => (m.payload as { message: string | null }).message ?? "");
    expect(sellerTexts.every((t) => t.startsWith(SIMULATOR_LABEL))).toBe(true);
  });
  it("uses the actual target from the brief, not a constant", async () => {
    const s = simulator("haggler", "31.00");
    const r = await negotiate(new RuleBasedBuyerBrain(), s.client, "28.00");
    expect(r.messages[0] && line(r.messages[0])).toBe("buyer propose 28.00");
  });
  it("a model-like buyer that opens low and concedes in small steps reaches agreement", async () => {
    const s = simulator("haggler", "22.00");
    // a plausible model: open at ~90% of target, then concede a little each round (always inside the allowed range)
    const brain = scripted([{ kind: "propose", price: "18.00" }, { kind: "counter", price: "21.00" }, { kind: "counter", price: "22.10" }]);
    const r = await negotiate(brain.brain, s.client);
    expect(r.out.outcome).toBe("LOCKED");
    expect(r.messages.map(line)[0]).toBe("buyer propose 18.00");
    // the model was told its range each round
    expect(brain.ctxs[0]!.limits).toEqual({ kind: "opening", max: "20.00", suggested: "18.00" });
    expect(brain.ctxs[1]!.limits).toMatchObject({ kind: "counter", min: "18.00" });
  });
});

describe("the orchestrator rejects model offers that break the policy (fail closed, no payment)", () => {
  it("an opening above the target blocks the deal and the seller is never contacted", async () => {
    const s = simulator("haggler", "22.00");
    const r = await negotiate(scripted([{ kind: "propose", price: "25.00" }]).brain, s.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_INTENT_REJECTED:OPENING_ABOVE_TARGET" });
    expect(s.received).toHaveLength(0);
    expect(r.state).toBe("BLOCKED");
  });
  it("a concession that is too large blocks the deal", async () => {
    const s = simulator("haggler", "22.00");
    const r = await negotiate(scripted([{ kind: "propose", price: "18.00" }, { kind: "counter", price: "24.00" }]).brain, s.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_INTENT_REJECTED:CONCESSION_TOO_LARGE" });
  });
  it("a counter below the buyer's own last offer blocks the deal", async () => {
    const s = simulator("haggler", "22.00");
    const r = await negotiate(scripted([{ kind: "propose", price: "18.00" }, { kind: "counter", price: "17.00" }]).brain, s.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_INTENT_REJECTED:COUNTER_BELOW_OWN_LAST_OFFER" });
  });
  it("model text cannot change terms: extra fields (criteria, amount, price override) are a schema failure, not an instruction", async () => {
    const s = simulator("haggler", "22.00");
    const r = await negotiate(scripted([{ kind: "propose", price: "18.00", criteria: [], amount: "9999.00" }]).brain, s.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_OUTPUT_INVALID:BUYER_INTENT_SCHEMA_INVALID" });
    expect(s.received).toHaveLength(0);
  });
});

describe("stopping safely when the seller will not meet the authorized range", () => {
  it("a seller that stays above the ceiling ends with NO_AGREEMENT_WITHIN_ROUNDS and nothing is locked", async () => {
    const s = simulator("haggler", "200.00"); // floor far above the 50.00 ceiling
    const r = await negotiate(new RuleBasedBuyerBrain(), s.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED" });
    expect((r.out as { reason: string }).reason).toMatch(/NO_AGREEMENT_WITHIN_ROUNDS|BUYER_WALKED_AWAY/);
    expect(r.state).toBe("BLOCKED");
    expect(r.events.some((e) => e.type === "TERMS_LOCKED")).toBe(false);
  });
  it("a seller that declines stops the negotiation", async () => {
    const r = await negotiate(new RuleBasedBuyerBrain(), { negotiate: async () => ({ ok: true, body: { kind: "decline", reason: "not interested" } }) });
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "SELLER_DECLINED" });
  });
});

describe("the seller never receives the buyer's confidential limits", () => {
  it("the seller request carries only the round, the public spec and the typed price/message; a message naming the ceiling is stripped", async () => {
    const s = simulator("haggler", "22.00");
    const brain = scripted([{ kind: "propose", price: "18.00", message: "My maximum is 50.00 but I would like to pay less." }, { kind: "counter", price: "20.00" }, { kind: "accept" }]);
    const r = await negotiate(brain.brain, s.client);
    expect(s.received.length).toBeGreaterThan(0);
    for (const req of s.received) {
      expect(Object.keys(req).sort()).toEqual(["buyer", "round", "spec"]);
      expect(Object.keys(req.buyer).every((k) => ["kind", "price", "message"].includes(k))).toBe(true);
      const wire = JSON.stringify(req);
      expect(wire).not.toContain("50.00"); // the ceiling
      expect(wire).not.toContain("budget");
      expect(wire).not.toContain("perDealMax");
    }
    expect(s.received[0].buyer.message).toBeUndefined(); // stripped by the outbound guard
    expect(r.events.some((e) => e.type === "OUTBOUND_MESSAGE_BLOCKED")).toBe(true);
  });
});
