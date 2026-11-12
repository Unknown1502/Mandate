/**
 * Pure wording and derivation for the dashboard (no imports: safe for the browser bundle, unit-tested).
 *
 * Everything here is DISPLAY ONLY. It reads what the server already decided (deal state, ledger events, verification result,
 * settlement record) and explains it. It never decides, advances or predicts a payment, and it never shows a stage as done
 * unless the recorded state says so.
 */

type Rec = Record<string, unknown>;
const obj = (p: unknown): Rec => (p && typeof p === "object" && !Array.isArray(p) ? (p as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

// ------------------------------------------------------------------------------------------------------------- state wording
/** Plain names for the deal states, used inside ledger sentences (the dashboard has its own, longer badge labels). */
const STATE_PLAIN: Record<string, string> = {
  PROPOSED: "proposed",
  NEGOTIATING: "negotiating",
  TERMS_LOCKED: "terms locked",
  POLICY_CHECKED: "checked against your mandate",
  BLOCKED: "blocked",
  NEEDS_HUMAN: "waiting for your decision",
  ORDER_CREATED: "PayPal order created",
  AWAITING_BUYER_APPROVAL: "waiting for the buyer's PayPal approval",
  AUTHORIZED: "payment authorized (a hold)",
  AWAITING_DELIVERY: "waiting for delivery",
  DELIVERED: "delivered",
  VERIFYING: "verified, challenge window open",
  SETTLEMENT_REVIEW: "paused for a review request",
  SETTLING: "settling",
  SETTLEMENT_PENDING: "settlement pending at PayPal",
  CAPTURED: "paid (captured)",
  PARTIALLY_CAPTURED: "partly paid",
  VOIDED: "voided (not paid)",
  EXPIRED: "expired",
  FAILED: "failed",
};
export const plainState = (s: string): string => STATE_PLAIN[s] ?? s.toLowerCase().replaceAll("_", " ");

// ------------------------------------------------------------------------------------------------------------- ledger wording
export interface LedgerLine {
  /** the plain-language sentence shown by default */
  title: string;
  /** a second, optional sentence (still plain language) */
  detail?: string;
  /** how the line should be styled */
  tone: "neutral" | "good" | "attention" | "bad";
}

/** What a STATE_TRANSITION means when the deal arrives in each state. Anything not listed falls back to a generic sentence. */
const TRANSITION_TO: Record<string, LedgerLine> = {
  NEGOTIATING: { title: "Negotiation started", tone: "neutral" },
  TERMS_LOCKED: { title: "Agreement locked", detail: "The price and acceptance criteria are fixed and hashed. They cannot change after this point.", tone: "good" },
  POLICY_CHECKED: { title: "Checked against your mandate", detail: "The agreed price is within your signed limits.", tone: "good" },
  BLOCKED: { title: "Deal blocked", tone: "bad" },
  NEEDS_HUMAN: { title: "Needs your decision", tone: "attention" },
  ORDER_CREATED: { title: "PayPal order created", detail: "An order exists, but no funds are held yet.", tone: "neutral" },
  AWAITING_BUYER_APPROVAL: { title: "Waiting for the buyer to approve in PayPal", tone: "attention" },
  AUTHORIZED: { title: "Payment authorized", detail: "PayPal is holding the funds. Nothing has been captured.", tone: "good" },
  AWAITING_DELIVERY: { title: "Waiting for the seller to deliver", tone: "neutral" },
  DELIVERED: { title: "Deal marked as delivered", tone: "neutral" },
  VERIFYING: { title: "Delivery requirements passed; challenge window opened", detail: "You can accept, request a review, or let the window run out.", tone: "good" },
  SETTLEMENT_REVIEW: { title: "Review requested; payment paused", detail: "The same delivery is re-verified against the original terms.", tone: "attention" },
  SETTLING: { title: "Settlement decision made; carrying it out", tone: "neutral" },
  SETTLEMENT_PENDING: { title: "Waiting for PayPal to confirm the payment", tone: "attention" },
  CAPTURED: { title: "Payment capture completed", tone: "good" },
  PARTIALLY_CAPTURED: { title: "Partial payment captured", tone: "good" },
  VOIDED: { title: "Authorization released; the seller was not paid", tone: "neutral" },
  EXPIRED: { title: "Deal expired", tone: "bad" },
  FAILED: { title: "Deal failed", tone: "bad" },
};

const EVENT_LINES: Record<string, LedgerLine> = {
  DEAL_CREATED: { title: "Deal opened under your mandate", tone: "neutral" },
  BUDGET_RESERVED: { title: "Budget set aside for this deal", tone: "neutral" },
  BUDGET_RESERVATION_REFUSED: { title: "Budget could not be reserved", detail: "The mandate's limits would have been exceeded.", tone: "bad" },
  RESERVATION_RELEASED_BY_SWEEP: { title: "Unused budget released", tone: "neutral" },
  NEGOTIATION_MESSAGE: { title: "Negotiation message exchanged", tone: "neutral" },
  BUYER_OUTPUT_REJECTED: { title: "The buyer agent's reply was rejected", detail: "It did not match the allowed price-message format.", tone: "bad" },
  BUYER_INTENT_REJECTED: { title: "The buyer agent's offer was refused by the bargaining policy", tone: "attention" },
  OUTBOUND_MESSAGE_BLOCKED: { title: "A message was blocked before reaching the seller", detail: "It contained a protected value.", tone: "attention" },
  SELLER_UNAVAILABLE: { title: "The seller did not respond", tone: "bad" },
  SELLER_PROTOCOL_VIOLATION: { title: "The seller sent an invalid message", tone: "bad" },
  SELLER_RESTATEMENT_MALFORMED: { title: "The seller's restatement of the terms was invalid", tone: "bad" },
  TERMS_LOCK_FAILED: { title: "The terms could not be locked", tone: "bad" },
  TERMS_DRIFT_ATTEMPT: { title: "A change to the locked terms was attempted and refused", tone: "bad" },
  MODEL_CALLED: { title: "An AI model call was recorded", tone: "neutral" },
  APPROVAL_PREVIEWED: { title: "Price shown to you for approval", tone: "neutral" },
  AUTHORIZATION_VALIDATION_FAILED: { title: "The payment authorization failed validation", tone: "bad" },
  PAYPAL_OPERATION_PLANNED: { title: "Payment step recorded before it was sent", detail: "Every PayPal action is written down first, so it can be checked and never repeated blindly.", tone: "neutral" },
  DELIVERY_RECEIVED: { title: "Delivery file received from the seller", tone: "neutral" },
  PAYPAL_WRITE: { title: "Instruction sent to PayPal", detail: "It had been recorded before it was sent.", tone: "neutral" },
  PAYPAL_READ: { title: "Payment status checked with PayPal (read-only)", detail: "The app learns outcomes by reading PayPal, never from a redirect.", tone: "neutral" },
  DELIVERY_REJECTED: { title: "The delivery was rejected before checking", tone: "bad" },
  ARTIFACT_INTEGRITY_FAILURE: { title: "The delivered file failed its integrity check", tone: "bad" },
  VERIFICATION_SUBMITTED: { title: "Delivery sent to the deterministic checks", tone: "neutral" },
  VERIFICATION_RECORDED: { title: "Verification result recorded", tone: "neutral" },
  SETTLEMENT_DECIDED: { title: "Settlement decision recorded", detail: "Computed by the settlement engine from the locked criteria, not by a model.", tone: "good" },
  ORCHESTRATION_STEP: { title: "Automatic step carried out", tone: "neutral" },
  ORCHESTRATION_HALTED: { title: "Automatic processing stopped", tone: "attention" },
};

/** Plain-language description of one ledger event. The original event name stays available to the caller for the detailed audit view. */
export function ledgerLine(type: string, payload?: unknown): LedgerLine {
  const p = obj(payload);
  if (type === "STATE_TRANSITION") {
    const to = str(p.to);
    const challenged = str(p.challenged);
    if (challenged) return { title: "Review requested for one criterion", detail: `Criterion “${challenged}”. The same delivery is re-checked against the original terms.`, tone: "attention" };
    if (to && TRANSITION_TO[to]) return TRANSITION_TO[to];
    return { title: to ? `Deal is now ${plainState(to)}` : "Deal state changed", tone: "neutral" };
  }
  if (type === "HUMAN_REVIEW_DECISION") {
    const decision = str(p.decision);
    const phase = str(p.phase);
    if (phase === "POST_AUTH" && decision === "accept") return { title: "You accepted the delivery", detail: "This only ended your own waiting period early; the amount still comes from the locked criteria.", tone: "good" };
    if (phase === "PRE_AUTH" && decision === "approve") return { title: "You approved the price", tone: "good" };
    if (phase === "PRE_AUTH" && (decision === "reject" || decision === "rejected")) return { title: "You rejected the price", tone: "bad" };
    return { title: "A human review decision was recorded", tone: "neutral" };
  }
  const known = EVENT_LINES[type];
  if (known) return known;
  // unknown or future event types are never hidden: show a readable version of the name
  const words = type.toLowerCase().replaceAll("_", " ");
  return { title: words.charAt(0).toUpperCase() + words.slice(1), tone: "neutral" };
}

/** Who did it, in words: the signed-in buyer's own actions read as "you"; every other actor is shown exactly as recorded. */
export function actorLabel(actor: string): string {
  return actor.startsWith("human:") ? `you (${actor.slice("human:".length)})` : actor;
}

// ------------------------------------------------------------------------------------------------------------- reasons
const REASON_TEXT: Record<string, string> = {
  ALL_REQUIRED_PASSED: "all required criteria passed",
  WINDOW_EXPIRED: "the challenge window ended with no review request",
  REQUIRED_FAILED: "a required criterion failed",
  REQUIRED_UNVERIFIABLE: "a required criterion could not be verified",
  ACCEPTED: "you accepted the delivery",
  AFTER_REVIEW_REQUEST: "decided after a review request",
  AFTER_HUMAN_REVIEW: "decided after a human review",
};
/** Readable version of the settlement reason codes; an empty list says so instead of showing a dash. */
export function reasonText(codes: readonly string[] | undefined | null): string {
  if (!codes || codes.length === 0) return "no exceptions recorded";
  return codes.map((c) => REASON_TEXT[c] ?? c.toLowerCase().replaceAll("_", " ")).join("; ");
}

// ------------------------------------------------------------------------------------------------------------- workflow
export type StageStatus = "done" | "current" | "pending" | "attention" | "failed";
export interface Stage {
  key: "authority" | "negotiation" | "agreement" | "delivery" | "settlement";
  label: string;
  status: StageStatus;
  /** one short factual line under the label */
  note: string;
}

export interface WorkflowInput {
  /** the mandate that applies (selected, or the deal's own); undefined when none exists */
  mandate?: { sealVerified: boolean } | null;
  /** the selected deal, if any */
  deal?: { state: string; termsHash?: string | null } | null;
  hasDelivery: boolean;
  /** `verification.result.overall` of the latest verification run, if any */
  verificationOverall?: string | null;
  /** true when the scanner raised a flag that sends the delivery to a human */
  verificationFlagged?: boolean;
  /** the settlement record, if one exists */
  settlement?: { decision: string } | null;
}

const POST_POLICY = new Set(["ORDER_CREATED", "AWAITING_BUYER_APPROVAL", "AUTHORIZED", "AWAITING_DELIVERY", "DELIVERED", "VERIFYING", "SETTLEMENT_REVIEW", "SETTLING", "SETTLEMENT_PENDING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "EXPIRED", "FAILED"]);

/**
 * The five accountability stages, derived only from recorded state. A stage is `done` only when the record shows it happened;
 * nothing is `current` or `done` ahead of the deal. `BLOCKED` and failed checks are shown as `failed`, not hidden.
 */
export function workflowStages(i: WorkflowInput): Stage[] {
  const d = i.deal ?? null;
  const state = d?.state;
  const hasTerms = !!d?.termsHash;

  // 1 authority
  const authority: Stage = i.mandate
    ? i.mandate.sealVerified
      ? { key: "authority", label: "Authority established", status: "done", note: "Your signed mandate is verified" }
      : { key: "authority", label: "Authority established", status: "failed", note: "The mandate seal did not verify" }
    : { key: "authority", label: "Authority established", status: "current", note: "Create and sign a mandate" };

  const base = (key: Stage["key"], label: string): Stage => ({ key, label, status: "pending", note: "Not reached yet" });
  const negotiation = base("negotiation", "Negotiation completed");
  const agreement = base("agreement", "Agreement locked");
  const delivery = base("delivery", "Delivery verified");
  const settlement = base("settlement", "Settlement decision recorded");

  if (authority.status === "done" && !d) {
    negotiation.status = "current";
    negotiation.note = "Open a deal to start";
  }

  if (d && state) {
    // 2 negotiation
    if (hasTerms) {
      negotiation.status = "done";
      negotiation.note = "A price was agreed";
    } else if (state === "BLOCKED") {
      negotiation.status = "failed";
      negotiation.note = "Ended without an agreement";
    } else {
      negotiation.status = "current";
      negotiation.note = "Agents are negotiating the price";
    }

    // 3 agreement
    // a delivery can only exist after the agreement was locked and checked, so NEEDS_HUMAN with a delivery (a flagged delivery) is a post-policy state too
    if (hasTerms && (POST_POLICY.has(state) || i.hasDelivery)) {
      agreement.status = "done";
      agreement.note = "Terms hashed and checked against your mandate";
    } else if (hasTerms && state === "BLOCKED") {
      agreement.status = "failed";
      agreement.note = "Refused: outside your mandate or the terms changed";
    } else if (hasTerms && state === "NEEDS_HUMAN" && !i.hasDelivery) {
      agreement.status = "attention";
      agreement.note = "Waiting for your approval of the price";
    } else if (hasTerms) {
      agreement.status = "current";
      agreement.note = "Terms are being checked against your mandate";
    }

    // 4 delivery
    const paymentHeld = ["AUTHORIZED", "AWAITING_DELIVERY"].includes(state) || (i.hasDelivery && POST_POLICY.has(state));
    if (!i.hasDelivery) {
      if (state === "AWAITING_DELIVERY") {
        delivery.status = "current";
        delivery.note = "Waiting for the seller to deliver";
      } else if (paymentHeld) {
        delivery.status = "current";
        delivery.note = "Waiting for the seller to deliver";
      } else if (hasTerms && ["ORDER_CREATED", "AWAITING_BUYER_APPROVAL"].includes(state)) {
        delivery.note = "Starts after the payment is authorized";
      }
    } else if (i.verificationOverall === "ALL_REQUIRED_PASSED" && !i.verificationFlagged) {
      delivery.status = "done";
      delivery.note = "Deterministic checks passed";
    } else if (i.verificationOverall === "REQUIRED_FAILED") {
      delivery.status = "failed";
      delivery.note = "A required criterion failed";
    } else if (i.verificationOverall) {
      delivery.status = "attention";
      delivery.note = i.verificationFlagged ? "Flagged: needs a human decision" : "Could not be fully verified";
    } else {
      delivery.status = "current";
      delivery.note = "Being checked";
    }

    // 5 settlement
    if (i.settlement) {
      settlement.status = "done";
      settlement.note = state === "SETTLEMENT_PENDING" ? "Decided; waiting for PayPal to confirm" : `Decision: ${i.settlement.decision.replaceAll("_", " ").toLowerCase()}`;
    } else if (["VERIFYING", "SETTLEMENT_REVIEW", "SETTLING", "SETTLEMENT_PENDING"].includes(state)) {
      settlement.status = "current";
      settlement.note = state === "SETTLEMENT_REVIEW" ? "Paused for your review request" : state === "VERIFYING" ? "Challenge window is open" : "Being carried out";
    } else if (state === "NEEDS_HUMAN" && i.hasDelivery) {
      settlement.status = "attention";
      settlement.note = "Waiting for your decision";
    } else if (["BLOCKED", "EXPIRED", "FAILED"].includes(state)) {
      settlement.note = "No settlement: the deal ended first";
    }
  }
  return [authority, negotiation, agreement, delivery, settlement];
}

// ------------------------------------------------------------------------------------------------------------- challenge window
export interface WindowInput {
  state: string;
  /** deal.challengeWindowEndsAt (ISO) */
  endsAt?: string | null;
  /** deal.reviewDeadline (ISO), set while a review is pending */
  reviewDeadline?: string | null;
  /** createdAt of the ledger event that moved the deal to VERIFYING */
  startedAt?: string | null;
  /** the SERVER's current time in ms (server time at fetch plus time elapsed since), never the browser clock alone */
  serverNowMs: number;
  /** true when the ledger shows the buyer accepted the delivery */
  acceptedEarly?: boolean;
}
export interface WindowView {
  phase: "open" | "expired" | "paused" | "closed";
  headline: string;
  note: string;
  startedAt: string | null;
  endsAt: string | null;
  /** whole milliseconds left; only present while the window is open */
  remainingMs: number | null;
}

/** "12m 05s", "2h 03m", "45s". Never negative. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/**
 * The challenge window as the server recorded it. Returns null when there is nothing true to say (no verified delivery yet, or no timestamp).
 * The note never promises that anything happens at the exact second the window ends: settlement is decided when the server next checks.
 */
export function challengeWindowView(i: WindowInput): WindowView | null {
  const ends = i.endsAt ? Date.parse(i.endsAt) : NaN;
  const startedAt = i.startedAt ?? null;
  if (i.state === "SETTLEMENT_REVIEW") {
    const dl = i.reviewDeadline ?? null;
    return {
      phase: "paused",
      headline: "Challenge window paused for your review request",
      note: dl ? `The review should finish by ${dl}. If it does not, the deal goes to a human decision; nothing is captured or voided automatically.` : "If the review does not finish within 72 hours, the deal goes to a human decision; nothing is captured or voided automatically.",
      startedAt,
      endsAt: i.endsAt ?? null,
      remainingMs: null,
    };
  }
  if (Number.isNaN(ends)) return null;
  if (i.state === "VERIFYING") {
    const remaining = ends - i.serverNowMs;
    if (remaining > 0) {
      return {
        phase: "open",
        headline: `Challenge window open: about ${formatRemaining(remaining)} left`,
        note: "You can accept, request a review, or let it run out. Settlement is decided when the server checks after the window ends, not at the exact second.",
        startedAt,
        endsAt: i.endsAt ?? null,
        remainingMs: remaining,
      };
    }
    return {
      phase: "expired",
      headline: "Challenge window has ended",
      note: "Settlement is decided the next time the server checks (use “Check settlement now”). Nothing happens automatically at the second the window ended.",
      startedAt,
      endsAt: i.endsAt ?? null,
      remainingMs: null,
    };
  }
  if (["SETTLING", "SETTLEMENT_PENDING", "CAPTURED", "PARTIALLY_CAPTURED", "VOIDED"].includes(i.state)) {
    return {
      phase: "closed",
      headline: i.acceptedEarly ? "Challenge window closed early because you accepted" : "Challenge window closed",
      note: i.acceptedEarly ? "Accepting only ended your own waiting period; the amount still came from the locked criteria." : "No review request was open when it closed.",
      startedAt,
      endsAt: i.endsAt ?? null,
      remainingMs: null,
    };
  }
  return null;
}

/** A timestamp for people: local time with its zone name, plus the exact UTC instant for audit use. */
export function formatInstant(iso: string | null | undefined, locale?: string): { local: string; utc: string } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const date = new Date(t);
  return { local: date.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }), utc: date.toISOString() };
}

// ------------------------------------------------------------------------------------------------------------- why a deal is protected
export interface ProtectionFact {
  /** true = the recorded data confirms it; false = the data contradicts it (shown as a warning, never hidden) */
  ok: boolean;
  text: string;
}
export interface ProtectionInput {
  mandate?: { perDealMax: string; sealVerified: boolean } | null;
  termsHash?: string | null;
  terms?: { price: string; criteria: { type: string; required: boolean }[] } | null;
}

/**
 * The reasons THIS deal is protected, each one computed from the deal's own recorded values (not boilerplate). A fact appears only when
 * its inputs exist, so an early-stage deal shows fewer lines rather than invented ones.
 */
export function protectionFacts(i: ProtectionInput): ProtectionFact[] {
  const out: ProtectionFact[] = [];
  const price = i.terms ? Number(i.terms.price) : NaN;
  const cap = i.mandate ? Number(i.mandate.perDealMax) : NaN;
  if (i.mandate && !Number.isNaN(price) && !Number.isNaN(cap)) {
    out.push(price <= cap ? { ok: true, text: `The agreed price ($${price.toFixed(2)}) is within your per-deal limit ($${cap.toFixed(2)}).` } : { ok: false, text: `The agreed price ($${price.toFixed(2)}) is ABOVE your per-deal limit ($${cap.toFixed(2)}); it cannot proceed without being blocked.` });
  }
  if (i.mandate) out.push(i.mandate.sealVerified ? { ok: true, text: "Your mandate's signature verified, so the limits are the ones you approved." } : { ok: false, text: "Your mandate's signature did NOT verify; nothing proceeds under it." });
  if (i.termsHash && i.terms) {
    out.push({ ok: true, text: "The price and criteria are locked under a hash; any later change blocks the deal." });
    const total = i.terms.criteria.length;
    const required = i.terms.criteria.filter((c) => c.required).length;
    const deterministic = total > 0 && i.terms.criteria.every((c) => c.type === "deterministic");
    if (total > 0) out.push(deterministic ? { ok: true, text: `Delivery is checked against ${total} locked criteria (${required} required) by deterministic code, not by an AI's opinion.` } : { ok: false, text: `${total} locked criteria (${required} required); not all are deterministic, so some may need your decision.` });
  }
  return out;
}
