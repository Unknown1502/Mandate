/** DB-tested against real PostgreSQL (mandate_test). No PayPal, no LLM. */
import { describe, expect, it } from "vitest";
import { ConfirmationMismatchError, NotFoundError, approveMandate, previewMandate } from "@/domain/mandates";
import { ForbiddenError, StaleStateError, beginNegotiation, checkPolicy, createDeal, lockTerms, reserveForDeal, resolvePreAuthReview, transitionDeal } from "@/domain/deals";
import { IllegalTransitionError } from "@/domain/statemachine";
import { verifyChain } from "@/domain/ledger";
import { deps, dealWithLockedTerms, keys, makeMandate, makePrincipal, prisma, termsFor } from "./fixtures";

describe("mandate approval", () => {
  it("requires the human to echo the exact digest of the previewed document", async () => {
    const p = await makePrincipal();
    const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], expiresAt: "2030-01-01T00:00:00.000Z" };
    await expect(approveMandate(prisma, { principalId: p.id, principalEmail: p.email, draft, confirmDigest: "0".repeat(64), keys })).rejects.toBeInstanceOf(ConfirmationMismatchError);
    // A digest from a DIFFERENT draft (budget changed after preview) is also refused.
    const { digest } = previewMandate(p.id, draft);
    await expect(approveMandate(prisma, { principalId: p.id, principalEmail: p.email, draft: { ...draft, budgetTotal: "5000" }, confirmDigest: digest, keys })).rejects.toBeInstanceOf(ConfirmationMismatchError);
    expect(await prisma.mandate.count({ where: { principalId: p.id } })).toBe(0);
  });

  it("persists a sealed mandate; later tampering with the sealed bytes is detected at deal creation", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    expect(m.approvalMethod).toBe("EXPLICIT_DIGEST_CONFIRMATION");
    await expect(createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 })).resolves.toBeTruthy();
    const forged = m.canonicalJson.replace('"budgetTotal":"100.00"', '"budgetTotal":"999999.00"');
    await prisma.mandate.update({ where: { id: m.id }, data: { canonicalJson: forged } });
    await expect(createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("limits come from the SEALED document, not from editable columns", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p, { budgetTotal: "30", perDealMax: "30", requireHumanAbove: undefined });
    await prisma.mandate.update({ where: { id: m.id }, data: { budgetTotal: "1000000" } }); // attacker edits the column
    const deal = await dealWithLockedTerms(p, m.id, { price: "25.00" });
    const second = await dealWithLockedTerms(p, m.id, { price: "25.00" });
    expect((await checkPolicy(prisma, { dealId: deal.id, deps })).outcome).toBe("OK");
    expect(await reserveForDeal(prisma, { dealId: deal.id, deps })).toMatchObject({ ok: true });
    await checkPolicy(prisma, { dealId: second.id, deps }).then((r) => expect(r.outcome).toBe("BLOCKED")); // 25 + 25 > sealed 30
  });
});

