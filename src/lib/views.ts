/** JSON views returned by the demo API. Only fields the principal needs; never keys, signatures, canonical JSON or PayPal identifiers beyond the buyer's approval link. */
import type { Deal, DealEvent, Mandate } from "@prisma/client";
import { readLockedTerms } from "@/domain/terms-v2";

export const mandateView = (m: Mandate, sealVerified: boolean) => ({
  id: m.id,
  currency: m.currency,
  budgetTotal: m.budgetTotal.toString(),
  perDealMax: m.perDealMax.toString(),
  requireHumanAbove: m.requireHumanAbove?.toString() ?? null,
  allowedTaskTypes: m.allowedTaskTypes,
  counterparties: m.counterparties,
  injectionPolicy: m.injectionPolicy,
  expiresAt: m.expiresAt.toISOString(),
  revokedAt: m.revokedAt?.toISOString() ?? null,
  approvedBy: m.approvedBy,
  approvedAt: m.approvedAt.toISOString(),
  digest: m.mandateDigest,
  keyVersion: m.keyVersion,
  sealVerified,
});

/** the locked terms, read ONLY through the version dispatcher (never the raw stored JSON); a V2 or unreadable document is shown as null */
const termsSummary = (deal: Deal) => {
  const lt = readLockedTerms(deal.termsJson);
  if (!lt.ok || lt.version !== 1) return null;
  const t = lt.terms;
  return { taskType: t.taskType, description: t.description, price: t.price, currency: t.currency, deadline: t.deadline, sellerId: t.sellerId, criteria: t.criteria.map((c) => ({ id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight })) };
};

export const dealView = (deal: Deal) => {
  const d = deal;
  return {
  id: d.id,
  mandateId: d.mandateId,
  state: d.state,
  sellerId: d.sellerId,
  price: d.price?.toString() ?? null,
  termsHash: d.termsHash,
  terms: termsSummary(deal),
  paypalOrderId: d.paypalOrderId,
  paypalAuthId: d.paypalAuthId,
  paypalAuthStatus: d.paypalAuthStatus,
  approvalUrl: d.approvalUrl,
  capturedAmount: d.capturedAmount?.toString() ?? null,
  deadline: d.deadline?.toISOString() ?? null,
  /** display only: the server's recorded end of the challenge window and of a pending review (the engine, not the browser, decides what happens at those times) */
  challengeWindowEndsAt: d.challengeWindowEndsAt?.toISOString() ?? null,
  reviewDeadline: d.reviewDeadline?.toISOString() ?? null,
  needsHumanReason: d.needsHumanReason,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  };
};

export const eventView = (e: DealEvent) => ({ seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, createdAt: e.createdAt.toISOString() });
