/** Delivery ingestion: DB-tested on real PostgreSQL against a MOCKED PayPal. No Sandbox calls. */
import { describe, expect, it } from "vitest";
import { verifyChain } from "@/domain/ledger";
import { submitDelivery } from "@/verification/delivery";
import { policyCheckedDeal } from "./engineFixtures";
import { GOOD, HEADERS, GOOD_ROWS, awaitingDelivery, csvBytes, deliver, manifestFor, prisma, sha256 } from "./deliveryFixtures";

const deliveryCount = (dealId: string) => prisma.delivery.count({ where: { dealId } });
const events = (dealId: string, type: string) => prisma.dealEvent.findMany({ where: { dealId, type }, orderBy: { seq: "asc" } });

describe("a valid delivery", () => {
  it("is stored with hashes and provenance, moves the deal to DELIVERED, and is ledgered", async () => {
    const { base, deal } = await awaitingDelivery();
    const art = GOOD();
    const r = await deliver(base.dealId, art);
    expect(r).toMatchObject({ ok: true, idempotent: false, rowCount: 5, columnCount: 3 });
    const row = await prisma.delivery.findUniqueOrThrow({ where: { dealId: base.dealId } });
    expect(row).toMatchObject({ artifactSha256: sha256(art), artifactSize: art.length, mediaType: "text/csv", artifactReference: "cleaned.csv", sellerPrincipalId: "seller-sim", termsHash: deal.termsHash, parserVersion: "csv-strict-1" });
    expect(Buffer.from(row.artifactText, "utf8").equals(art)).toBe(true); // lossless: the stored text hashes to the stored hash
    expect(row.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } })).state).toBe("DELIVERED");
    const ev = (await events(base.dealId, "DELIVERY_RECEIVED"))[0]!;
    expect(ev.payload).toMatchObject({ artifactSha256: sha256(art), rowCount: 5, parserVersion: "csv-strict-1" });
    expect(JSON.stringify(ev.payload)).not.toContain("a@x.com"); // content is not copied into the ledger
    expect(await verifyChain(prisma, base.dealId)).toMatchObject({ ok: true });
  });
});

describe("rejected deliveries leave the deal untouched and are ledgered by CODE only", () => {
  const cases: [string, string, (deal: { id: string; termsHash: string | null }) => Parameters<typeof deliver>[2] & { artifact?: Buffer }][] = [
    ["an incorrect deal id in the manifest", "DEAL_ID_MISMATCH", () => ({ manifest: { dealId: "someone-elses-deal" } })],
    ["an incorrect terms hash", "TERMS_HASH_MISMATCH", () => ({ manifest: { termsHash: "0".repeat(64) } })],
    ["a wrong seller in the manifest", "SELLER_MISMATCH", () => ({ manifest: { sellerPrincipalId: "mallory" } })],
    ["an authenticated identity that is not the locked seller", "SELLER_MISMATCH", () => ({ seller: "mallory" })],
    ["an oversized artifact", "ARTIFACT_TOO_LARGE", () => ({ deps: { maxArtifactBytes: 50 } })],
    ["a wrong declared size", "ARTIFACT_SIZE_MISMATCH", () => ({ manifest: { artifactSize: 5 } })],
    ["a tampered file (hash does not match)", "ARTIFACT_HASH_MISMATCH", () => ({ manifest: { artifactSha256: "f".repeat(64) } })],
    // the manifest claims a real file (size + hash of GOOD) but no bytes arrive
    ["a missing artifact", "ARTIFACT_MISSING", () => ({ artifact: Buffer.alloc(0), manifest: { artifactSha256: sha256(GOOD()), artifactSize: GOOD().length } })],
    ["a ragged (malformed) CSV", "CSV_RAGGED_ROW", () => ({ artifact: Buffer.from("id,email\n1\n", "utf8") })],
    ["an unterminated quote", "CSV_UNTERMINATED_QUOTE", () => ({ artifact: Buffer.from('id,email\n1,"oops\n', "utf8") })],
    ["invalid UTF-8 bytes", "CSV_INVALID_UTF8", () => ({ artifact: Buffer.from([0x69, 0x64, 0x0a, 0xff, 0xfe, 0x0a]) })],
    ["a ZIP/XLSX file labelled text/csv", "UNSUPPORTED_FORMAT", () => ({ artifact: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("id,email\n1,a\n")]) })],
    ["a script labelled text/csv", "UNSUPPORTED_FORMAT", () => ({ artifact: Buffer.from("#!/bin/sh\nrm -rf /\n") })],
    ["too many rows", "CSV_TOO_MANY_ROWS", () => ({ deps: { limits: { maxRows: 3, maxColumns: 10, maxFieldLength: 100 } } })],
    ["a path-traversal artifact reference", "MANIFEST_INVALID", () => ({ manifest: { artifactReference: "../../etc/passwd" } })],
    ["a windows path artifact reference", "MANIFEST_INVALID", () => ({ manifest: { artifactReference: "C:\\Windows\\system32\\cmd.exe" } })],
    ["an unsupported media type", "MANIFEST_INVALID", () => ({ manifest: { mediaType: "application/zip" } })],
    ["a manifest that tries to replace the acceptance criteria", "MANIFEST_INVALID", () => ({ manifest: { criteria: [{ id: "all", type: "llm_judged" }] } })],
    ["a manifest that tries to set a price", "MANIFEST_INVALID", () => ({ manifest: { price: "999.00" } })],
    ["a missing manifest", "MANIFEST_INVALID", () => ({ manifest: null })],
    ["a delivery after the deadline", "DELIVERY_AFTER_DEADLINE", () => ({ deps: { now: () => new Date("2031-01-01T00:00:00Z") }, manifest: { submittedAt: "2030-01-01T00:00:00.000Z" } })],
    ["a timestamp in the future", "TIMESTAMP_IN_FUTURE", () => ({ manifest: { submittedAt: new Date(Date.now() + 86_400_000).toISOString() } })],
  ];
  it.each(cases)("%s -> %s", async (_name, expected, build) => {
    const { base, deal } = await awaitingDelivery();
    const o = build(deal);
    const r = await deliver(base.dealId, o.artifact ?? GOOD(), o);
    expect(r).toEqual({ ok: false, code: expected });
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } })).state).toBe("AWAITING_DELIVERY");
    expect(await deliveryCount(base.dealId)).toBe(0);
    const ev = await events(base.dealId, "DELIVERY_REJECTED");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ code: expected });
  });

  it("a delivery for a deal that is not awaiting delivery, or does not exist", async () => {
    const early = await policyCheckedDeal();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: early.dealId } });
    expect(await deliver(early.dealId, GOOD(), { manifest: manifestFor(deal, GOOD()) })).toEqual({ ok: false, code: "STATE_POLICY_CHECKED" });
    expect(await submitDelivery({ db: prisma }, { dealId: "nonexistent-deal", authenticatedSellerId: "seller-sim", manifest: {}, artifact: GOOD() })).toEqual({ ok: false, code: "DEAL_NOT_FOUND" });
  });

  it("the locked terms are never touched by a rejected or an accepted delivery", async () => {
    const { base, deal } = await awaitingDelivery();
    await deliver(base.dealId, GOOD(), { manifest: { criteria: [] } });
    await deliver(base.dealId, GOOD());
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } });
    expect(after.termsHash).toBe(deal.termsHash);
    expect(after.termsJson).toEqual(deal.termsJson);
    expect(after.price?.toString()).toBe(deal.price?.toString());
  });
});

