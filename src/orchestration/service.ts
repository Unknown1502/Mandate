/**
 * ORCHESTRATOR. Coordinates approved mandate -> negotiation -> locked terms -> deal -> delivery -> verification -> human
 * challenge/review -> settlement INSTRUCTION, using only the existing domain services and the narrow SettlementPort.
 *
 * It does not (and structurally cannot) call PayPal, compute amounts, create PayPal operation ids, or override a settlement outcome:
 * it never imports the engine, the gateway or the PayPal layer. Every step is state-checked, idempotent (OrchestrationStep) and preceded by an
 * integrity preflight; a failed preflight HALTS the deal for the orchestrator and moves no money.
 */
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import type { BuyerAgent } from "../agents/buyer";
import type { SellerClient } from "../agents/seller-client";
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { checkPolicy, createDeal, reserveForDeal, resolvePreAuthReview, type PolicyDeps } from "../domain/deals";
import { appendEvent } from "../domain/ledger";
import { NotFoundError } from "../domain/mandates";
import { runNegotiation, type NegotiationOutcome, type TaskBrief } from "../domain/negotiation";
import { isTerminal, type DealState } from "../domain/statemachine";
import type { AiVerifier, LlmSkeptic } from "../verification/ai";
import { verificationResultSchema } from "../verification/contracts";
import { submitDelivery } from "../verification/delivery";
import { VerificationError, resultHashOf, verifyDelivery, type VerifyDeps } from "../verification/pipeline";
import { runStep, type StepOutcome } from "./idempotency";
import { checkIntegrity } from "./integrity";
import { settlementInstructionSchema, type PortResult, type SettlementPort } from "./ports";

export interface OrchestratorDeps {
  db: PrismaClient;
  port: SettlementPort;
  policy: PolicyDeps;
  verify?: { ai?: AiVerifier; skeptic?: LlmSkeptic; passes?: number; claimWaitMs?: number; claimLeaseMs?: number; language?: VerifyDeps["language"]; prescanBudget?: VerifyDeps["prescanBudget"] };
  negotiation?: { buyer: BuyerAgent; seller: SellerClient; maxRounds: number };
  now?: () => Date;
  /** how long a worker may hold a step before another may take it over (crash recovery) */
  leaseMs?: number;
}

export type AdvanceStatus = "DONE" | "WAITING" | "NEEDS_HUMAN" | "HALTED" | "IN_PROGRESS" | "REFUSED";
export interface AdvanceResult {
  dealId: string;
  state: string;
  status: AdvanceStatus;
  reason?: string;
  steps: string[];
  nextCheckAt?: string;
  approvalUrl?: string;
}
export interface Actor {
  principalId: string;
  email: string;
}

type Rec = Record<string, unknown> & { status: string; reason?: string };
type Step = { ran?: string[]; status: string; reason?: string };

const SETTLED_REASONS = new Set(["ALREADY_SETTLED", "SETTLEMENT_ALREADY_DECIDED", "DUPLICATE_SETTLEMENT_PREVENTED"]);

export class Orchestrator {
  constructor(private readonly d: OrchestratorDeps) {}
  private now = () => (this.d.now ?? (() => new Date()))();
  private get db() {
    return this.d.db;
  }

  // -------------------------------------------------------------------------------------------------- entry points
  /** Create a deal under an approved mandate, negotiate, lock the terms, and drive it as far as it can go without a human or the buyer. */
  async openDeal(p: { principalId: string; mandateId: string; sellerId: string; brief: TaskBrief }): Promise<{ dealId: string; negotiation: NegotiationOutcome | { outcome: "NOT_CONFIGURED" }; advance?: AdvanceResult }> {
    const deal = await createDeal(this.db, { principalId: p.principalId, mandateId: p.mandateId, sellerId: p.sellerId, publicKeyB64: this.d.policy.publicKeyB64, registry: this.d.policy.registry, v2Gate: this.d.policy.v2Gate });
    if (!this.d.negotiation) return { dealId: deal.id, negotiation: { outcome: "NOT_CONFIGURED" } };
    const negotiation = await runNegotiation({ db: this.db, ...this.d.negotiation, policy: this.d.policy }, { dealId: deal.id, principalId: p.principalId, brief: p.brief });
    return { dealId: deal.id, negotiation, advance: negotiation.outcome === "LOCKED" ? await this.advance(deal.id) : undefined };
  }

