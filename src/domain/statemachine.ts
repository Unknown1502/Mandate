/** Deal state machine (docs/02 §2.3) as a typed table. Anything not listed is illegal and throws. */
export const DEAL_STATES = [
  "PROPOSED",
  "NEGOTIATING",
  "TERMS_LOCKED",
  "POLICY_CHECKED",
  "BLOCKED",
  "NEEDS_HUMAN",
  "ORDER_CREATED",
  "AWAITING_BUYER_APPROVAL",
  "AUTHORIZED",
  "AWAITING_DELIVERY",
  "DELIVERED",
  "VERIFYING",
  "SETTLEMENT_REVIEW",
  "SETTLING",
  "SETTLEMENT_PENDING",
  "CAPTURED",
  "PARTIALLY_CAPTURED",
  "VOIDED",
  "EXPIRED",
  "FAILED",
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export const TERMINAL_STATES: readonly DealState[] = ["CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "BLOCKED", "EXPIRED", "FAILED"];

// Pre-authorization states: no PayPal authorization exists yet, so no money is reserved.
// Post-authorization states: a PayPal authorization may exist and must be handled deliberately.
const TRANSITIONS: Record<DealState, readonly DealState[]> = {
  PROPOSED: ["NEGOTIATING"],
  NEGOTIATING: ["TERMS_LOCKED", "BLOCKED"],
  TERMS_LOCKED: ["POLICY_CHECKED", "BLOCKED"],
  POLICY_CHECKED: ["BLOCKED", "NEEDS_HUMAN", "ORDER_CREATED"],
  NEEDS_HUMAN: ["ORDER_CREATED", "BLOCKED", "SETTLING", "SETTLEMENT_REVIEW"], // restricted further by origin, see below
  ORDER_CREATED: ["AWAITING_BUYER_APPROVAL"],
  AWAITING_BUYER_APPROVAL: ["AUTHORIZED", "EXPIRED"],
  AUTHORIZED: ["AWAITING_DELIVERY", "VOIDED"],
  AWAITING_DELIVERY: ["DELIVERED", "VOIDED"],
  DELIVERED: ["VERIFYING"],
  VERIFYING: ["SETTLING", "NEEDS_HUMAN", "SETTLEMENT_REVIEW"],
  // A human challenge of a PASSED verification pauses settlement. Re-verification returns to VERIFYING; a timeout or
  // unresolved challenge goes to NEEDS_HUMAN. Neither can capture or void.
  SETTLEMENT_REVIEW: ["VERIFYING", "NEEDS_HUMAN"],
  SETTLING: ["CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "SETTLEMENT_PENDING", "NEEDS_HUMAN", "FAILED"],
  SETTLEMENT_PENDING: ["CAPTURED", "PARTIALLY_CAPTURED", "NEEDS_HUMAN"],
  BLOCKED: [],
  CAPTURED: [],
  PARTIALLY_CAPTURED: [],
  VOIDED: [],
  EXPIRED: [],
  FAILED: [],
};

const PRE_AUTH_ORIGINS: readonly DealState[] = ["POLICY_CHECKED"];
const PRE_AUTH_RESOLUTIONS: readonly DealState[] = ["ORDER_CREATED", "BLOCKED"];
const POST_AUTH_RESOLUTIONS: readonly DealState[] = ["SETTLING"];
const REVIEW_RESOLUTIONS: readonly DealState[] = ["SETTLEMENT_REVIEW"];

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: DealState,
    public readonly to: DealState,
    reason?: string,
  ) {
    super(`Illegal deal transition ${from} -> ${to}${reason ? `: ${reason}` : ""}`);
    this.name = "IllegalTransitionError";
  }
}

export const isTerminal = (s: DealState): boolean => TERMINAL_STATES.includes(s);

/**
 * Throws IllegalTransitionError unless from -> to is allowed.
 * For NEEDS_HUMAN, `needsHumanFrom` (where the review was raised) decides what a human may resolve it to:
 * pre-authorization reviews -> ORDER_CREATED | BLOCKED; post-authorization reviews -> SETTLING only.
 * A human decision never carries an amount; SETTLING recomputes it deterministically.
 */
export function assertTransition(from: DealState, to: DealState, ctx: { needsHumanFrom?: DealState | null } = {}): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);
  if (from === "NEEDS_HUMAN") {
    const origin = ctx.needsHumanFrom;
    if (!origin) throw new IllegalTransitionError(from, to, "NEEDS_HUMAN without a recorded origin");
    const allowed = PRE_AUTH_ORIGINS.includes(origin) ? PRE_AUTH_RESOLUTIONS : origin === "SETTLEMENT_REVIEW" ? REVIEW_RESOLUTIONS : POST_AUTH_RESOLUTIONS;
    if (!allowed.includes(to)) throw new IllegalTransitionError(from, to, `review raised in ${origin} cannot resolve to ${to}`);
  }
}

export function canTransition(from: DealState, to: DealState, ctx: { needsHumanFrom?: DealState | null } = {}): boolean {
  try {
    assertTransition(from, to, ctx);
    return true;
  } catch {
    return false;
  }
}

export const allowedFrom = (s: DealState): readonly DealState[] => TRANSITIONS[s];
