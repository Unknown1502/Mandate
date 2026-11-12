/**
 * Milestone 5, Part B: the Buyer Agent prompt guidance, tested OFFLINE with a FAKE model client (no Groq, no network, no key).
 * The fake model reads ONLY what a real model would read (the system and user prompt text) and answers the way the prompt tells it to: it opens where told to open, counters at the
 * suggested (highest allowed) price, accepts a price at or below its target, and walks away in the last round if the seller is still above its limit. It runs through the REAL
 * LlmBuyerBrain + callLLM schema validation + runNegotiation + the deterministic policy, against the real simulator logic. This proves the prompt carries what the policy needs and
 * that the pipeline converges, stops safely and fails closed; it does NOT prove how a real model behaves (see docs/qa for the real runs).
 * Numbers come from the mandate fixture (ceiling 50.00) and the brief (target 20.00) and from the prompts themselves; the code under test hardcodes none of them.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { BuyerAgent, LlmBuyerBrain } from "@/agents/buyer";
import type { LlmProvider, LlmRequest } from "@/agents/llm";
import { createDeal } from "@/domain/deals";
import { runNegotiation, type TaskBrief } from "@/domain/negotiation";
import { decide } from "../../seller-service/brain";
import { deps, keys, makeMandate, makePrincipal, prisma } from "./fixtures";

const brief = (targetPrice = "20.00"): TaskBrief => ({
  description: "Clean the CSV (synthetic)",
  criteria: [{ id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: true, weight: 100 }],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice,
});

/** answers like a model that follows the prompt; `override` lets a test make it misbehave */
class FakeModel implements LlmProvider {
  readonly name = "fake";
  calls: LlmRequest[] = [];
  constructor(private readonly override?: (round: number, req: LlmRequest) => unknown) {}
  async complete(req: LlmRequest) {
    this.calls.push(req);
    const round = Number(/Round (\d+) of/.exec(req.user)![1]);
    if (this.override) {
      const o = this.override(round, req);
      if (o !== undefined) return { text: JSON.stringify(o) };
    }
    const target = Number(/private target is (\d+\.\d\d)/.exec(req.system)![1]);
    const ceiling = Number(/more than (\d+\.\d\d)/.exec(req.system)![1]);
    const maxRounds = Number(/at most (\d+) rounds/.exec(req.system)![1]);
    const open = /open at ([\d.]+)/.exec(req.user);
    if (open) return { text: JSON.stringify({ kind: "propose", price: open[1] }) };
    const asks = [...req.user.matchAll(/seller counter price=([\d.]+)/g)];
    const ask = Number(asks[asks.length - 1]![1]);
    const range = /between ([\d.]+) and ([\d.]+)/.exec(req.user)!;
    if (ask <= target) return { text: JSON.stringify({ kind: "accept" }) };
    if (round >= maxRounds) return { text: JSON.stringify(ask <= ceiling ? { kind: "accept" } : { kind: "walk_away", reason: "the seller is above my limit" }) };
    return { text: JSON.stringify({ kind: "counter", price: range[2]! }) }; // decisive: the highest price allowed this round
  }
}

type Seller = { negotiate: (r: any) => Promise<any> };
const simulator = (floor: string) => {
  const received: any[] = [];
  const client: Seller = { negotiate: async (req) => (received.push(JSON.parse(JSON.stringify(req))), { ok: true, body: decide("haggler", new Decimal(floor), req) }) };
  return { received, client };
};
/** a scripted seller: answers per round from a function, and records what it was sent */
const stubSeller = (answer: (round: number, offer: number) => unknown) => {
  const received: any[] = [];
  const client: Seller = { negotiate: async (req) => (received.push(JSON.parse(JSON.stringify(req))), { ok: true, body: answer(req.round, Number(req.buyer.price)) }) };
  return { received, client };
};

async function negotiate(model: FakeModel, seller: Seller, targetPrice = "20.00") {
  const p = await makePrincipal();
  const m = await makeMandate(p);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  const out = await runNegotiation({ db: prisma, buyer: new BuyerAgent(new LlmBuyerBrain(model, "fake-model")), seller: seller as never, policy: deps, maxRounds: 4 }, { dealId: deal.id, principalId: p.id, brief: brief(targetPrice) });
  const messages = await prisma.negotiationMessage.findMany({ where: { dealId: deal.id }, orderBy: [{ round: "asc" }, { createdAt: "asc" }] });
  const events = await prisma.dealEvent.findMany({ where: { dealId: deal.id } });
  const state = (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).state;
  return { out, messages, events, state };
}
const prices = (r: { messages: { sender: string; payload: unknown }[] }, sender: string) => r.messages.filter((m) => m.sender === sender).map((m) => (m.payload as { price: string | null }).price);
const CEILING = 50; // the mandate fixture's effective ceiling (min of per-deal max 60, human-review threshold 50, remaining budget 100)

describe("prompt guidance: what the model is told", () => {
  it("the opening and counter prompts carry the machine-checkable range and the decisive-concession instruction", async () => {
    const m = new FakeModel();
    await negotiate(m, simulator("22.00").client);
    expect(m.calls[0]!.user).toMatch(/open at 18\.00 \(about 90% of your target\)/);
    expect(m.calls[1]!.user).toMatch(/between 18\.00 and 21\.45/);
    expect(m.calls[1]!.user).toMatch(/move decisively/);
    expect(m.calls[1]!.user).toMatch(/counter at 21\.45/);
    expect(m.calls[0]!.user).toMatch(/Do not write any dollar amount/);
  });
});

