import { Prisma, type PrismaClient } from "@prisma/client";
import { committedFor, lockMandate, reserve } from "./budget";
import { appendEvent, type Tx } from "./ledger";
import { openMandateRow, NotFoundError } from "./mandates";
import { authorizeLoadedDeal } from "./authorization";
import type { KeyRegistry } from "./key-registry";
import type { V2GateOpen } from "./v2-release-gate";
import { strictnessFailures, type LanguagePolicy } from "./language-policy";
import { hasLlmCriteria, languagePolicyHashOf, normalizeTermsV2, termsHashV2, termsV2Schema, validateTermsV2 } from "./terms-v2";
import { D, parseMoney } from "./money";
import { evaluatePolicy, type PolicyResult } from "./policy";
import { assertTransition, type DealState } from "./statemachine";
import { normalizeTerms, termsHash, termsSchema } from "./terms";

export class StaleStateError extends Error {}
export class ForbiddenError extends Error {}

export interface PolicyDeps {
  publicKeyB64: string;
  maxRounds: number;
  now?: Date;
  /** V2 seals and attestations resolve keys ONLY here; without it no V2 mandate verifies (fail closed) */
  registry?: KeyRegistry;
  /** the V2 release gate: without it no V2 mandate opens (fail closed) */
  v2Gate?: V2GateOpen;
  /** docs/15 Q5 (unresolved): cap on distinct model groups per deal; defaults to 1 */
  modelGroupCap?: number;
  /** docs/15 Q3 (unresolved): deployment switch for V2 LLM-judged criteria; defaults to OFF */
  llmCriteriaEnabled?: boolean;
  /** P7: only a released, non-revoked detector may be pinned by V2 LLM terms */
  detectorPermitted?: (d: LanguagePolicy["detector"], supported?: readonly string[]) => boolean;
}

/** Ownership check that does not reveal whether another principal's deal exists. */
async function loadOwnedDeal(tx: Tx, dealId: string, principalId?: string) {
  const deal = await tx.deal.findUnique({ where: { id: dealId }, include: { mandate: true } });
  if (!deal || (principalId !== undefined && deal.mandate.principalId !== principalId)) throw new NotFoundError("Deal not found");
  return deal;
}

/**
 * The ONLY way a deal's state changes: validates the transition table, applies it with a compare-and-set on
 * the current state (replays/races fail with StaleStateError), and appends the ledger event in the same transaction.
 */
export async function transitionDeal(
  tx: Tx,
  dealId: string,
  to: DealState,
  actor: string,
  payload: Record<string, unknown> = {},
  data: Prisma.DealUncheckedUpdateManyInput = {},
): Promise<void> {
  const deal = await tx.deal.findUniqueOrThrow({ where: { id: dealId } });
  const from = deal.state as DealState;
  assertTransition(from, to, { needsHumanFrom: deal.needsHumanFrom as DealState | null });
  const origin =
    to === "NEEDS_HUMAN"
      ? { needsHumanFrom: from, needsHumanReason: typeof payload.reason === "string" ? payload.reason : null }
      : from === "NEEDS_HUMAN"
        ? { needsHumanFrom: null, needsHumanReason: null }
        : {};
  const r = await tx.deal.updateMany({ where: { id: dealId, state: from }, data: { state: to, ...origin, ...data } });
  if (r.count !== 1) throw new StaleStateError(`Deal ${dealId} is no longer in state ${from}`);
  await appendEvent(tx, dealId, "STATE_TRANSITION", actor, { from, to, ...payload });
}