describe("ownership", () => {
  it("another principal cannot create deals on, or act on, a mandate or deal they do not own (no existence leak)", async () => {
    const owner = await makePrincipal();
    const intruder = await makePrincipal();
    const m = await makeMandate(owner);
    await expect(createDeal(prisma, { principalId: intruder.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 })).rejects.toBeInstanceOf(NotFoundError);
    const d = await dealWithLockedTerms(owner, m.id);
    await expect(checkPolicy(prisma, { dealId: d.id, deps, principalId: intruder.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reserveForDeal(prisma, { dealId: d.id, deps, principalId: intruder.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolvePreAuthReview(prisma, { dealId: d.id, principalId: intruder.id, principalEmail: "x", decision: "approve", deps })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("terms lock and policy", () => {
  it("rejects terms for another mandate or seller", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
    await beginNegotiation(prisma, deal.id, "buyer", p.id);
    await expect(lockTerms(prisma, { dealId: deal.id, terms: termsFor("other-mandate"), actor: "buyer", principalId: p.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(lockTerms(prisma, { dealId: deal.id, terms: termsFor(m.id, { sellerId: "someone-else" }), actor: "buyer", principalId: p.id })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("terms cannot be locked twice or changed after the lock", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const d = await dealWithLockedTerms(p, m.id);
    await expect(lockTerms(prisma, { dealId: d.id, terms: termsFor(m.id, { price: "1.00" }), actor: "seller", principalId: p.id })).rejects.toBeInstanceOf(IllegalTransitionError);
    const row = await prisma.deal.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.price?.toString()).toBe("20");
  });

  it("price drift after lock (DB edit) is BLOCKED with TERMS_DRIFT and recorded", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const d = await dealWithLockedTerms(p, m.id);
    const row = await prisma.deal.findUniqueOrThrow({ where: { id: d.id } });
    await prisma.deal.update({ where: { id: d.id }, data: { termsJson: { ...(row.termsJson as object), price: "55.00" } } });
    const r = await checkPolicy(prisma, { dealId: d.id, deps });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons).toContain("TERMS_DRIFT");
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).state).toBe("BLOCKED");
    expect(await verifyChain(prisma, d.id)).toMatchObject({ ok: true });
  });

  it("a compliant deal passes policy, and every transition is in the ledger", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const d = await dealWithLockedTerms(p, m.id);
    expect((await checkPolicy(prisma, { dealId: d.id, deps })).outcome).toBe("OK");
    const types = (await prisma.dealEvent.findMany({ where: { dealId: d.id }, orderBy: { seq: "asc" } })).map((e) => `${e.type}:${(e.payload as { to?: string }).to ?? ""}`);
    expect(types).toEqual(["DEAL_CREATED:", "STATE_TRANSITION:NEGOTIATING", "STATE_TRANSITION:TERMS_LOCKED", "STATE_TRANSITION:POLICY_CHECKED"]);
  });

  it("replayed or concurrent transitions: exactly one wins, the chain stays valid", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const d = await dealWithLockedTerms(p, m.id);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => prisma.$transaction((tx) => transitionDeal(tx, d.id, "POLICY_CHECKED", "racer"))));
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    for (const a of attempts.filter((x) => x.status === "rejected")) {
      const err = (a as PromiseRejectedResult).reason;
      expect(err instanceof StaleStateError || err instanceof IllegalTransitionError).toBe(true);
    }
    expect(await verifyChain(prisma, d.id)).toMatchObject({ ok: true });
  });

  it("a terminal deal cannot be revived", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const d = await dealWithLockedTerms(p, m.id);
    await prisma.$transaction((tx) => transitionDeal(tx, d.id, "BLOCKED", "test"));
    await expect(prisma.$transaction((tx) => transitionDeal(tx, d.id, "POLICY_CHECKED", "test"))).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe("pre-authorization human review", () => {
  async function dealNeedingHuman(budget = "100") {
    const p = await makePrincipal();
    const m = await makeMandate(p, { budgetTotal: budget, perDealMax: "60", requireHumanAbove: "30" });
    const d = await dealWithLockedTerms(p, m.id, { price: "45.00" });
    const r = await checkPolicy(prisma, { dealId: d.id, deps });
    return { p, m, d, r };
  }

  it("price above the human threshold stops at NEEDS_HUMAN with its origin, and reserves nothing", async () => {
    const { d, r } = await dealNeedingHuman();
    expect(r).toEqual({ outcome: "NEEDS_HUMAN", reasons: ["PRICE_ABOVE_HUMAN_THRESHOLD"] });
    const row = await prisma.deal.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.state).toBe("NEEDS_HUMAN");
    expect(row.needsHumanFrom).toBe("POLICY_CHECKED");
    expect(await prisma.budgetReservation.count({ where: { dealId: d.id } })).toBe(0);
    // Without a human decision the budget cannot be reserved, so no PayPal order may be created.
    expect(await reserveForDeal(prisma, { dealId: d.id, deps })).toMatchObject({ ok: false });
  });

  it("approve: records the human decision and reserves the budget; reject: BLOCKED", async () => {
    const a = await dealNeedingHuman();
    const ok = await resolvePreAuthReview(prisma, { dealId: a.d.id, principalId: a.p.id, principalEmail: a.p.email, decision: "approve", deps });
    expect(ok).toMatchObject({ ok: true });
    expect(await prisma.budgetReservation.findUnique({ where: { dealId: a.d.id } })).toMatchObject({ status: "ACTIVE" });
    const ev = await prisma.dealEvent.findFirstOrThrow({ where: { dealId: a.d.id, type: "HUMAN_REVIEW_DECISION" } });
    expect(ev.actor).toBe(`human:${a.p.email}`);
    expect(ev.payload).toEqual({ phase: "PRE_AUTH", decision: "approve" }); // no amounts in a human decision

    const b = await dealNeedingHuman();
    await resolvePreAuthReview(prisma, { dealId: b.d.id, principalId: b.p.id, principalEmail: b.p.email, decision: "reject", deps });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: b.d.id } })).state).toBe("BLOCKED");
    expect(await prisma.budgetReservation.count({ where: { dealId: b.d.id } })).toBe(0);
  });

  it("human approval cannot override a hard policy failure (budget)", async () => {
    const p = await makePrincipal();
    const m = await makeMandate(p, { budgetTotal: "60", perDealMax: "60", requireHumanAbove: "30" });
    const first = await dealWithLockedTerms(p, m.id, { price: "40.00" });
    const second = await dealWithLockedTerms(p, m.id, { price: "40.00" });
    await checkPolicy(prisma, { dealId: first.id, deps }); // NEEDS_HUMAN (40 > 30)
    await resolvePreAuthReview(prisma, { dealId: first.id, principalId: p.id, principalEmail: p.email, decision: "approve", deps });
    const r = await checkPolicy(prisma, { dealId: second.id, deps });
    expect(r.outcome).toBe("BLOCKED");
    expect(r.reasons).toContain("BUDGET_EXCEEDED");
  });

  it("a review cannot be resolved twice", async () => {
    const a = await dealNeedingHuman();
    await resolvePreAuthReview(prisma, { dealId: a.d.id, principalId: a.p.id, principalEmail: a.p.email, decision: "reject", deps });
    await expect(resolvePreAuthReview(prisma, { dealId: a.d.id, principalId: a.p.id, principalEmail: a.p.email, decision: "approve", deps })).rejects.toBeInstanceOf(StaleStateError);
  });
});
