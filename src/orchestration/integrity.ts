/**
 * Preflight run before the orchestrator takes ANY step on a deal. It re-establishes, from independent records, that what the deal
 * is running on is still what was approved:
 *   - the sealed mandate verifies, and is byte-identical to the one recorded when the deal was created (DEAL_CREATED event);
 *   - the locked terms still hash to the ORIGINAL hash recorded in the ledger at lock time (not merely to the deal's own columns);
 *   - the hash-chained ledger itself is intact.
 * Any failure HALTS the orchestrator for that deal (nothing is sent to the Settlement Engine). Halting never moves money.
 */
import type { PrismaClient } from "@prisma/client";
import { sha256Hex } from "../domain/canonical";
import { verifyChain } from "../domain/ledger";
import { openMandateRow } from "../domain/mandates";
import { authorizeLoadedDeal, type AuthorizationDeps } from "../domain/authorization";
import { termsMatchLockAny } from "../domain/terms-v2";

/** states in which a V2 deal may legitimately have no attestation yet (it is issued when the human approves) */
const PRE_APPROVAL_STATES = new Set<string>(["PROPOSED", "NEGOTIATING", "TERMS_LOCKED", "POLICY_CHECKED", "NEEDS_HUMAN", "BLOCKED"]);

/** a string field of a ledger payload, or undefined: the payload is JSON from the database, so nothing about it is assumed */
const stringField = (payload: unknown, key: string): string | undefined => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

export type IntegrityResult = { ok: true } | { ok: false; reason: "DEAL_NOT_FOUND" | "MANDATE_SEAL_INVALID" | "MANDATE_CHANGED" | "TERMS_CHANGED_AFTER_LOCK" | "LEDGER_BROKEN" | "AUTHORIZATION_INVALID"; detail?: string };

/** `keys`: the legacy V1 public key (string), or the full verification context (needed for V2 mandates and attestations). */
export async function checkIntegrity(db: PrismaClient, dealId: string, keys: string | AuthorizationDeps): Promise<IntegrityResult> {
  const deps: AuthorizationDeps = typeof keys === "string" ? { publicKeyB64: keys } : keys;
  const deal = await db.deal.findUnique({ where: { id: dealId }, include: { mandate: true, reservations: true, attestation: true } });
  if (!deal) return { ok: false, reason: "DEAL_NOT_FOUND" };

  const opened = openMandateRow(deal.mandate, deps);
  if (!opened) return { ok: false, reason: "MANDATE_SEAL_INVALID" };
  const created = await db.dealEvent.findFirst({ where: { dealId, type: "DEAL_CREATED" }, orderBy: { seq: "asc" } });
  const recorded = stringField(created?.payload, "mandateDigest");
  if (!recorded || recorded !== deal.mandate.mandateDigest || sha256Hex(deal.mandate.canonicalJson) !== recorded) return { ok: false, reason: "MANDATE_CHANGED" };

  if (deal.termsHash) {
    const lock = await db.dealEvent.findFirst({ where: { dealId, type: "STATE_TRANSITION", payload: { path: ["to"], equals: "TERMS_LOCKED" } }, orderBy: { seq: "asc" } });
    const originalHash = stringField(lock?.payload, "termsHash");
    if (!originalHash || originalHash !== deal.termsHash || !termsMatchLockAny(deal.termsJson, deal.termsHash)) return { ok: false, reason: "TERMS_CHANGED_AFTER_LOCK" };
  }

  // V2: the whole authorization (language policy floor, classification, TermsAttestation under the registry) must still hold. V1 integrity is unchanged.
  if (opened.version === 2 && deal.termsHash) {
    const a = authorizeLoadedDeal(deal, deps, { requireAttestation: deal.attestation !== null || !PRE_APPROVAL_STATES.has(deal.state) });
    if (!a.ok) return { ok: false, reason: "AUTHORIZATION_INVALID", detail: a.detail ? `${a.reason}:${a.detail}` : a.reason };
  }

  if (!(await verifyChain(db, dealId)).ok) return { ok: false, reason: "LEDGER_BROKEN" };
  return { ok: true };
}