  /** A seller delivery event (safe to replay or deliver concurrently). */
  async receiveDelivery(i: { dealId: string; authenticatedSellerId: string; manifest: unknown; artifact: Uint8Array }): Promise<{ delivery: Rec; advance: AdvanceResult }> {
    let key: string;
    try {
      key = sha256Hex(canonicalJson(i.manifest));
    } catch {
      return { delivery: { status: "REFUSED", reason: "MANIFEST_INVALID" }, advance: await this.advance(i.dealId) };
    }
    const integ = await this.preflight(i.dealId);
    if (integ) return { delivery: { status: "HALTED", reason: integ }, advance: await this.advance(i.dealId) };
    const run = await this.act(i.dealId, "DELIVERY", key, async () => {
      const r = await submitDelivery({ db: this.db, now: this.d.now }, { dealId: i.dealId, authenticatedSellerId: i.authenticatedSellerId, manifest: i.manifest, artifact: i.artifact });
      // Only an accepted delivery is final: a refusal for a transient reason (e.g. wrong state yet) may be retried with the same manifest.
      return { value: r.ok ? { status: "DONE", deliveryId: r.deliveryId, idempotent: r.idempotent } : { status: "REFUSED", reason: r.code }, final: r.ok };
    });
    return { delivery: run ?? { status: "IN_PROGRESS" }, advance: await this.advance(i.dealId) };
  }

  /** Only the deal's owning, authenticated principal may challenge. Identical submissions are idempotent. */
  async challenge(actor: Actor, dealId: string, challenge: unknown): Promise<{ challenge: Rec; advance: AdvanceResult }> {
    if (!(await this.isOwner(dealId, actor.principalId))) return { challenge: { status: "REFUSED", reason: "NOT_FOUND" }, advance: await this.snapshot(dealId, "REFUSED", "NOT_FOUND") };
    const integ = await this.preflight(dealId);
    if (integ) return { challenge: { status: "HALTED", reason: integ }, advance: await this.advance(dealId) };
    let key: string;
    try {
      key = sha256Hex(canonicalJson({ dealId, challenge }));
    } catch {
      return { challenge: { status: "REFUSED", reason: "INVALID_CHALLENGE" }, advance: await this.advance(dealId) };
    }
    const out = await this.act(dealId, "CHALLENGE", key, async () => {
      try {
        const r = await this.d.port.submitChallenge({ dealId, principalId: actor.principalId, principalEmail: actor.email, challenge });
        return { value: { status: r.status, reason: r.reason }, final: true };
      } catch (e) {
        if (e instanceof ZodError) return { value: { status: "REFUSED", reason: "INVALID_CHALLENGE" }, final: true };
        if (e instanceof NotFoundError) return { value: { status: "REFUSED", reason: "NOT_FOUND" }, final: true };
        throw e;
      }
    });
    return { challenge: out ?? { status: "IN_PROGRESS" }, advance: await this.advance(dealId) };
  }

  /** Post-authorization human decision (verdicts / retry / resume_review). The engine validates it; no amount can be supplied. */
  async reviewDecision(actor: Actor, dealId: string, decision: unknown): Promise<{ review: Rec; advance: AdvanceResult }> {
    if (!(await this.isOwner(dealId, actor.principalId))) return { review: { status: "REFUSED", reason: "NOT_FOUND" }, advance: await this.snapshot(dealId, "REFUSED", "NOT_FOUND") };
    const integ = await this.preflight(dealId);
    if (integ) return { review: { status: "HALTED", reason: integ }, advance: await this.advance(dealId) };
    let key: string;
    try {
      const n = await this.db.dealEvent.count({ where: { dealId, type: "HUMAN_REVIEW_DECISION" } });
      key = sha256Hex(canonicalJson({ decision, n }));
    } catch {
      return { review: { status: "REFUSED", reason: "INVALID_DECISION" }, advance: await this.advance(dealId) };
    }
    const out = await this.act(dealId, "REVIEW", key, async () => {
      try {
        const r = await this.d.port.submitReviewDecision({ dealId, principalId: actor.principalId, principalEmail: actor.email, decision });
        return { value: { status: r.status, reason: r.reason }, final: true };
      } catch (e) {
        if (e instanceof ZodError) return { value: { status: "REFUSED", reason: "INVALID_DECISION" }, final: true };
        if (e instanceof NotFoundError) return { value: { status: "REFUSED", reason: "NOT_FOUND" }, final: true };
        if ((e as Error).name === "StaleStateError") return { value: { status: "REFUSED", reason: "NOT_AWAITING_REVIEW" }, final: true };
        throw e;
      }
    });
    return { review: out ?? { status: "IN_PROGRESS" }, advance: await this.advance(dealId) };
  }

