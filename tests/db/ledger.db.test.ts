/** DB-tested against real PostgreSQL (mandate_test). No PayPal, no LLM. */
import { describe, expect, it } from "vitest";
import { appendEvent, verifyChain } from "@/domain/ledger";
import { createDeal } from "@/domain/deals";
import { keys, makeMandate, makePrincipal, prisma } from "./fixtures";

async function freshDeal() {
  const p = await makePrincipal();
  const m = await makeMandate(p);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  return deal;
}

describe("hash-chained ledger", () => {
  it("verifies an untouched chain and records the mandate seal in the first event", async () => {
    const d = await freshDeal();
    await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { n: 1 }));
    await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { n: 2 }));
    const v = await verifyChain(prisma, d.id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.length).toBe(3);
    const first = await prisma.dealEvent.findFirstOrThrow({ where: { dealId: d.id, seq: 1 } });
    expect(first.type).toBe("DEAL_CREATED");
    expect(first.payload).toMatchObject({ mandateDigest: expect.any(String), approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION", keyVersion: "v1" });
  });

  it("detects an edited payload at the exact seq", async () => {
    const d = await freshDeal();
    for (let i = 0; i < 3; i++) await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { i }));
    await prisma.dealEvent.updateMany({ where: { dealId: d.id, seq: 3 }, data: { payload: { i: 999 } } });
    expect(await verifyChain(prisma, d.id)).toEqual({ ok: false, brokenAtSeq: 3, reason: "HASH_MISMATCH" });
  });

  it("detects an edited actor, type and timestamp", async () => {
    for (const data of [{ actor: "mallory" }, { type: "OTHER" }, { createdAt: new Date("2020-01-01T00:00:00Z") }]) {
      const d = await freshDeal();
      await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", {}));
      await prisma.dealEvent.updateMany({ where: { dealId: d.id, seq: 2 }, data });
      const v = await verifyChain(prisma, d.id);
      expect(v.ok, JSON.stringify(data)).toBe(false);
      if (!v.ok) expect(v.brokenAtSeq).toBe(2);
    }
  });

  it("detects a deleted middle event and a rewritten prevHash", async () => {
    const d = await freshDeal();
    for (let i = 0; i < 3; i++) await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { i }));
    await prisma.dealEvent.deleteMany({ where: { dealId: d.id, seq: 2 } });
    expect(await verifyChain(prisma, d.id)).toMatchObject({ ok: false, brokenAtSeq: 2, reason: "SEQ_GAP" });

    const d2 = await freshDeal();
    await prisma.$transaction((tx) => appendEvent(tx, d2.id, "NOTE", "test", {}));
    await prisma.dealEvent.updateMany({ where: { dealId: d2.id, seq: 2 }, data: { prevHash: "f".repeat(64) } });
    expect(await verifyChain(prisma, d2.id)).toMatchObject({ ok: false, brokenAtSeq: 2, reason: "PREV_HASH_MISMATCH" });
  });

  it("concurrent appends never fork or duplicate seq (locked allocation)", async () => {
    const d = await freshDeal();
    await Promise.all(Array.from({ length: 25 }, (_, i) => prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", `w${i}`, { i }))));
    const events = await prisma.dealEvent.findMany({ where: { dealId: d.id }, orderBy: { seq: "asc" } });
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(await verifyChain(prisma, d.id)).toMatchObject({ ok: true, length: 26 });
  });

  it("redacts secret-looking keys and rejects non-canonical payloads", async () => {
    const d = await freshDeal();
    const e = await prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { access_token: "abc", client_secret: "x", ok: "fine", nested: { apiKey: "k" } }));
    expect(e.payload).toEqual({ access_token: "[REDACTED]", client_secret: "[REDACTED]", ok: "fine", nested: { apiKey: "[REDACTED]" } });
    await expect(prisma.$transaction((tx) => appendEvent(tx, d.id, "NOTE", "test", { price: 1.5 }))).rejects.toThrow(/safe integers/);
    expect(await verifyChain(prisma, d.id)).toMatchObject({ ok: true });
  });

  it("refuses to append to a deal that does not exist", async () => {
    await expect(prisma.$transaction((tx) => appendEvent(tx, "nope", "NOTE", "t", {}))).rejects.toThrow(/not found/);
  });
});