export async function createDeal(
  db: PrismaClient,
  p: { principalId: string; mandateId: string; sellerId: string; publicKeyB64: string; registry?: KeyRegistry; v2Gate?: V2GateOpen },
) {
  return db.$transaction(async (tx) => {
    const mandate = await tx.mandate.findUnique({ where: { id: p.mandateId } });
    if (!mandate || mandate.principalId !== p.principalId) throw new NotFoundError("Mandate not found");
    const opened = openMandateRow(mandate, { publicKeyB64: p.publicKeyB64, registry: p.registry, v2Gate: p.v2Gate });
    if (!opened) throw new ForbiddenError("Mandate seal does not verify");
    const deal = await tx.deal.create({ data: { mandateId: p.mandateId, sellerId: p.sellerId } });
    await appendEvent(tx, deal.id, "DEAL_CREATED", `principal:${p.principalId}`, {
      mandateId: mandate.id,
      mandateDigest: mandate.mandateDigest,
      approvedBy: mandate.approvedBy,
      approvedAt: mandate.approvedAt.toISOString(),
      approvalMethod: mandate.approvalMethod,
      keyVersion: mandate.keyVersion,
      sellerId: p.sellerId,
      mandateSchemaVersion: opened.version,
    });
    return deal;
  });
}

export async function beginNegotiation(db: PrismaClient, dealId: string, actor: string, principalId?: string) {
  await db.$transaction(async (tx) => {
    await loadOwnedDeal(tx, dealId, principalId);
    await transitionDeal(tx, dealId, "NEGOTIATING", actor);
  });
}

/** Lock terms: validates, normalizes, hashes, stores price/deadline. After this any change is drift => BLOCKED. */
const isObjectWithVersion = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "schemaVersion");

export async function lockTerms(db: PrismaClient, p: { dealId: string; terms: unknown; actor: string; principalId?: string; deps?: PolicyDeps }) {
  if (isObjectWithVersion(p.terms)) return lockTermsV2(db, p);
  const terms = normalizeTerms(termsSchema.parse(p.terms));
  const hash = termsHash(terms);
  await db.$transaction(async (tx) => {
    const deal = await loadOwnedDeal(tx, p.dealId, p.principalId);
    if (terms.mandateId !== deal.mandateId || terms.sellerId !== deal.sellerId) throw new ForbiddenError("Terms do not match the deal's mandate/seller");
    // a V2 mandate cannot carry V1 terms: that would route around its signed language policy (only checkable when the caller supplies the verification context)
    if (p.deps) {
      const opened = openMandateRow(deal.mandate, p.deps);
      if (opened?.version === 2) throw new ForbiddenError("A V2 mandate requires V2 terms");
    }
    await transitionDeal(tx, p.dealId, "TERMS_LOCKED", p.actor, { termsHash: hash, price: terms.price }, {
      termsJson: terms as unknown as Prisma.InputJsonValue,
      termsHash: hash,
      price: terms.price,
      deadline: new Date(terms.deadline),
    });
    await tx.termsVersion.create({ data: { dealId: p.dealId, version: 1, termsSchemaVersion: 1, termsHash: hash, termsJson: terms as unknown as Prisma.InputJsonValue, lockedBy: p.actor } });
  });
  return hash;
}

/** V2: strict schema, full semantic validation (classification, bijection, group cap), mandate binding and language-policy floor, all before anything is hashed or stored. */
async function lockTermsV2(db: PrismaClient, p: { dealId: string; terms: unknown; actor: string; principalId?: string; deps?: PolicyDeps }) {
  if (!p.deps) throw new ForbiddenError("V2 terms can only be locked with the verification context (keys/registry)");
  const deps = p.deps;
  const parsed = normalizeTermsV2(termsV2Schema.parse(p.terms));
  const issues = validateTermsV2(parsed, { modelGroupCap: deps.modelGroupCap });
  if (issues.length > 0) throw new ForbiddenError(`Terms rejected: ${issues.join(",")}`);
  const hash = termsHashV2(parsed);
  const lpHash = languagePolicyHashOf(parsed);
  await db.$transaction(async (tx) => {
    const deal = await loadOwnedDeal(tx, p.dealId, p.principalId);
    if (parsed.mandateId !== deal.mandateId || parsed.sellerId !== deal.sellerId) throw new ForbiddenError("Terms do not match the deal's mandate/seller");
    const opened = openMandateRow(deal.mandate, deps);
    if (!opened) throw new ForbiddenError("Mandate seal does not verify");
    if (opened.version !== 2) throw new ForbiddenError("V2 terms require a V2 mandate");
    if (hasLlmCriteria(parsed)) {
      if (!deps.llmCriteriaEnabled) throw new ForbiddenError("LLM_CRITERIA_NOT_ENABLED");
      const weaker = strictnessFailures(parsed.languagePolicy!, opened.doc.languagePolicy);
      if (weaker.length > 0) throw new ForbiddenError(`LANGUAGE_POLICY_WEAKER_THAN_MANDATE: ${weaker.join(",")}`);
      if (!deps.detectorPermitted || !deps.detectorPermitted(parsed.languagePolicy!.detector, parsed.languagePolicy!.supportedLanguages)) throw new ForbiddenError("DETECTOR_NOT_PERMITTED");
    }
    await transitionDeal(tx, p.dealId, "TERMS_LOCKED", p.actor, { termsHash: hash, price: parsed.price, termsSchemaVersion: 2, languagePolicyHash: lpHash }, {
      termsJson: parsed as unknown as Prisma.InputJsonValue,
      termsHash: hash,
      price: parsed.price,
      deadline: new Date(parsed.deadline),
      termsSchemaVersion: 2,
      languagePolicyHash: lpHash,
    });
    await tx.termsVersion.create({ data: { dealId: p.dealId, version: 1, termsSchemaVersion: 2, termsHash: hash, termsJson: parsed as unknown as Prisma.InputJsonValue, lockedBy: p.actor } });
  });
  return hash;
}