  /** The buyer accepts a verified delivery before the challenge window ends (waives their own waiting period only; settlement is still derived deterministically). */
  async accept(actor: Actor, dealId: string): Promise<{ accept: Rec; advance: AdvanceResult }> {
    if (!(await this.isOwner(dealId, actor.principalId))) return { accept: { status: "REFUSED", reason: "NOT_FOUND" }, advance: await this.snapshot(dealId, "REFUSED", "NOT_FOUND") };
    const integ = await this.preflight(dealId);
    if (integ) return { accept: { status: "HALTED", reason: integ }, advance: await this.advance(dealId) };
    let out: Rec;
    try {
      const r = await this.d.port.acceptVerification({ dealId, principalId: actor.principalId, principalEmail: actor.email });
      out = { status: r.status, reason: r.reason };
    } catch (e) {
      if (e instanceof NotFoundError) out = { status: "REFUSED", reason: "NOT_FOUND" };
      else throw e;
    }
    return { accept: out, advance: await this.advance(dealId) };
  }

  /** Pre-authorization human review of a deal the policy engine escalated (e.g. price above the human threshold). */
  async preAuthDecision(actor: Actor, dealId: string, decision: "approve" | "reject"): Promise<AdvanceResult> {
    if (!(await this.isOwner(dealId, actor.principalId))) return this.snapshot(dealId, "REFUSED", "NOT_FOUND");
    if (await this.preflight(dealId)) return this.advance(dealId);
    await resolvePreAuthReview(this.db, { dealId, principalId: actor.principalId, principalEmail: actor.email, decision, deps: this.d.policy });
    return this.advance(dealId);
  }

  /** Periodic recovery/progress: expire overdue challenges, reconcile in-doubt settlements, and advance every actionable deal. */
  async sweep(limit = 50, only?: string[]): Promise<{ expired: number; advanced: AdvanceResult[] }> {
    const expired = (await this.d.port.expireOverdueReviews()).filter((e) => e.expired).length;
    // Urgency order, so deals that are merely WAITING (and therefore never update) cannot starve in-doubt settlements behind them.
    const groups: DealState[][] = [["SETTLING", "SETTLEMENT_PENDING"], ["SETTLEMENT_REVIEW", "VERIFYING", "DELIVERED"], ["TERMS_LOCKED", "POLICY_CHECKED"], ["AWAITING_BUYER_APPROVAL"]];
    const ids: string[] = [];
    const scope = only ? { id: { in: only } } : {};
    for (const g of groups) {
      if (ids.length >= limit) break;
      const rows = await this.db.deal.findMany({ where: { state: { in: g }, ...scope }, select: { id: true }, orderBy: { updatedAt: "asc" }, take: limit - ids.length });
      ids.push(...rows.map((r) => r.id));
    }
    if (ids.length < limit) {
      // a deal awaiting delivery needs attention only once its delivery deadline has passed
      const late = await this.db.deal.findMany({ where: { state: "AWAITING_DELIVERY", deadline: { lt: this.now() }, ...scope }, select: { id: true }, orderBy: { deadline: "asc" }, take: limit - ids.length });
      ids.push(...late.map((r) => r.id));
    }
    const advanced: AdvanceResult[] = [];
    for (const id of ids) advanced.push(await this.advance(id));
    return { expired, advanced };
  }

