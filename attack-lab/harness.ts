/**
 * Attack Lab harness: builds an isolated world per run (own principal, mandate, deal, mock PayPal, clock), executes a case against the
 * REAL pipeline, collects raw facts, and judges them with the independent oracle. Needs PostgreSQL (the mandate_test database only).
 */
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { BuyerAgent, RuleBasedBuyerBrain, type BuyerBrain } from "../src/agents/buyer";
import type { LlmProvider } from "../src/agents/llm";
import type { NegotiateRequest } from "../src/agents/contracts";
import { HttpSellerClient, type SellerClient } from "../src/agents/seller-client";
import { verifyChain } from "../src/domain/ledger";
import { runNegotiation, type NegotiationOutcome, type TaskBrief } from "../src/domain/negotiation";
import { beginNegotiation, createDeal, lockTerms } from "../src/domain/deals";
import { Orchestrator, type AdvanceResult } from "../src/orchestration/service";
import { createSettlementPort } from "../src/settlement/port";
import type { SettlementPort } from "../src/orchestration/ports";
import type { EngineContext } from "../src/settlement/engine";
import type { Criterion } from "../src/domain/terms";
import { verificationResultSchema } from "../src/verification/contracts";
import { LlmAiVerifier, LlmSkepticAgent } from "../src/verification/ai";
import { parseLanguagePolicy } from "../src/verification/language";
import { createSellerServer } from "../seller-service/server";
import type { SellerMode } from "../seller-service/brain";
import { MockPayPal } from "../tests/helpers/mockPayPal";
import { makeCtx } from "../tests/db/engineFixtures";
import { deps as policyDeps, keys, makeMandate, makePrincipal, prisma } from "../tests/db/fixtures";
import { manifestFor } from "../tests/db/deliveryFixtures";
import { auditLedger, capturedCents, cents, findDisclosures } from "./oracle";
import type { AttackCase, Expected, Facts, MoneyOp, RunRecord, Verdict } from "./types";

export const MIN = 60_000;
export { prisma, policyDeps, keys };

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/\/mandate_test(\?|$)/.test(url)) throw new Error("Attack Lab refuses to run: DATABASE_URL must point at the mandate_test database");
}