describe("duplicate deliveries", () => {
  it("an identical resubmission is idempotent: same delivery, no second state change, no second ledger entry", async () => {
    const { base } = await awaitingDelivery();
    const art = GOOD();
    const manifest = manifestFor(await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } }), art);
    const a = await deliver(base.dealId, art, { manifest });
    const b = await deliver(base.dealId, art, { manifest });
    expect(a).toMatchObject({ ok: true, idempotent: false });
    expect(b).toMatchObject({ ok: true, idempotent: true, deliveryId: (a as { deliveryId: string }).deliveryId, rowCount: 5 });
    expect(await events(base.dealId, "DELIVERY_RECEIVED")).toHaveLength(1);
    expect(await deliveryCount(base.dealId)).toBe(1);
  });

  it("a DIFFERENT second delivery is refused and the first one stands", async () => {
    const { base } = await awaitingDelivery();
    const first = GOOD();
    await deliver(base.dealId, first);
    const second = csvBytes(HEADERS, [...GOOD_ROWS, ["6", "f@x.com", "2024-05-01"]]);
    expect(await deliver(base.dealId, second)).toEqual({ ok: false, code: "DUPLICATE_DELIVERY" });
    expect((await prisma.delivery.findUniqueOrThrow({ where: { dealId: base.dealId } })).artifactSha256).toBe(sha256(first));
  });

  it("5 concurrent identical submissions create exactly one delivery; 2 concurrent different ones accept exactly one", async () => {
    const a = await awaitingDelivery();
    const art = GOOD();
    const manifest = manifestFor(a.deal, art);
    const out = await Promise.all(Array.from({ length: 5 }, () => deliver(a.base.dealId, art, { manifest })));
    expect(out.every((r) => r.ok)).toBe(true);
    expect(out.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
    expect(await deliveryCount(a.base.dealId)).toBe(1);
    expect(await events(a.base.dealId, "DELIVERY_RECEIVED")).toHaveLength(1);

    const b = await awaitingDelivery();
    const x = csvBytes(HEADERS, GOOD_ROWS);
    const y = csvBytes(HEADERS, GOOD_ROWS.slice(0, 3));
    const two = await Promise.all([deliver(b.base.dealId, x), deliver(b.base.dealId, y)]);
    expect(two.filter((r) => r.ok)).toHaveLength(1);
    expect(two.filter((r) => !r.ok)[0]).toEqual({ ok: false, code: "DUPLICATE_DELIVERY" });
    expect(await deliveryCount(b.base.dealId)).toBe(1);
    expect(await verifyChain(prisma, b.base.dealId)).toMatchObject({ ok: true });
  });
});

describe("stored deliveries are immutable at the database level", () => {
  it("UPDATE and DELETE on a delivery are refused by the database itself", async () => {
    const { base } = await awaitingDelivery();
    await deliver(base.dealId, GOOD());
    await expect(prisma.delivery.update({ where: { dealId: base.dealId }, data: { artifactText: "id\n1\n" } })).rejects.toThrow(/immutable/);
    await expect(prisma.delivery.update({ where: { dealId: base.dealId }, data: { artifactSha256: "0".repeat(64) } })).rejects.toThrow(/immutable/);
    await expect(prisma.delivery.delete({ where: { dealId: base.dealId } })).rejects.toThrow(/immutable/);
    expect((await prisma.delivery.findUniqueOrThrow({ where: { dealId: base.dealId } })).artifactSha256).toBe(sha256(GOOD()));
  });
});