  // -------------------------------------------------------------------------------------------------- the driver
  /** Perform every step that can be performed right now, then report where the deal is waiting. Safe to call repeatedly and concurrently. */
  async advance(dealId: string): Promise<AdvanceResult> {
    const steps: string[] = [];
    let last: Step = { status: "WAITING" };
    for (let i = 0; i < 14; i++) {
      const before = await this.db.deal.findUnique({ where: { id: dealId }, select: { state: true } });
      if (!before) return { dealId, state: "UNKNOWN", status: "REFUSED", reason: "DEAL_NOT_FOUND", steps };
      if (isTerminal(before.state as DealState)) return { dealId, state: before.state, status: "DONE", steps };
      const integ = await this.preflight(dealId);
      if (integ) return { dealId, state: before.state, status: "HALTED", reason: integ, steps };

      last = await this.stepOnce(dealId, before.state as DealState);
      if (last.ran) steps.push(...last.ran);
      if (last.status === "IN_PROGRESS" || last.status === "HALTED") break;
      const after = await this.db.deal.findUnique({ where: { id: dealId }, select: { state: true } });
      if (after?.state === before.state) break; // nothing changed: we are waiting on someone or something
    }
    return this.report(dealId, last, steps);
  }

  private async report(dealId: string, last: Step, steps: string[]): Promise<AdvanceResult> {
    const deal = await this.db.deal.findUniqueOrThrow({ where: { id: dealId } });
    const s = last.status;
    const status: AdvanceStatus = isTerminal(deal.state as DealState) ? "DONE" : s === "HALTED" ? "HALTED" : s === "IN_PROGRESS" || s === "UNRESOLVED" ? "IN_PROGRESS" : s === "REFUSED" ? "REFUSED" : s === "NEEDS_HUMAN" || deal.state === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "WAITING";
    const out: AdvanceResult = { dealId, state: deal.state, status, reason: last.reason, steps };
    if (deal.state === "AWAITING_BUYER_APPROVAL" && deal.approvalUrl) out.approvalUrl = deal.approvalUrl;
    const next = deal.state === "VERIFYING" ? deal.challengeWindowEndsAt : deal.state === "SETTLEMENT_REVIEW" ? deal.reviewDeadline : deal.state === "AWAITING_DELIVERY" ? deal.deadline : null;
    if (next) out.nextCheckAt = next.toISOString();
    return out;
  }

  private async snapshot(dealId: string, status: AdvanceStatus, reason: string): Promise<AdvanceResult> {
    const d = await this.db.deal.findUnique({ where: { id: dealId }, select: { state: true } });
    return { dealId, state: d?.state ?? "UNKNOWN", status, reason, steps: [] };
  }