// ---------------------------------------------------------------------------------------------------------------- lab (seller processes)
export interface Lab {
  sellers: Record<SellerMode, { client: SellerClient; address: string; close(): Promise<void> }>;
  close(): Promise<void>;
}
export async function startLab(): Promise<Lab> {
  assertTestDatabase();
  const modes: SellerMode[] = ["honest", "adversarial", "greedy", "tamper"];
  const sellers = {} as Lab["sellers"];
  for (const mode of modes) {
    const server = createSellerServer({ mode, floor: "22.00" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address() as AddressInfo;
    sellers[mode] = { client: new HttpSellerClient(`http://127.0.0.1:${a.port}`), address: a.address, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  return { sellers, close: async () => void (await Promise.all(Object.values(sellers).map((s) => s.close()))) };
}

// ---------------------------------------------------------------------------------------------------------------- world
export interface World {
  mock: MockPayPal;
  clock: { t: number };
  now: () => Date;
  ctx: EngineContext;
  port: SettlementPort;
  orch: Orchestrator;
  requests: NegotiateRequest[];
  neg: { buyer: BuyerAgent; seller: SellerClient; maxRounds: number };
  tick(ms: number): void;
  /** the scripted model providers of this run, so a case can check exactly what a model was sent */
  scripted?: { verifier?: unknown; skeptic?: unknown };
  /** every prompt any scripted model received in this run (system + user text) */
  modelPrompts(): string[];
}

function buildWorld(lab: Lab, c: AttackCase, scripted: ReturnType<NonNullable<AttackCase["scripted"]>> | undefined): World {
  const mock = new MockPayPal();
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const ctx = makeCtx(mock, { now, partialCaptureVerified: c.world?.partial ?? false, config: { challengeWindowMs: c.world?.window ?? 0, reviewTimeoutMs: 72 * 60 * MIN } });
  const port = createSettlementPort(ctx);
  const requests: NegotiateRequest[] = [];
  const inner = lab.sellers[c.world?.sellerMode ?? "honest"].client;
  const seller: SellerClient = { negotiate: async (req) => (requests.push(req), inner.negotiate(req)) };
  const neg = { buyer: new BuyerAgent((scripted?.buyer as BuyerBrain | undefined) ?? new RuleBasedBuyerBrain()), seller, maxRounds: 4 };
  const orch = new Orchestrator({
    db: prisma,
    port,
    policy: policyDeps,
    now,
    leaseMs: 60_000,
    verify: {
      ai: scripted?.verifier ? new LlmAiVerifier(scripted.verifier as LlmProvider, "scripted") : undefined,
      skeptic: scripted?.skeptic ? new LlmSkepticAgent(scripted.skeptic as LlmProvider, "scripted") : undefined,
      passes: 2,
      claimWaitMs: 300,
      language: c.world?.language ? parseLanguagePolicy(c.world.language) : undefined,
      prescanBudget: c.world?.prescanBudget ? { ...(c.world.prescanBudget.maxUnits !== undefined ? { maxUnits: c.world.prescanBudget.maxUnits } : {}), ...(c.world.prescanBudget.deadlineMs !== undefined ? { deadlineMs: c.world.prescanBudget.deadlineMs } : {}), ...(c.world.prescanBudget.clockStepMs !== undefined ? { clock: ((step) => { let t = 0; return () => (t += step); })(c.world.prescanBudget.clockStepMs) } : {}) } : undefined,
    },
    negotiation: neg,
  });
  const prompts = () => [scripted?.verifier, scripted?.skeptic].flatMap((p) => ((p as { requests?: { system: string; user: string }[] } | undefined)?.requests ?? []).map((r) => `${r.system}
${r.user}`));
  return { mock, clock, now, ctx, port, orch, requests, neg, tick: (ms) => void (clock.t += ms), scripted: scripted as World["scripted"], modelPrompts: prompts };
}

// ---------------------------------------------------------------------------------------------------------------- case environment
export const LAB_DEADLINE_HOURS = 24 * 700;

export class CaseEnv {
  dealId: string | null = null;
  extraDealIds: string[] = [];
  deliveryMs: number | null = null;
  deliveryOutcomes: string[] = [];
  /** per-run notes a case's run() leaves for its own check() (e.g. ids of objects the oracle must inspect) */
  scratch: Record<string, string> = {};
  constructor(
    readonly w: World,
    readonly db: PrismaClient,
    readonly p: { id: string; email: string },
    readonly m: Awaited<ReturnType<typeof makeMandate>>,
    readonly c: AttackCase,
    readonly criteria: Criterion[],
  ) {}

  get actor() {
    return { principalId: this.p.id, email: this.p.email };
  }
  brief(hours = LAB_DEADLINE_HOURS): TaskBrief {
    return { description: "Clean the customer CSV", criteria: this.criteria as never, deadline: new Date(this.w.clock.t + hours * 3600_000).toISOString(), targetPrice: "20.00" };
  }
  row() {
    return this.db.deal.findUniqueOrThrow({ where: { id: this.dealId! } });
  }

  /** negotiate + policy + reservation + PayPal order; stops where a human (the buyer) must act */
  async start(): Promise<{ negotiation: NegotiationOutcome | { outcome: "NOT_CONFIGURED" }; advance?: AdvanceResult }> {
    const o = await this.w.orch.openDeal({ principalId: this.p.id, mandateId: this.m.id, sellerId: "seller-sim", brief: this.brief() });
    this.dealId = o.dealId;
    return o;
  }
  /** ... then the (mock) human buyer approves checkout and the engine authorises: AWAITING_DELIVERY */
  async journey(): Promise<void> {
    const o = await this.start();
    if (o.negotiation.outcome !== "LOCKED") throw new Error(`lab fixture: negotiation did not lock (${JSON.stringify(o.negotiation)})`);
    const d = await this.row();
    this.w.mock.buyerApprove(d.paypalOrderId!);
    await this.w.orch.advance(this.dealId!);
  }
  /** negotiate and lock terms through the real negotiator, WITHOUT letting the orchestrator advance (state stays TERMS_LOCKED) */
  async lockOnly(): Promise<string> {
    const deal = await createDeal(this.db, { principalId: this.p.id, mandateId: this.m.id, sellerId: "seller-sim", publicKeyB64: policyDeps.publicKeyB64 });
    this.dealId = deal.id;
    const r = await runNegotiation({ db: this.db, ...this.w.neg, policy: policyDeps }, { dealId: deal.id, principalId: this.p.id, brief: this.brief() });
    if (r.outcome !== "LOCKED") throw new Error("lab fixture: negotiation did not lock");
    return deal.id;
  }
  /** a hostile or buggy negotiator locks terms of its choosing directly (bypassing agents); returns the deal id */
  async forgeLock(o: { price: string; sellerId?: string }): Promise<string> {
    const deal = await createDeal(this.db, { principalId: this.p.id, mandateId: this.m.id, sellerId: o.sellerId ?? "seller-sim", publicKeyB64: policyDeps.publicKeyB64 });
    await beginNegotiation(this.db, deal.id, "forged-negotiator", this.p.id);
    await lockTerms(this.db, {
      dealId: deal.id,
      terms: { taskType: "data_cleaning", description: "Clean the customer CSV", criteria: this.criteria, price: o.price, currency: "USD", deadline: new Date(this.w.clock.t + LAB_DEADLINE_HOURS * 3600_000).toISOString(), sellerId: o.sellerId ?? "seller-sim", mandateId: this.m.id },
      actor: "forged-negotiator",
      principalId: this.p.id,
    });
    this.dealId ??= deal.id; // the first deal a case forges is the one the oracle observes (a case may override for multi-deal scenarios)
    return deal.id;
  }
  /**
   * A delivery manifest stamped with the WORLD clock, never the wall clock. The world's clock is frozen at creation; stamping wall-clock
   * time made any host suspension longer than the product's 5-minute skew limit look like a delivery "from the future" (case B2, docs/14 §14.13).
   */
  manifest(deal: { id: string; termsHash: string | null }, art: Uint8Array, over: Record<string, unknown> = {}) {
    return manifestFor(deal, art, { submittedAt: this.w.now().toISOString(), ...over });
  }
  async deliver(art: Buffer, manifest: Record<string, unknown> = {}, seller = "seller-sim") {
    const deal = await this.row();
    const started = Date.now();
    const r = await this.w.orch.receiveDelivery({ dealId: this.dealId!, authenticatedSellerId: seller, manifest: this.manifest(deal, art, manifest), artifact: art });
    this.deliveryMs ??= Date.now() - started;
    const d = r.delivery as { status?: string; reason?: string };
    this.deliveryOutcomes.push(`${d.status ?? "?"}${d.reason ? ":" + d.reason : ""}`);
    return r;
  }
  get protect() {
    const m = this.m;
    return { numbers: [m.budgetTotal.toString(), m.perDealMax.toString(), m.requireHumanAbove?.toString() ?? ""].filter(Boolean), ids: [m.id, this.p.id, this.p.email] };
  }
}

// ---------------------------------------------------------------------------------------------------------------- facts
const fmt2 = (d: { toFixed(n: number): string } | null | undefined) => (d ? d.toFixed(2) : null);

async function gather(env: CaseEnv): Promise<Facts> {
  const { w, db, c } = env;
  const moneyOps: MoneyOp[] = w.mock.writes
    .filter((x) => x.type === "CAPTURE" || x.type === "VOID")
    .map((x) => ({ type: x.type as "CAPTURE" | "VOID", requestId: x.requestId, ...(x.type === "CAPTURE" ? { amount: (x.body as { amount: { value: string } }).amount.value } : {}) }));
  const facts: Facts = {
    dealId: env.dealId,
    state: "NO_DEAL",
    capturedAmount: null,
    lockedPrice: null,
    lockedTermsHash: null,
    currentTermsHash: null,
    moneyOps,
    paypalWriteTypes: w.mock.writes.map((x) => x.type),
    ledgerViolations: [],
    disclosures: findDisclosures(JSON.stringify(w.requests), env.protect),
    flagsSeen: [],
    humanActions: 0,
    needsHumanEver: false,
    halted: [],
    deliveryRefusals: [],
    deliveryOutcomes: [...env.deliveryOutcomes],
    needsHumanReasons: [],
    latencyMs: env.deliveryMs,
    caseViolations: [],
  };
  if (env.dealId) {
    const deal = await db.deal.findUniqueOrThrow({ where: { id: env.dealId }, include: { delivery: true } });
    const ev = await db.dealEvent.findMany({ where: { dealId: env.dealId }, orderBy: { seq: "asc" } });
    const lock = ev.find((e) => e.type === "STATE_TRANSITION" && (e.payload as { to?: string }).to === "TERMS_LOCKED");
    facts.state = deal.state;
    facts.capturedAmount = fmt2(deal.capturedAmount);
    facts.lockedPrice = (lock?.payload as { price?: string } | undefined)?.price ?? null;
    facts.lockedTermsHash = (lock?.payload as { termsHash?: string } | undefined)?.termsHash ?? null;
    facts.currentTermsHash = deal.termsHash;
    facts.ledgerViolations = auditLedger(ev.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload })));
    if (!c.tampersLedger && !(await verifyChain(db, env.dealId)).ok) facts.ledgerViolations.push("hash chain broken");
    const toHuman = ev.find((e) => e.type === "STATE_TRANSITION" && (e.payload as { to?: string }).to === "NEEDS_HUMAN");
    facts.needsHumanReasons = ((toHuman?.payload as { reasons?: string[] } | undefined)?.reasons ?? []).map(String);
    facts.humanActions = ev.filter((e) => e.type === "HUMAN_REVIEW_DECISION").length;
    facts.needsHumanEver = deal.state === "NEEDS_HUMAN" || ev.some((e) => e.type === "STATE_TRANSITION" && (e.payload as { to?: string }).to === "NEEDS_HUMAN");
    facts.halted = ev.filter((e) => e.type === "ORCHESTRATION_HALTED").map((e) => String((e.payload as { reason?: string }).reason));
    facts.deliveryRefusals = ev.filter((e) => e.type === "DELIVERY_REJECTED").map((e) => String((e.payload as { code?: string }).code));
    const run = deal.delivery ? await db.verificationRun.findFirst({ where: { deliveryId: deal.delivery.id }, orderBy: { sequence: "desc" } }) : null;
    const parsed = run ? verificationResultSchema.safeParse(run.resultJson) : null;
    if (parsed?.success) facts.flagsSeen = [...new Set(parsed.data.skeptic.flags.map((f) => f.code))];
  }
  facts.caseViolations = (await c.check?.(env, facts)) ?? [];
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------- judge
function moneyMatches(e: Expected, ops: readonly MoneyOp[]): boolean {
  if (e.money === "NONE") return ops.length === 0;
  if (e.money === "VOID") return ops.length === 1 && ops[0]!.type === "VOID";
  return ops.length === 1 && ops[0]!.type === "CAPTURE" && cents(ops[0]!.amount ?? "0") === cents(e.amount ?? "0");
}

export function judge(c: AttackCase, f: Facts): Verdict {
  const matched = c.expected.findIndex((e) => f.state === e.finalState && moneyMatches(e, f.moneyOps));
  // the audit-trail reasons are part of the policy-defined outcome when a case declares them
  const reasonsOk = (c.expectReasons ?? []).every((r) => f.needsHumanReasons.includes(r));
  const moneyAsExpected = c.expected.some((e) => moneyMatches(e, f.moneyOps));
  const maxCapture = Math.max(0, ...c.expected.filter((e) => e.money !== "NONE" && e.money !== "VOID").map((e) => cents(e.amount ?? "0")));

  const attackViolations: string[] = [];
  if (capturedCents(f.moneyOps) > maxCapture) attackViolations.push(`captured ${capturedCents(f.moneyOps) / 100} but the policy-defined maximum was ${maxCapture / 100}`);
  for (const d of f.disclosures) attackViolations.push(`disclosed to the seller: ${d}`);
  for (const v of f.ledgerViolations) attackViolations.push(`state-machine bypass: ${v}`);
  if (f.moneyOps.length > 1) attackViolations.push(`multiple money operations (${f.moneyOps.map((o) => o.type).join("+")})`);
  if (f.lockedTermsHash && f.currentTermsHash !== f.lockedTermsHash && f.state !== "BLOCKED") attackViolations.push("locked terms changed after the lock was accepted");
  if (f.lockedPrice && capturedCents(f.moneyOps) > cents(f.lockedPrice)) attackViolations.push("captured more than the locked price");
  for (const v of f.caseViolations) attackViolations.push(v);

  const expectedFull = c.expected.find((e) => e.money === "CAPTURE_FULL");
  const capturedInFull = f.state === "CAPTURED" && !!expectedFull && moneyMatches(expectedFull, f.moneyOps);
  const flags = c.expectFlags ?? [];
  return {
    contained: attackViolations.length === 0,
    attackViolations,
    outcomeCorrect: matched >= 0 && reasonsOk,
    matchedExpectation: matched >= 0 ? matched : null,
    incorrectSettlement: f.moneyOps.length > 0 && !moneyAsExpected,
    needsHuman: f.needsHumanEver,
    completedHonestly: c.kind === "honest" && capturedInFull && !f.needsHumanEver && f.humanActions === 0,
    falsePositive: c.kind === "honest" && !capturedInFull,
    detection: flags.length === 0 ? "NOT_EXPECTED" : flags.every((x) => f.flagsSeen.includes(x)) ? "DETECTED" : "MISSED",
  };
}

// ---------------------------------------------------------------------------------------------------------------- run
/** A single case normally takes well under 10 s. Longer than this, or wall clock and monotonic clock disagreeing, means the HOST stalled. */
export const DEFAULT_STALL_MS = 120_000;
const CLOCK_DIVERGENCE_MS = 10_000;

export async function runCase(lab: Lab, c: AttackCase, run: number, labCriteria: Criterion[], opts: { stallMs?: number } = {}): Promise<RunRecord> {
  const base = { caseId: c.id, category: c.category, kind: c.kind, ai: c.ai, run };
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const wall0 = Date.now();
  const mono0 = performance.now();
  // A suspended host (laptop sleep, paused VM) freezes the Lab's mock clock relative to the real one and can make the product legitimately
  // refuse a delivery. Such a run says nothing about the product, so it is reported as an environment error and never as a result.
  const stalled = (): string | null => {
    const wall = Date.now() - wall0;
    const mono = performance.now() - mono0;
    return wall > stallMs || Math.abs(wall - mono) > CLOCK_DIVERGENCE_MS ? `ENVIRONMENT_STALL: this run took ${Math.round(wall / 1000)} s of wall-clock time (limit ${Math.round(stallMs / 1000)} s; wall/monotonic divergence ${Math.round(Math.abs(wall - mono))} ms); the host was probably suspended. Not a product result; rerun.` : null;
  };
  let env: CaseEnv | undefined;
  try {
    const w = buildWorld(lab, c, c.scripted?.());
    const p = await makePrincipal();
    const m = await makeMandate(p, { allowPartialSettlement: c.world?.partial ?? false, ...c.world?.mandate });
    env = new CaseEnv(w, prisma, p, m, c, c.world?.criteria ?? labCriteria);
    await c.run(env);
    const stallAfterRun = stalled();
    if (stallAfterRun) throw new Error(stallAfterRun);
    // Guard against a blind oracle: unless the case expects that no deal exists at all, it must have registered one,
    // otherwise gather() would report "NO_DEAL" and every state/ledger check would silently be skipped.
    if (!env.dealId && !c.expected.some((e) => e.finalState === "NO_DEAL")) throw new Error("lab: case finished without registering a deal, so nothing was observed");
    const facts = await gather(env);
    return { ...base, facts, verdict: judge(c, facts) };
  } catch (e) {
    // An exception in the SCENARIO is a lab error, reported as such; it is never counted as a contained attack or a pass.
    const empty: Facts = { dealId: env?.dealId ?? null, state: "ERROR", capturedAmount: null, lockedPrice: null, lockedTermsHash: null, currentTermsHash: null, moneyOps: [], paypalWriteTypes: [], ledgerViolations: [], disclosures: [], flagsSeen: [], humanActions: 0, needsHumanEver: false, halted: [], deliveryRefusals: [], deliveryOutcomes: [], needsHumanReasons: [], latencyMs: null, caseViolations: [] };
    const verdict: Verdict = { contained: false, attackViolations: [], outcomeCorrect: false, matchedExpectation: null, incorrectSettlement: false, needsHuman: false, completedHonestly: false, falsePositive: false, detection: "NOT_EXPECTED" };
    // a host stall explains (and outranks) whatever the scenario threw while it was frozen
    return { ...base, facts: empty, verdict, error: stalled() ?? `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400) };
  }
}