export async function evaluateFor(tx: Tx, dealId: string, deps: PolicyDeps, humanApproved: boolean) {
  const deal = await tx.deal.findUniqueOrThrow({ where: { id: dealId }, include: { mandate: true, reservations: true, attestation: true } });
  const committed = await committedFor(tx, deal.mandateId, dealId);
  const opened = openMandateRow(deal.mandate, deps);
  const doc = opened?.doc ?? null;
  let result: PolicyResult = evaluatePolicy({
    mandate: doc,
    mandateId: deal.mandateId,
    revokedAt: deal.mandate.revokedAt,
    terms: deal.termsJson,
    lockedTermsHash: deal.termsHash ?? "",
    committed,
    now: deps.now ?? new Date(),
    rounds: deal.negotiationRounds,
    maxRounds: deps.maxRounds,
    modelGroupCap: deps.modelGroupCap,
    llmCriteriaEnabled: deps.llmCriteriaEnabled,
    detectorPermitted: deps.detectorPermitted,
  });
  if (humanApproved && result.outcome === "NEEDS_HUMAN") {
    // V1: the human's decision waives the threshold. V2: a human decision counts ONLY as a verified TermsAttestation bound to this exact mandate and terms.
    const v2 = opened?.version === 2;
    if (!v2 || authorizeLoadedDeal(deal, { ...deps, now: deps.now ?? new Date() }, { checkExpiry: true }).ok) result = { outcome: "OK", reasons: [] };
  }
  return { deal, doc, result };
}

/** TERMS_LOCKED -> POLICY_CHECKED, then BLOCKED / NEEDS_HUMAN when the policy says so. Takes the mandate lock. */
export async function checkPolicy(db: PrismaClient, p: { dealId: string; deps: PolicyDeps; actor?: string; principalId?: string }): Promise<PolicyResult> {
  return db.$transaction(async (tx) => {
    const owned = await loadOwnedDeal(tx, p.dealId, p.principalId);
    await lockMandate(tx, owned.mandateId);
    const { result } = await evaluateFor(tx, p.dealId, p.deps, false);
    await transitionDeal(tx, p.dealId, "POLICY_CHECKED", p.actor ?? "policy-engine", { policy: result.outcome, reasons: result.reasons });
    if (result.outcome === "BLOCKED") await transitionDeal(tx, p.dealId, "BLOCKED", "policy-engine", { reasons: result.reasons });
    if (result.outcome === "NEEDS_HUMAN")
      await transitionDeal(tx, p.dealId, "NEEDS_HUMAN", "policy-engine", { reasons: result.reasons, reason: result.reasons.join(",") });
    return result;
  });
}

export type ReserveForDealResult = { ok: true; created: boolean } | { ok: false; reasons: string[] };

