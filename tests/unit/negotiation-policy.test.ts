/** Pure bargaining policy (src/domain/negotiation-policy.ts) and the prompt text that carries its limits. No database, no model, no network. */
import { describe, expect, it } from "vitest";
import { buildBuyerUserPrompt, type BuyerContext } from "@/agents/buyer";
import { counterBounds, openingGuide, openingMax } from "@/domain/negotiation-policy";
import { parseMoney as M } from "@/domain/money";

describe("pure policy", () => {
  it("opening: at most the target, never above the ceiling; the suggested opening is below the target", () => {
    expect(openingMax(M("20.00"), M("50.00")).toFixed(2)).toBe("20.00");
    expect(openingMax(M("70.00"), M("50.00")).toFixed(2)).toBe("50.00");
    expect(openingGuide(M("20.00"), M("50.00")).toFixed(2)).toBe("18.00");
    expect(openingGuide(M("20.00"), M("50.00")).lt(M("20.00"))).toBe(true);
  });
  it("counter range: none without a seller ask; otherwise [own last offer, min(ceiling, ask, midpoint)]", () => {
    expect(counterBounds({ ceiling: M("50.00") })).toBeNull();
    const b = counterBounds({ ceiling: M("50.00"), lastBuyerPrice: M("20.00"), lastSellerPrice: M("25.59") })!;
    expect([b.min.toFixed(2), b.max.toFixed(2)]).toEqual(["20.00", "22.80"]); // 20 + 5.59/2 = 22.795 -> 22.80
    const capped = counterBounds({ ceiling: M("21.00"), lastBuyerPrice: M("20.00"), lastSellerPrice: M("40.00") })!;
    expect(capped.max.toFixed(2)).toBe("21.00"); // the ceiling beats the midpoint
    const low = counterBounds({ ceiling: M("50.00"), lastBuyerPrice: M("30.00"), lastSellerPrice: M("25.00") })!;
    expect([low.min.toFixed(2), low.max.toFixed(2)]).toEqual(["25.00", "25.00"]); // seller asks less than my offer: nothing to concede
  });
  it("the prompt tells the model its range, and tells it not to state amounts in the message", () => {
    const base: BuyerContext = { task: { description: "t", criteria: ["c"], deadline: "2029-01-01T00:00:00.000Z" }, targetPrice: "20.00", ceilingPrice: "50.00", round: 1, maxRounds: 4, history: [], canary: "C" };
    const open = buildBuyerUserPrompt({ ...base, limits: { kind: "opening", max: "20.00", suggested: "18.00" } });
    expect(open).toMatch(/opening price must be at most 20\.00/);
    expect(open).toMatch(/Do not write any dollar amount/);
    const counter = buildBuyerUserPrompt({ ...base, round: 2, history: [{ sender: "buyer", kind: "propose", price: "18.00" }, { sender: "seller", kind: "counter", price: "25.00" }], limits: { kind: "counter", min: "18.00", max: "21.50" } });
    expect(counter).toMatch(/between 18\.00 and 21\.50/);
  });
});
