import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalJson, sha256Hex } from "./canonical";

export type Tx = Prisma.TransactionClient;
export const GENESIS_HASH = "0".repeat(64);

const SECRET_KEY_RE = /secret|token|password|authorization|api[_-]?key|private|signature_key|cookie/i;

/** Remove secret-looking keys and reject anything canonical hashing cannot represent. */
export function sanitizeForLedger(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("ledger payload too deep");
  if (Array.isArray(value)) return value.map((v) => sanitizeForLedger(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, SECRET_KEY_RE.test(k) ? "[REDACTED]" : sanitizeForLedger(v, depth + 1)]),
    );
  }
  return value;
}

export interface HashInput {
  dealId: string;
  seq: number;
  type: string;
  actor: string;
  payload: unknown;
  createdAt: string; // ISO, ms precision
}

export const eventHash = (prevHash: string, e: HashInput): string => sha256Hex(prevHash + canonicalJson(e));

/**
 * Append one event. MUST run inside a transaction: the Deal row is locked (FOR UPDATE) so concurrent
 * writers serialize and cannot fork the chain. The unique (dealId, seq) index is the backstop.
 */
export async function appendEvent(tx: Tx, dealId: string, type: string, actor: string, payload: unknown = {}) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Deal" WHERE id = ${dealId} FOR UPDATE`;
  if (locked.length === 0) throw new Error(`appendEvent: deal ${dealId} not found`);
  const last = await tx.dealEvent.findFirst({ where: { dealId }, orderBy: { seq: "desc" } });
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const createdAt = new Date();
  const clean = sanitizeForLedger(payload);
  const hash = eventHash(prevHash, { dealId, seq, type, actor, payload: clean, createdAt: createdAt.toISOString() });
  return tx.dealEvent.create({
    data: { dealId, seq, type, actor, payload: clean as Prisma.InputJsonValue, prevHash, hash, createdAt },
  });
}

export type ChainVerification =
  | { ok: true; length: number; headHash: string }
  | { ok: false; brokenAtSeq: number; reason: "SEQ_GAP" | "PREV_HASH_MISMATCH" | "HASH_MISMATCH" };

/**
 * Recompute the whole chain. Detects edits, reordering and mid-chain deletions.
 * Tamper-EVIDENT, not tamper-proof: truncating the tail, or rewriting every row, is only caught
 * if a previously published head hash is compared.
 */
export async function verifyChain(db: PrismaClient | Tx, dealId: string): Promise<ChainVerification> {
  const events = await db.dealEvent.findMany({ where: { dealId }, orderBy: { seq: "asc" } });
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of events) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq, reason: "SEQ_GAP" };
    if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: "PREV_HASH_MISMATCH" };
    const h = eventHash(prev, {
      dealId: e.dealId,
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    });
    if (h !== e.hash) return { ok: false, brokenAtSeq: e.seq, reason: "HASH_MISMATCH" };
    prev = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, length: events.length, headHash: prev };
}