/**
 * Atomic budget reservation that MUST precede PayPal order creation. Re-evaluates policy inside the mandate lock,
 * so two concurrent deals cannot both claim the same remaining budget.
 */
export async function reserveForDeal(
  db: PrismaClient,
  p: { dealId: string; deps: PolicyDeps; humanApproved?: boolean; principalId?: string },
): Promise<ReserveForDealResult> {
  return db.$transaction((tx) => reserveForDealTx(tx, p));
}

/** The reservation body, usable inside a caller's transaction (the V2 approval writes the attestation and reserves in ONE transaction). */
export async function reserveForDealTx(
  tx: Tx,
  p: { dealId: string; deps: PolicyDeps; humanApproved?: boolean; principalId?: string },
): Promise<ReserveForDealResult> {
  {
    const owned = await loadOwnedDeal(tx, p.dealId, p.principalId);
    await lockMandate(tx, owned.mandateId);
    const { deal, doc, result } = await evaluateFor(tx, p.dealId, p.deps, p.humanApproved === true);
    const okState = deal.state === "POLICY_CHECKED" || (deal.state === "NEEDS_HUMAN" && p.humanApproved === true && deal.needsHumanFrom === "POLICY_CHECKED");
    if (!okState) return { ok: false, reasons: [`STATE_${deal.state}`] };
    if (result.outcome !== "OK" || !doc || !deal.price) return { ok: false, reasons: result.reasons.length ? result.reasons : ["POLICY_NOT_OK"] };
    const r = await reserve(tx, {
      mandateId: deal.mandateId,
      dealId: deal.id,
      amount: new D(deal.price.toString()),
      budgetTotal: parseMoney(doc.budgetTotal),
    });
    if (!r.ok) {
      await appendEvent(tx, deal.id, "BUDGET_RESERVATION_REFUSED", "policy-engine", { reason: r.reason });
      return { ok: false, reasons: [r.reason] };
    }
    if (r.created) await appendEvent(tx, deal.id, "BUDGET_RESERVED", "policy-engine", { amount: deal.price.toString() });
    return { ok: true, created: r.created };
  }
}

/**
 * Pre-authorization human review. Approve records the decision (no amounts) and reserves budget; reject blocks.
 * The deal moves to ORDER_CREATED only when the Settlement Engine has actually created the PayPal order.
 */
export async function resolvePreAuthReview(
  db: PrismaClient,
  p: { dealId: string; principalId: string; principalEmail: string; decision: "approve" | "reject"; deps: PolicyDeps },
): Promise<ReserveForDealResult | { ok: true; blocked: true }> {
  const deal = await db.deal.findFirst({ where: { id: p.dealId, mandate: { principalId: p.principalId } } });
  if (!deal) throw new NotFoundError("Deal not found");
  if (deal.state !== "NEEDS_HUMAN" || deal.needsHumanFrom !== "POLICY_CHECKED") throw new StaleStateError("Deal is not awaiting a pre-authorization review");
  if (p.decision === "reject") {
    await db.$transaction(async (tx) => {
      await appendEvent(tx, p.dealId, "HUMAN_REVIEW_DECISION", `human:${p.principalEmail}`, { phase: "PRE_AUTH", decision: "reject" });
      await transitionDeal(tx, p.dealId, "BLOCKED", `human:${p.principalEmail}`, { reason: "rejected by human" });
    });
    return { ok: true, blocked: true };
  }
  // A V2 deal can only be approved through approveDealWithAttestation (preview + exact-digest confirmation + signed attestation). Rejecting stays available above.
  if (deal.termsSchemaVersion !== 1 || isObjectWithVersion(deal.termsJson)) return { ok: false, reasons: ["ATTESTATION_FLOW_REQUIRED"] };
  const r = await reserveForDeal(db, { dealId: p.dealId, deps: p.deps, humanApproved: true, principalId: p.principalId });
  if (r.ok) {
    await db.$transaction((tx) => appendEvent(tx, p.dealId, "HUMAN_REVIEW_DECISION", `human:${p.principalEmail}`, { phase: "PRE_AUTH", decision: "approve" }));
  }
  return r;
}