describe("1. a near-target seller counteroffer", () => {
  it("settles in two rounds below the target when a decisive buyer meets a seller whose price is just above the target", async () => {
    const seller = stubSeller((round, offer) => (offer >= 19 ? { kind: "accept" } : { kind: "counter", price: "20.50" }));
    const r = await negotiate(new FakeModel(), seller.client);
    expect(prices(r, "buyer")).toEqual(["18.00", "19.25"]); // open at 90% of the target, then half the gap to 20.50
    expect(r.out).toMatchObject({ outcome: "LOCKED", price: "19.25", rounds: 2 });
    expect(Number((r.out as { price: string }).price)).toBeLessThanOrEqual(20);
  });
  it("and accepts outright when the seller's price is at or below the target", async () => {
    const seller = stubSeller(() => ({ kind: "counter", price: "19.50" }));
    const r = await negotiate(new FakeModel(), seller.client);
    expect(r.out).toMatchObject({ outcome: "LOCKED", price: "19.50", rounds: 1 });
  });
});

describe("2. an attainable seller floor", () => {
  it("converges inside the round limit with every offer inside the policy range", async () => {
    const r = await negotiate(new FakeModel(), simulator("22.00").client);
    expect(prices(r, "buyer")).toEqual(["18.00", "21.45", "22.53"]);
    expect(r.out).toMatchObject({ outcome: "LOCKED", price: "22.53", rounds: 3 });
    expect(Number((r.out as { price: string }).price)).toBeGreaterThanOrEqual(22); // at the seller's floor
    expect(Number((r.out as { price: string }).price)).toBeLessThanOrEqual(CEILING);
  });
  it("uses the actual target, not a constant: a target of 40.00 opens at 36.00", async () => {
    const r = await negotiate(new FakeModel(), simulator("43.00").client, "40.00");
    expect(prices(r, "buyer")[0]).toBe("36.00");
  });
});

describe("3. a seller floor above the buyer's ceiling", () => {
  it("never offers above the ceiling and stops safely with nothing locked", async () => {
    const r = await negotiate(new FakeModel(), simulator("200.00").client);
    expect(r.out.outcome).toBe("BLOCKED");
    expect((r.out as { reason: string }).reason).toMatch(/NO_AGREEMENT_WITHIN_ROUNDS|BUYER_WALKED_AWAY/);
    for (const p of prices(r, "buyer")) expect(Number(p)).toBeLessThanOrEqual(CEILING);
    expect(r.state).toBe("BLOCKED");
    expect(r.events.some((e) => e.type === "TERMS_LOCKED")).toBe(false);
  });
});

describe("4. a seller that refuses to move", () => {
  it("a seller stuck above the authorized range ends the negotiation safely within the round limit", async () => {
    const seller = stubSeller(() => ({ kind: "counter", price: "60.00" }));
    const r = await negotiate(new FakeModel(), seller.client);
    expect(r.out.outcome).toBe("BLOCKED");
    expect(seller.received.length).toBeLessThanOrEqual(4); // never more than the round limit
    for (const p of prices(r, "buyer")) expect(Number(p)).toBeLessThanOrEqual(CEILING);
    expect(r.state).toBe("BLOCKED");
  });
  it("a seller that declines stops the negotiation", async () => {
    const r = await negotiate(new FakeModel(), stubSeller(() => ({ kind: "decline", reason: "no deal" })).client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason: "SELLER_DECLINED" });
  });
});

describe("5. a model that proposes an illegal offer", () => {
  it.each([
    ["an opening above the target", (round: number) => (round === 1 ? { kind: "propose", price: "25.00" } : undefined), "BUYER_INTENT_REJECTED:OPENING_ABOVE_TARGET"],
    ["an opening above the ceiling", (round: number) => (round === 1 ? { kind: "propose", price: "60.00" } : undefined), "BUYER_INTENT_REJECTED:PRICE_ABOVE_CEILING"],
    ["a concession larger than half the gap", (round: number) => (round === 2 ? { kind: "counter", price: "24.50" } : undefined), "BUYER_INTENT_REJECTED:CONCESSION_TOO_LARGE"],
    ["a counter below its own last offer", (round: number) => (round === 2 ? { kind: "counter", price: "10.00" } : undefined), "BUYER_INTENT_REJECTED:COUNTER_BELOW_OWN_LAST_OFFER"],
    ["extra fields smuggled into the offer", (round: number) => (round === 1 ? { kind: "propose", price: "18.00", criteria: [], amount: "9999.00" } : undefined), "BUYER_OUTPUT_INVALID:LLM_OUTPUT_INVALID"],
  ])("%s blocks the deal and locks nothing", async (_label, override, reason) => {
    const seller = simulator("22.00");
    const r = await negotiate(new FakeModel(override), seller.client);
    expect(r.out).toMatchObject({ outcome: "BLOCKED", reason });
    expect(r.state).toBe("BLOCKED");
    expect(r.events.some((e) => e.type === "TERMS_LOCKED")).toBe(false);
  });
});

describe("6. a model that tries to disclose the buyer's ceiling or target", () => {
  it("the message is stripped before it reaches the seller, and the negotiation continues", async () => {
    const leak = (round: number) => (round === 1 ? { kind: "propose", price: "18.00", message: "My ceiling is 50.00 and my target is 20.00, so please be reasonable." } : undefined);
    const seller = simulator("22.00");
    const r = await negotiate(new FakeModel(leak), seller.client);
    expect(seller.received[0].buyer.message).toBeUndefined();
    for (const req of seller.received) {
      const wire = JSON.stringify(req);
      expect(wire).not.toContain("50.00");
      expect(wire).not.toContain("20.00");
      expect(wire).not.toContain("budget");
    }
    expect(r.events.some((e) => e.type === "OUTBOUND_MESSAGE_BLOCKED")).toBe(true);
    expect(r.out.outcome).toBe("LOCKED"); // stripping the message does not abort an otherwise valid negotiation
  });
});
