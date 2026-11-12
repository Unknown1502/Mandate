/**
 * NEGOTIATION ORCHESTRATOR: trusted, deterministic code that sits BETWEEN two untrusted agents and the system of record.
 * Agents propose; this module decides what is allowed. It is the only place that holds the mandate (read-only snapshot),
 * the database and the ability to lock terms. Neither agent can reach any of them, and nothing here touches PayPal.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { BuyerAgent, type BuyerContext, type HistoryEntry } from "../agents/buyer";
import { sellerResponseSchema, sellerRestatementSchema, taskSpecSchema, type BuyerIntent, type SpecCriterion, type TaskSpec } from "../agents/contracts";
import type { AgentRunRecord } from "../agents/llm";
import { checkOutbound, sanitizeUntrusted } from "../agents/sanitize";
import type { SellerClient } from "../agents/seller-client";
import { committedFor, releaseReservation } from "./budget";
import { beginNegotiation, lockTerms, StaleStateError, transitionDeal, type PolicyDeps } from "./deals";
import { appendEvent } from "./ledger";
import { NotFoundError, openMandateRow } from "./mandates";
import { D, fmt, parseMoney, type Money } from "./money";
import { counterBounds, openingGuide, openingMax } from "./negotiation-policy";
import { canTransition, type DealState } from "./statemachine";
import { criteriaIssues, readTerms, termsSchema, type TermsV1 } from "./terms";
import { readLockedTerms, termsV2Schema, validateTermsV2, type TermsV2 } from "./terms-v2";

export type { SpecCriterion };
const ORCH = "orchestrator";

/** Authored by the principal. Neither agent can change it. */
export interface TaskBrief {
  description: string;
  criteria: SpecCriterion[];
  deadline: string;
  targetPrice: string;
  /**
   * V2 only. The principal-authored model configuration that is hash-locked with the terms: the criteria with their inputFields, the artifact schema and the language
   * policy. The negotiation can only choose the PRICE inside it. Neither agent ever receives inputFields, classification or the policy: the Buyer sees criteria TEXT, the
   * Seller sees the V1-shaped spec (docs/15 Q7 option A: no new disclosure). When present, `criteria` must be the plain-spec view of v2.criteria.
   */
  v2?: { criteria: TermsV2["criteria"]; artifactSchema?: TermsV2["artifactSchema"]; languagePolicy?: TermsV2["languagePolicy"] };
}

export interface NegotiationDeps {
  db: PrismaClient;
  buyer: BuyerAgent;
  seller: SellerClient;
  policy: PolicyDeps;
  maxRounds: number;
}

export type NegotiationOutcome =
  | { outcome: "LOCKED"; termsHash: string; price: string; rounds: number }
  | { outcome: "BLOCKED"; reason: string; rounds: number };

type IntentCheck = { ok: true } | { ok: false; code: string };