  private async stepOnce(dealId: string, state: DealState): Promise<Step> {
    const deal = await this.db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { delivery: true } });
    const asStep = (ran: string, r: Rec | null): Step => (r ? { ran: [ran], status: r.status, reason: r.reason } : { status: "IN_PROGRESS" });

    switch (state) {
      case "TERMS_LOCKED":
        return asStep("POLICY", await this.act(dealId, "POLICY", deal.termsHash!, async () => {
          const r = await checkPolicy(this.db, { dealId, deps: this.d.policy, actor: "orchestrator" });
          return { value: { status: r.outcome === "OK" ? "DONE" : r.outcome === "BLOCKED" ? "REFUSED" : "NEEDS_HUMAN", reason: r.reasons.join(",") }, final: true };
        }));

      case "POLICY_CHECKED":
        return asStep("ORDER", await this.act(dealId, "ORDER", deal.termsHash!, () => this.reserveAndOrder(dealId)));

      case "NEEDS_HUMAN": {
        if (deal.needsHumanFrom !== "POLICY_CHECKED") return { status: "NEEDS_HUMAN", reason: deal.needsHumanReason ?? `REVIEW_${deal.needsHumanFrom ?? "UNKNOWN"}` };
        const reserved = await this.db.budgetReservation.findUnique({ where: { dealId } });
        if (reserved?.status !== "ACTIVE") return { status: "NEEDS_HUMAN", reason: "PRE_AUTH_REVIEW" }; // waiting for the principal's decision
        return asStep("ORDER", await this.act(dealId, "ORDER_AFTER_REVIEW", deal.termsHash!, async () => this.final(await this.d.port.createOrder(dealId))));
      }

      case "AWAITING_BUYER_APPROVAL": {
        const r = await this.act(dealId, "APPROVAL", "sync", async () => this.final(await this.d.port.refreshApproval(dealId)));
        return r && r.status === "WAITING" ? { ran: ["APPROVAL"], status: "WAITING", reason: "BUYER_APPROVAL_PENDING" } : asStep("APPROVAL", r);
      }

      case "AWAITING_DELIVERY": {
        if (!deal.deadline || this.now() <= deal.deadline) return { status: "WAITING", reason: "AWAITING_DELIVERY" };
        return asStep("DEADLINE", await this.act(dealId, "DEADLINE", "deadline", async () => this.final(await this.d.port.cancelForDeadline(dealId))));
      }

      case "DELIVERED":
        return this.verifyAndSubmit(dealId, 1, undefined);

      case "VERIFYING":
        return this.settle(dealId);

      case "SETTLEMENT_REVIEW": {
        if (deal.reviewDeadline && deal.reviewDeadline <= this.now()) {
          return asStep("REVIEW_TIMEOUT", await this.act(dealId, "REVIEW_TIMEOUT", deal.reviewDeadline.toISOString(), async () => {
            const e = await this.d.port.expireOverdueReviews();
            return { value: { status: "NEEDS_HUMAN", reason: "REVIEW_TIMEOUT", expired: e.filter((x) => x.expired).length }, final: true };
          }));
        }
        const challenges = Array.isArray(deal.challengesJson) ? (deal.challengesJson as { evidenceRefs?: string[] }[]) : [];
        if (challenges.length === 0) return { status: "WAITING", reason: "REVIEW_WITHOUT_CHALLENGE" };
        // re-verify the SAME artifact against the ORIGINAL locked terms, citing the challenge's evidence
        return this.verifyAndSubmit(dealId, challenges.length + 1, challenges.at(-1)?.evidenceRefs ?? []);
      }

      case "SETTLING":
      case "SETTLEMENT_PENDING":
        // A settlement is in flight or in doubt: only the engine's GET-first reconciliation may move it. Never re-plan, never resend here.
        return asStep("RECOVER", await this.act(dealId, "RECOVER", "recover", async () => this.final(await this.d.port.reconcileDeal(dealId), true)));

      default:
        return { status: "WAITING", reason: `STATE_${state}` };
    }
  }

  private async reserveAndOrder(dealId: string): Promise<StepOutcome<Rec>> {
    const res = await reserveForDeal(this.db, { dealId, deps: this.d.policy });
    if (!res.ok) return { value: { status: "REFUSED", reason: res.reasons.join(",") }, final: false };
    return this.final(await this.d.port.createOrder(dealId));
  }

  private async verifyAndSubmit(dealId: string, sequence: number, evidenceRefs: string[] | undefined): Promise<Step> {
    const v = await this.act(dealId, "VERIFY", `seq${sequence}`, async () => {
      try {
        const out = await verifyDelivery({ db: this.db, ai: this.d.verify?.ai, skeptic: this.d.verify?.skeptic, passes: this.d.verify?.passes, language: this.d.verify?.language, prescanBudget: this.d.verify?.prescanBudget, now: this.d.now, claim: { waitMs: this.d.verify?.claimWaitMs, leaseMs: this.d.verify?.claimLeaseMs } }, { dealId, sequence, inputEvidenceRefs: evidenceRefs });
        return { value: { status: "DONE", verificationId: out.result.verificationId }, final: true };
      } catch (e) {
        if (e instanceof VerificationError) {
          if (e.code === "ARTIFACT_INTEGRITY_FAILURE" || e.code === "TERMS_DRIFT") await this.haltOnce(dealId, e.code);
          return { value: { status: e.code === "IN_PROGRESS" ? "IN_PROGRESS" : e.code === "ARTIFACT_INTEGRITY_FAILURE" || e.code === "TERMS_DRIFT" ? "HALTED" : "REFUSED", reason: e.code }, final: false };
        }
        throw e;
      }
    });
    if (!v) return { status: "IN_PROGRESS" };
    const label = sequence > 1 ? "REVERIFY" : "VERIFY";
    if (v.status !== "DONE") return { ran: [label], status: v.status, reason: v.reason };
    const submitted = await this.act(dealId, "SUBMIT", String(v.verificationId), async () => this.final(await this.d.port.submitVerification({ dealId, verificationId: String(v.verificationId) })));
    return submitted ? { ran: [label, "SUBMIT"], status: submitted.status, reason: submitted.reason } : { ran: [label], status: "IN_PROGRESS" };
  }

  /** Validate the authoritative result, then send ONE structured instruction. Waiting for the challenge window is the engine's call. */
  private async settle(dealId: string): Promise<Step> {
    const deal = await this.db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { delivery: true } });
    if (!deal.delivery || !deal.termsHash) return { status: "REFUSED", reason: "NO_DELIVERY" };
    const run = await this.db.verificationRun.findFirst({ where: { deliveryId: deal.delivery.id }, orderBy: { sequence: "desc" } });
    if (!run) return { status: "REFUSED", reason: "NO_VERIFICATION" };
    const parsed = verificationResultSchema.safeParse(run.resultJson);
    if (!parsed.success) {
      await this.haltOnce(dealId, "RESULT_INVALID");
      return { status: "HALTED", reason: "RESULT_INVALID" };
    }
    const r = parsed.data;
    if (resultHashOf(r) !== r.resultHash || r.resultHash !== run.resultHash || r.verificationId !== run.verificationId) {
      await this.haltOnce(dealId, "RESULT_TAMPERED");
      return { status: "HALTED", reason: "RESULT_TAMPERED" };
    }
    if (r.dealId !== deal.id || r.termsHash !== deal.termsHash || r.artifactSha256 !== deal.delivery.artifactSha256) return { status: "REFUSED", reason: "STALE_VERIFICATION" };

    const instruction = settlementInstructionSchema.parse({ kind: "SETTLE", dealId, verificationId: r.verificationId, termsHash: deal.termsHash, resultHash: r.resultHash, idempotencyKey: `settle:${r.verificationId}` });
    const out = await this.act(dealId, "SETTLE", r.verificationId, async () => {
      const p = await this.d.port.requestSettlement(instruction);
      return { value: { status: p.status, reason: p.reason }, final: p.status === "DONE" || (p.reason !== undefined && SETTLED_REASONS.has(p.reason)) };
    });
    return out ? { ran: ["SETTLE"], status: out.status, reason: out.reason } : { status: "IN_PROGRESS" };
  }

  // -------------------------------------------------------------------------------------------------- helpers
  private final(r: PortResult, openAlways = false): StepOutcome<Rec> {
    return { value: { status: r.status, reason: r.reason }, final: !openAlways && r.status === "DONE" };
  }

  /** Run a step at most once (see idempotency.ts). Returns the step's record, or null when another worker is currently running it. */
  private async act(dealId: string, step: string, key: string, fn: () => Promise<StepOutcome<Rec>>): Promise<Rec | null> {
    const run = await runStep<Rec>(this.db, { dealId, step, key }, { now: () => this.now(), leaseMs: this.d.leaseMs ?? 60_000 }, fn);
    return run.kind === "IN_PROGRESS" ? null : run.value;
  }

  private async preflight(dealId: string): Promise<string | null> {
    const r = await checkIntegrity(this.db, dealId, this.d.policy);
    if (r.ok) return null;
    if (r.reason !== "DEAL_NOT_FOUND") await this.haltOnce(dealId, r.reason);
    return r.reason;
  }

  /** Record a halt in the ledger once per distinct reason (replays and polling must not flood the audit trail). */
  private async haltOnce(dealId: string, reason: string): Promise<void> {
    const last = await this.db.dealEvent.findFirst({ where: { dealId, type: "ORCHESTRATION_HALTED" }, orderBy: { seq: "desc" } });
    if ((last?.payload as { reason?: string } | undefined)?.reason === reason) return;
    await this.db.$transaction((tx) => appendEvent(tx, dealId, "ORCHESTRATION_HALTED", "orchestrator", { reason }));
  }

  private async isOwner(dealId: string, principalId: string): Promise<boolean> {
    return (await this.db.deal.count({ where: { id: dealId, mandate: { principalId } } })) === 1;
  }
}