/** Deterministic protocol and price checks on whatever the Buyer Agent (or an injected attacker) produced. */
export function validateBuyerIntent(
  intent: BuyerIntent,
  s: { round: number; ceiling: Money; lastSellerPrice?: Money; target?: Money; lastBuyerPrice?: Money },
): IntentCheck {
  const opening = s.round === 1;
  if (opening && intent.kind !== "propose") return { ok: false, code: "OPENING_MUST_BE_PROPOSE" };
  if (!opening && intent.kind === "propose") return { ok: false, code: "PROPOSE_ONLY_IN_ROUND_1" };
  if (intent.kind === "propose" || intent.kind === "counter") {
    let p: Money;
    try {
      p = parseMoney(intent.price);
    } catch {
      return { ok: false, code: "PRICE_INVALID" };
    }
    if (p.lte(0)) return { ok: false, code: "PRICE_NOT_POSITIVE" };
    if (p.gt(s.ceiling)) return { ok: false, code: "PRICE_ABOVE_CEILING" };
    if (intent.kind === "counter" && s.lastSellerPrice && p.gt(s.lastSellerPrice)) return { ok: false, code: "COUNTER_ABOVE_SELLER_ASK" };
    // bargaining policy (negotiation-policy.ts): applied whenever the orchestrator supplies the target / the buyer's last offer (it always does)
    if (intent.kind === "propose" && s.target && p.gt(openingMax(s.target, s.ceiling))) return { ok: false, code: "OPENING_ABOVE_TARGET" };
    if (intent.kind === "counter") {
      const b = counterBounds({ ceiling: s.ceiling, lastBuyerPrice: s.lastBuyerPrice, lastSellerPrice: s.lastSellerPrice });
      if (!b) return { ok: false, code: "COUNTER_WITHOUT_SELLER_OFFER" };
      if (s.lastBuyerPrice && p.lt(b.min)) return { ok: false, code: "COUNTER_BELOW_OWN_LAST_OFFER" };
      if (s.lastBuyerPrice && p.gt(b.max)) return { ok: false, code: "CONCESSION_TOO_LARGE" };
    }
  }
  if (intent.kind === "accept") {
    if (!s.lastSellerPrice) return { ok: false, code: "NOTHING_TO_ACCEPT" };
    if (s.lastSellerPrice.gt(s.ceiling)) return { ok: false, code: "ACCEPT_ABOVE_CEILING" };
  }
  return { ok: true };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** the price range the Buyer Agent is told about for this round; the SAME policy then validates what it returns */
function nextLimits(round: number, target: Money, ceiling: Money, lastBuyerPrice?: Money, lastSellerPrice?: Money): BuyerContext["limits"] {
  if (round === 1) return { kind: "opening", max: fmt(openingMax(target, ceiling)), suggested: fmt(openingGuide(target, ceiling)) };
  const b = counterBounds({ ceiling, lastBuyerPrice, lastSellerPrice });
  return b ? { kind: "counter", min: fmt(b.min), max: fmt(b.max), suggested: fmt(b.max) } : undefined;
}

export async function runNegotiation(d: NegotiationDeps, p: { dealId: string; principalId: string; brief: TaskBrief }): Promise<NegotiationOutcome> {
  const deal = await d.db.deal.findFirst({ where: { id: p.dealId, mandate: { principalId: p.principalId } }, include: { mandate: { include: { principal: true } } } });
  if (!deal) throw new NotFoundError("Deal not found");
  await beginNegotiation(d.db, p.dealId, ORCH, p.principalId); // PROPOSED -> NEGOTIATING (throws on any other state)

  let rounds = 0;
  const block = async (reason: string): Promise<NegotiationOutcome> => {
    try {
      await d.db.$transaction((tx) => transitionDeal(tx, p.dealId, "BLOCKED", ORCH, { reason }));
    } catch (e) {
      if (!(e instanceof StaleStateError) && (e as Error).name !== "IllegalTransitionError") throw e;
    }
    return { outcome: "BLOCKED", reason, rounds };
  };
  const note = (type: string, actor: string, payload: Record<string, unknown>) => d.db.$transaction((tx) => appendEvent(tx, p.dealId, type, actor, payload));

  // Read-only, frozen snapshot of the sealed mandate. Agents never receive it.
  const opened = openMandateRow(deal.mandate, d.policy);
  if (!opened) return block("MANDATE_SEAL_INVALID");
  // the brief version must match the mandate version: a V2 mandate carries V2 terms only, a V1 mandate V1 terms only (no downgrade around the signed language policy)
  if ((opened.version === 2) !== (p.brief.v2 !== undefined)) return block("BRIEF_VERSION_MISMATCH");
  const mandate = deepFreeze({ ...opened.doc });

  const committed = await d.db.$transaction((tx) => committedFor(tx, deal.mandateId, p.dealId));
  const remaining = parseMoney(mandate.budgetTotal).minus(committed);
  let ceiling = D.min(parseMoney(mandate.perDealMax), remaining);
  // Stay under the human-review threshold so autonomous negotiation does not manufacture reviews.
  if (mandate.requireHumanAbove) ceiling = D.min(ceiling, parseMoney(mandate.requireHumanAbove));
  if (ceiling.lte(0)) return block("NO_BUDGET_AVAILABLE");
  let target: Money;
  try {
    target = D.min(parseMoney(p.brief.targetPrice), ceiling);
  } catch {
    return block("BRIEF_INVALID:TARGET_PRICE");
  }

  // V2: the plain-spec criteria are DERIVED from the locked V2 criteria, so the seller's view and the locked terms cannot disagree
  const specCriteria: SpecCriterion[] = p.brief.v2
    ? p.brief.v2.criteria.map((c) => (c.type === "deterministic" ? { id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight, validator: c.validator, params: c.params } : { id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight }))
    : p.brief.criteria;
  const specParsed = taskSpecSchema.safeParse({ taskType: "data_cleaning", description: p.brief.description, criteria: specCriteria, currency: "USD", deadline: p.brief.deadline });
  if (!specParsed.success) return block("BRIEF_INVALID:SPEC");
  const spec: TaskSpec = specParsed.data;
  const base = { taskType: spec.taskType, description: spec.description, price: fmt(target), currency: "USD", deadline: spec.deadline, sellerId: deal.sellerId, mandateId: deal.mandateId };
  let termsDraft: { success: true; data: TermsV1 | TermsV2 } | { success: false };
  if (p.brief.v2) {
    const v2 = termsV2Schema.safeParse({ schemaVersion: 2, ...base, criteria: p.brief.v2.criteria, artifactSchema: p.brief.v2.artifactSchema, languagePolicy: p.brief.v2.languagePolicy });
    if (!v2.success) return block("BRIEF_INVALID:TERMS");
    const v2issues = validateTermsV2(v2.data, { modelGroupCap: d.policy.modelGroupCap });
    if (v2issues.length > 0) return block(`BRIEF_INVALID:${v2issues.join(",")}`);
    termsDraft = { success: true, data: v2.data };
  } else {
    const v1 = termsSchema.safeParse({ ...base, criteria: spec.criteria });
    termsDraft = v1.success ? { success: true, data: v1.data } : { success: false };
  }
  if (!termsDraft.success) return block("BRIEF_INVALID:TERMS");
  const issues = criteriaIssues(termsDraft.data.criteria);
  if (issues.length > 0) return block(`BRIEF_INVALID:${issues.join(",")}`);

  const canary = `CANARY-${randomUUID()}`;
  const protectedValues = [mandate.budgetTotal, mandate.perDealMax, mandate.requireHumanAbove ?? "", fmt(remaining), fmt(ceiling), fmt(target), deal.mandateId, deal.mandate.principalId, deal.mandate.principal.email, canary];

  const onRun = (r: AgentRunRecord) =>
    d.db.agentRun
      .create({ data: { dealId: p.dealId, role: r.role, model: r.model, promptHash: r.promptHash, outputJson: (r.ok ? (r.outputRedacted ?? {}) : { failed: true, error: r.error ?? null, detail: r.detail ?? null }) as Prisma.InputJsonValue, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: r.latencyMs } })
      .then(() => undefined);

  const history: HistoryEntry[] = [];
  let lastBuyerPrice: Money | undefined;
  let lastSellerPrice: Money | undefined;
  let agreed: Money | undefined;

  for (let round = 1; round <= d.maxRounds && !agreed; round++) {
    const ctx: BuyerContext = deepFreeze({
      task: { description: spec.description, criteria: spec.criteria.map((c) => `${c.text} (${c.required ? "required" : "optional"}, weight ${c.weight})`), deadline: spec.deadline },
      targetPrice: fmt(target),
      ceilingPrice: fmt(ceiling),
      limits: nextLimits(round, target, ceiling, lastBuyerPrice, lastSellerPrice),
      round,
      maxRounds: d.maxRounds,
      history: history.map((h) => ({ ...h })),
      canary,
    });
    const decided = await d.buyer.next(ctx, onRun);
    if (!decided.ok) {
      await note("BUYER_OUTPUT_REJECTED", "buyer-agent", { round, error: decided.error });
      return block(`BUYER_OUTPUT_INVALID:${decided.error}`);
    }
    let intent: BuyerIntent = decided.intent;

    const verdict = validateBuyerIntent(intent, { round, ceiling, lastSellerPrice, target, lastBuyerPrice });
    if (!verdict.ok) {
      await note("BUYER_INTENT_REJECTED", ORCH, { round, kind: intent.kind, code: verdict.code }); // never log the price the attacker pushed us to
      return block(`BUYER_INTENT_REJECTED:${verdict.code}`);
    }
    if ("message" in intent && intent.message) {
      const out = checkOutbound(intent.message, protectedValues);
      if (!out.ok) {
        await note("OUTBOUND_MESSAGE_BLOCKED", ORCH, { round, violations: out.violations }); // the leaked text itself is not stored
        intent = { ...intent, message: undefined } as BuyerIntent;
      }
    }
    await d.db.negotiationMessage.create({ data: { dealId: p.dealId, round, sender: "buyer", kind: intent.kind, payload: { price: "price" in intent ? intent.price : null, message: "message" in intent ? (intent.message ?? null) : null } } });
    await note("NEGOTIATION_MESSAGE", "buyer-agent", { round, kind: intent.kind, price: "price" in intent ? intent.price : null });

    if (intent.kind === "accept") {
      agreed = lastSellerPrice;
      break;
    }
    if (intent.kind === "walk_away") return block("BUYER_WALKED_AWAY");
    lastBuyerPrice = parseMoney(intent.price);
    history.push({ sender: "buyer", kind: intent.kind, price: intent.price, message: intent.message });

    const sent = await d.seller.negotiate({ round, spec, buyer: { kind: intent.kind, price: intent.price, message: intent.message } });
    if (!sent.ok) {
      await note("SELLER_UNAVAILABLE", ORCH, { round, error: sent.error });
      return block(`SELLER_ERROR:${sent.error}`);
    }
    const parsed = sellerResponseSchema.safeParse(sent.body);
    if (!parsed.success) {
      // Fail closed: an out-of-contract reply (e.g. a smuggled "criteria" or "amount") is a protocol violation, not "ignore the extra field".
      await note("SELLER_PROTOCOL_VIOLATION", ORCH, { round, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.code}:${i.path.join(".")}`) });
      return block("SELLER_PROTOCOL_VIOLATION");
    }
    const s = parsed.data;
    const clean = s.message ? sanitizeUntrusted(s.message, 500) : undefined;
    rounds = round;
    await d.db.deal.update({ where: { id: p.dealId }, data: { negotiationRounds: round } });
    await d.db.negotiationMessage.create({ data: { dealId: p.dealId, round, sender: "seller", kind: s.kind, payload: { price: "price" in s ? s.price : null, message: clean?.text ?? null, flags: clean?.flags ?? [] } } });
    await note("NEGOTIATION_MESSAGE", "seller-agent", { round, kind: s.kind, price: "price" in s ? s.price : null, textFlags: clean?.flags ?? [] });

    if (s.kind === "accept") {
      agreed = lastBuyerPrice;
      break;
    }
    if (s.kind === "decline") return block("SELLER_DECLINED");
    lastSellerPrice = parseMoney(s.price);
    history.push({ sender: "seller", kind: "counter", price: s.price, message: clean?.text });
  }

  if (!agreed) return block("NO_AGREEMENT_WITHIN_ROUNDS");
  if (agreed.lte(0) || agreed.gt(ceiling)) return block("AGREED_PRICE_ABOVE_CEILING");

  const terms = { ...termsDraft.data, price: fmt(agreed) };
  try {
    // deps are passed so a V2 lock verifies the mandate, the language-policy floor, the group cap, the deployment switch and the detector release
    const hash = await lockTerms(d.db, { dealId: p.dealId, terms, actor: ORCH, principalId: p.principalId, deps: d.policy });
    return { outcome: "LOCKED", termsHash: hash, price: fmt(agreed), rounds };
  } catch (e) {
    await note("TERMS_LOCK_FAILED", ORCH, { error: (e as Error).name });
    return block("TERMS_LOCK_FAILED");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// After the lock: any seller restatement of price / deadline / criteria is drift. Locked terms always govern.
// ---------------------------------------------------------------------------------------------------------------------
export type DriftResult = { drift: false; malformed?: boolean } | { drift: true; fields: string[]; action: "BLOCKED" | "IGNORED_LOCKED_TERMS_GOVERN" };

const project = (cs: { id: string; text: string; type: string; required: boolean; weight: number }[]) =>
  JSON.stringify([...cs].map((c) => [c.id, c.text, c.type, c.required, c.weight]).sort());

export async function detectTermsDrift(db: PrismaClient, p: { dealId: string; restatement: unknown }): Promise<DriftResult> {
  const deal = await db.deal.findUniqueOrThrow({ where: { id: p.dealId } });
  const terms = readLockedTerms(deal.termsJson);
  if (!terms.ok) return { drift: false };
  const r = sellerRestatementSchema.safeParse(p.restatement);
  if (!r.success) {
    await db.$transaction((tx) => appendEvent(tx, p.dealId, "SELLER_RESTATEMENT_MALFORMED", "seller-agent", {}));
    return { drift: false, malformed: true };
  }
  const fields: string[] = [];
  if (r.data.price !== undefined && !parseMoney(r.data.price).eq(parseMoney(terms.terms.price))) fields.push("price");
  if (r.data.deadline !== undefined && new Date(r.data.deadline).getTime() !== new Date(terms.terms.deadline).getTime()) fields.push("deadline");
  if (r.data.criteria !== undefined && project(r.data.criteria) !== project(terms.terms.criteria)) fields.push("criteria");
  if (fields.length === 0) return { drift: false };

  const state = deal.state as DealState;
  const blockable = canTransition(state, "BLOCKED", { needsHumanFrom: deal.needsHumanFrom as DealState | null });
  await db.$transaction(async (tx) => {
    await appendEvent(tx, p.dealId, "TERMS_DRIFT_ATTEMPT", "seller-agent", { fields, claimedPrice: r.data.price ?? null, lockedPrice: terms.terms.price, action: blockable ? "BLOCKED" : "IGNORED_LOCKED_TERMS_GOVERN" });
    if (blockable) {
      await transitionDeal(tx, p.dealId, "BLOCKED", ORCH, { reason: `TERMS_DRIFT:${fields.join(",")}` });
      await releaseReservation(tx, p.dealId);
    }
  });
  return { drift: true, fields, action: blockable ? "BLOCKED" : "IGNORED_LOCKED_TERMS_GOVERN" };
}
