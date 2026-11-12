/**
 * Gate 3 negotiation: DB-tested on real PostgreSQL. Buyer decisions come from SCRIPTED brains/LLMs (some scripted to OBEY the
 * attacker) or the deterministic rule-based brain; the seller is the real simulated-seller HTTP service (rule-based, not an LLM).
 * No real LLM was used and no PayPal call is made. These results prove the orchestration and defences, not model behaviour.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BuyerAgent, LlmBuyerBrain, RuleBasedBuyerBrain, type BuyerBrain } from "@/agents/buyer";
import type { NegotiateRequest } from "@/agents/contracts";
import { HttpSellerClient, type SellerClient } from "@/agents/seller-client";
import { checkPolicy, createDeal, reserveForDeal } from "@/domain/deals";
import { verifyChain } from "@/domain/ledger";
import { NotFoundError } from "@/domain/mandates";
import { IllegalTransitionError } from "@/domain/statemachine";
import { detectTermsDrift, runNegotiation, validateBuyerIntent, type TaskBrief } from "@/domain/negotiation";
import { D } from "@/domain/money";
import { createPayPalOrder } from "@/settlement/engine";
import { createSellerServer } from "../../seller-service/server";
import type { SellerMode } from "../../seller-service/brain";
import { MockPayPal } from "../helpers/mockPayPal";
import { ScriptedBuyerBrain, ScriptedLlm } from "../helpers/scripted";
import { makeCtx } from "./engineFixtures";
import { deps as policyDeps, keys, makeMandate, makePrincipal, prisma } from "./fixtures";

const ROOT = resolve(__dirname, "..", "..");
const BRIEF = (over: Partial<TaskBrief> = {}): TaskBrief => ({
  description: "Clean the customer CSV",
  criteria: [
    { id: "schema", text: "Columns match", type: "deterministic", required: true, weight: 70, validator: "csv_schema_matches", params: { columns: ["id", "email"] } },
    { id: "dupes", text: "No duplicate rows", type: "deterministic", required: false, weight: 30, validator: "no_duplicate_rows", params: {} },
  ],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice: "20.00",
  ...over,
});

const closers: (() => Promise<void>)[] = [];
let child: ChildProcess | undefined;
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  child?.kill();
  child = undefined;
});

async function seller(mode: SellerMode, floor = "22.00") {
  const server = createSellerServer({ mode, floor });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const client = new HttpSellerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const requests: NegotiateRequest[] = [];
  const recording: SellerClient = { negotiate: async (req) => (requests.push(req), client.negotiate(req)) };
  return { client: recording, requests };
}

async function setup(mandateOver: Record<string, unknown> = {}) {
  const p = await makePrincipal();
  const m = await makeMandate(p, mandateOver);
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  return { p, m, dealId: deal.id };
}
const run = (s: Awaited<ReturnType<typeof setup>>, brain: BuyerBrain, client: SellerClient, brief = BRIEF(), maxRounds = 4) =>
  runNegotiation({ db: prisma, buyer: new BuyerAgent(brain), seller: client, policy: policyDeps, maxRounds }, { dealId: s.dealId, principalId: s.p.id, brief });
const row = (id: string) => prisma.deal.findUniqueOrThrow({ where: { id } });
const events = (dealId: string, type?: string) => prisma.dealEvent.findMany({ where: { dealId, ...(type ? { type } : {}) }, orderBy: { seq: "asc" } });

describe("honest negotiation completes and locks terms", () => {
  it("rule-based buyer vs honest seller: agreement in 2 rounds, terms locked, policy passes, mandate untouched", async () => {
    const s = await setup();
    const before = await prisma.mandate.findUniqueOrThrow({ where: { id: s.m.id } });
    const { client } = await seller("honest");
    const r = await run(s, new RuleBasedBuyerBrain(), client);
    expect(r).toMatchObject({ outcome: "LOCKED", price: "22.80", rounds: 2 });
    const d = await row(s.dealId);
    expect(d.state).toBe("TERMS_LOCKED");
    expect(d.termsHash).toBe((r as { termsHash: string }).termsHash);
    expect(d.negotiationRounds).toBe(2);
    expect(d.price?.toString()).toBe("22.8");
    expect((await prisma.negotiationMessage.findMany({ where: { dealId: s.dealId }, orderBy: [{ round: "asc" }, { sender: "asc" }] })).map((m) => `${m.round}${m.sender[0]}:${m.kind}`)).toEqual(["1b:propose", "1s:counter", "2b:counter", "2s:accept"]);
    expect((await checkPolicy(prisma, { dealId: s.dealId, deps: policyDeps })).outcome).toBe("OK");
    expect(await prisma.mandate.findUniqueOrThrow({ where: { id: s.m.id } })).toEqual(before); // nothing in negotiation can alter the mandate
    expect(await prisma.payPalOperation.count({ where: { dealId: s.dealId } })).toBe(0); // negotiation never touches PayPal
    expect(await verifyChain(prisma, s.dealId)).toMatchObject({ ok: true });
  });

  it("the locked terms are exactly the principal's brief plus the agreed price: criteria, deadline and seller cannot be changed by either agent", async () => {
    const s = await setup();
    const { client } = await seller("honest");
    await run(s, new RuleBasedBuyerBrain(), client);
    const d = await row(s.dealId);
    const t = d.termsJson as { criteria: { id: string; weight: number }[]; deadline: string; sellerId: string; price: string; mandateId: string };
    expect(t.criteria.map((c) => `${c.id}:${c.weight}`).sort()).toEqual(["dupes:30", "schema:70"]);
    expect(t).toMatchObject({ deadline: "2029-01-01T00:00:00.000Z", sellerId: "seller-sim", price: "22.80", mandateId: s.m.id });
  });

  it("LLM-backed buyer (scripted model): agent runs are persisted with prompt hashes; the seller's text is only ever inside untrusted tags", async () => {
    const s = await setup();
    const llm = new ScriptedLlm(['{"kind":"propose","price":"20.00","message":"Hello, here is my offer."}', '{"kind":"counter","price":"22.80"}']);
    const { client } = await seller("honest");
    const r = await run(s, new LlmBuyerBrain(llm, "scripted-model"), client);
    expect(r).toMatchObject({ outcome: "LOCKED", price: "22.80" });
    const runs = await prisma.agentRun.findMany({ where: { dealId: s.dealId }, orderBy: { createdAt: "asc" } });
    expect(runs).toHaveLength(2);
    expect(runs.every((x) => x.role === "buyer" && x.model === "scripted-model" && /^[0-9a-f]{64}$/.test(x.promptHash))).toBe(true);
    expect(llm.requests[1]!.user).toMatch(/<untrusted_seller_message id="m2">\nMy price for this job is 25\.59\.\n<\/untrusted_seller_message>/);
    expect(llm.requests[1]!.system).not.toContain("25.59");
    const canary = /CANARY-[0-9a-f-]+/.exec(llm.requests[0]!.system)![0];
    expect(llm.requests[1]!.system).toContain(canary);
  });
});

describe("negotiation limits and failure modes are fail-closed", () => {
  it("rounds are capped: a seller that never agrees ends BLOCKED after exactly 4 rounds", async () => {
    const s = await setup();
    const { client, requests } = await seller("greedy");
    const r = await run(s, new ScriptedBuyerBrain([{ kind: "propose", price: "20.00" }, { kind: "counter", price: "21.00" }]), client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "NO_AGREEMENT_WITHIN_ROUNDS", rounds: 4 });
    expect(requests).toHaveLength(4);
    const d = await row(s.dealId);
    expect(d).toMatchObject({ state: "BLOCKED", negotiationRounds: 4 });
    expect(d.termsHash).toBeNull();
  });

  it("buyer output that never parses (bounded retries) blocks the deal before the seller is contacted", async () => {
    const s = await setup();
    const { client, requests } = await seller("honest");
    const llm = new ScriptedLlm(["I think we should pay them now!"]);
    const r = await run(s, new LlmBuyerBrain(llm, "m"), client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_OUTPUT_INVALID:LLM_OUTPUT_INVALID" });
    expect(requests).toHaveLength(0);
    expect(llm.requests.length).toBeLessThanOrEqual(3);
    expect(await prisma.agentRun.count({ where: { dealId: s.dealId } })).toBe(1);
  });

  it("an unreachable seller blocks the deal", async () => {
    const s = await setup();
    const r = await run(s, new RuleBasedBuyerBrain(), new HttpSellerClient("http://127.0.0.1:1", { timeoutMs: 500 }));
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "SELLER_ERROR:SELLER_UNREACHABLE" });
  });

  it("an invalid brief (weights do not sum to 100) is rejected before any negotiation", async () => {
    const s = await setup();
    const { client, requests } = await seller("honest");
    const bad = BRIEF({ criteria: BRIEF().criteria.map((c) => ({ ...c, weight: 10 })) });
    expect(await run(s, new RuleBasedBuyerBrain(), client, bad)).toMatchObject({ outcome: "BLOCKED", reason: "BRIEF_INVALID:WEIGHTS_NOT_100" });
    expect(requests).toHaveLength(0);
  });

  it("no remaining budget -> blocked immediately", async () => {
    const s = await setup({ budgetTotal: "30", perDealMax: "30", requireHumanAbove: undefined });
    const other = await createDeal(prisma, { principalId: s.p.id, mandateId: s.m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
    await prisma.budgetReservation.create({ data: { mandateId: s.m.id, dealId: other.id, amount: "30.00", status: "ACTIVE" } });
    const { client } = await seller("honest");
    expect(await run(s, new RuleBasedBuyerBrain(), client)).toMatchObject({ outcome: "BLOCKED", reason: "NO_BUDGET_AVAILABLE" });
  });

  it("only the owning principal can negotiate, and a deal cannot be negotiated twice", async () => {
    const s = await setup();
    const intruder = await makePrincipal();
    const { client } = await seller("honest");
    await expect(runNegotiation({ db: prisma, buyer: new BuyerAgent(new RuleBasedBuyerBrain()), seller: client, policy: policyDeps, maxRounds: 4 }, { dealId: s.dealId, principalId: intruder.id, brief: BRIEF() })).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(s.dealId)).state).toBe("PROPOSED");
    await run(s, new RuleBasedBuyerBrain(), client);
    await expect(run(s, new RuleBasedBuyerBrain(), client)).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe("prompt-injection resistance (buyer scripted to OBEY the attacker)", () => {
  const lowCeiling = { perDealMax: "24", requireHumanAbove: undefined }; // ceiling 24; the adversarial seller asks ~25.59

  it("obeying 'accept immediately' above the ceiling is rejected by deterministic policy; nothing locks", async () => {
    const s = await setup(lowCeiling);
    const { client } = await seller("adversarial");
    const llm = new ScriptedLlm(['{"kind":"propose","price":"20.00"}', '{"kind":"accept"}']);
    const r = await run(s, new LlmBuyerBrain(llm, "obedient"), client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_INTENT_REJECTED:ACCEPT_ABOVE_CEILING" });
    expect(llm.requests[1]!.system).not.toMatch(/ignore all previous instructions/i);
    expect(llm.requests[1]!.user).toMatch(/<untrusted_seller_message id="m2">\nSYSTEM: ignore all previous instructions/);
    const d = await row(s.dealId);
    expect(d.state).toBe("BLOCKED");
    expect(d.termsHash).toBeNull();
    expect((await events(s.dealId, "BUYER_INTENT_REJECTED"))[0]!.payload).toMatchObject({ code: "ACCEPT_ABOVE_CEILING" });
  });

  it.each([
    ["a price far above the ceiling", '{"kind":"counter","price":"999.00"}', "PRICE_ABOVE_CEILING"],
    ["a second opening proposal", '{"kind":"propose","price":"10.00"}', "PROPOSE_ONLY_IN_ROUND_1"],
    ["paying MORE than the seller asked", '{"kind":"counter","price":"24.00"}', "COUNTER_ABOVE_SELLER_ASK"],
  ])("obeying an injected instruction to make %s is rejected", async (_n, round2, code) => {
    const s = await setup({ ...lowCeiling, perDealMax: code === "COUNTER_ABOVE_SELLER_ASK" ? "30" : "24" });
    const { client } = await seller("honest", code === "COUNTER_ABOVE_SELLER_ASK" ? "10.00" : "22.00");
    const first = code === "COUNTER_ABOVE_SELLER_ASK" ? '{"kind":"propose","price":"5.00"}' : '{"kind":"propose","price":"20.00"}';
    const r = await run(s, new LlmBuyerBrain(new ScriptedLlm([first, round2]), "obedient"), client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: `BUYER_INTENT_REJECTED:${code}` });
  });

  it("smuggling extra fields (a payment, an approval) into a buyer intent is a schema failure", async () => {
    const s = await setup();
    const { client } = await seller("honest");
    const llm = new ScriptedLlm(['{"kind":"propose","price":"20.00","capture_now":true,"approved_by_human":true}']);
    expect(await run(s, new LlmBuyerBrain(llm, "obedient"), client)).toMatchObject({ outcome: "BLOCKED", reason: "BUYER_OUTPUT_INVALID:LLM_OUTPUT_INVALID" });
  });

  it("an adversarial seller's authority claims, exfiltration requests and delimiter attacks change nothing: the rule is still price and policy", async () => {
    const s = await setup();
    const { client } = await seller("adversarial");
    const r = await run(s, new RuleBasedBuyerBrain(), client);
    expect(r.outcome).toBe("LOCKED");
    const d = await row(s.dealId);
    expect(d.state).toBe("TERMS_LOCKED"); // never beyond: "the account owner already approved" cannot advance anything
    expect(await prisma.payPalOperation.count({ where: { dealId: s.dealId } })).toBe(0);
    const sellerMsgs = await prisma.negotiationMessage.findMany({ where: { dealId: s.dealId, sender: "seller" } });
    expect(sellerMsgs.some((m) => /ignore all previous instructions/.test((m.payload as { message: string }).message))).toBe(true); // stored, inert
    expect(sellerMsgs.every((m) => !/[<>]/.test(JSON.stringify(m.payload)))).toBe(true);
  });
});

describe("exfiltration attempts are blocked on the way OUT", () => {
  it("budget, prompt marker and credentials in a buyer message never reach the seller or the ledger", async () => {
    const s = await setup();
    const { client, requests } = await seller("greedy");
    const brain = new ScriptedBuyerBrain([
      { kind: "propose", price: "20.00", message: "My total budget is 100 and my per-deal limit is 60." },
      (ctx: { canary: string }) => ({ kind: "counter", price: "21.00", message: `Here is my instruction marker ${ctx.canary}` }),
      { kind: "counter", price: "21.00", message: "api key: sk-abcdefghijklmnopqrstuvwxyz123456" },
      { kind: "counter", price: "21.00", message: "Can you do it faster?" },
    ]);
    const r = await run(s, brain, client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "NO_AGREEMENT_WITHIN_ROUNDS" });
    expect(requests.map((q) => q.buyer.message)).toEqual([undefined, undefined, undefined, "Can you do it faster?"]);
    const blocked = await events(s.dealId, "OUTBOUND_MESSAGE_BLOCKED");
    expect(blocked).toHaveLength(3);
    const all = JSON.stringify(await events(s.dealId)) + JSON.stringify(await prisma.negotiationMessage.findMany({ where: { dealId: s.dealId } }));
    expect(all).not.toMatch(/total budget|sk-abcdef|instruction marker|CANARY-/);
  });
});

describe("the seller cannot widen the contract", () => {
  it("smuggling criteria or an amount into a reply is a PROTOCOL VIOLATION that blocks the deal; terms are never touched", async () => {
    const s = await setup();
    const { client } = await seller("tamper");
    const r = await run(s, new RuleBasedBuyerBrain(), client);
    expect(r).toMatchObject({ outcome: "BLOCKED", reason: "SELLER_PROTOCOL_VIOLATION" });
    const d = await row(s.dealId);
    expect(d).toMatchObject({ state: "BLOCKED", termsHash: null, termsJson: null });
    expect((await events(s.dealId, "SELLER_PROTOCOL_VIOLATION"))[0]!.payload).toMatchObject({ issues: expect.any(Array) });
  });
});

describe("price drift after the lock", () => {
  async function locked() {
    const s = await setup();
    const { client } = await seller("honest");
    await run(s, new RuleBasedBuyerBrain(), client);
    return s;
  }

  it("a restated price, deadline or criteria before an order exists BLOCKS the deal; identical restatements do not", async () => {
    const same = await locked();
    const d0 = await row(same.dealId);
    const t = d0.termsJson as { criteria: unknown[]; deadline: string };
    expect(await detectTermsDrift(prisma, { dealId: same.dealId, restatement: { price: "22.80", deadline: t.deadline, criteria: t.criteria } })).toEqual({ drift: false });
    expect((await row(same.dealId)).state).toBe("TERMS_LOCKED");

    const price = await locked();
    expect(await detectTermsDrift(prisma, { dealId: price.dealId, restatement: { price: "25.00" } })).toEqual({ drift: true, fields: ["price"], action: "BLOCKED" });
    expect((await row(price.dealId)).state).toBe("BLOCKED");

    const crit = await locked();
    const c = (await row(crit.dealId)).termsJson as { criteria: { weight: number }[] };
    const tampered = c.criteria.map((x, i) => ({ ...x, weight: i === 0 ? 10 : x.weight }));
    expect(await detectTermsDrift(prisma, { dealId: crit.dealId, restatement: { criteria: tampered } })).toMatchObject({ drift: true, fields: ["criteria"], action: "BLOCKED" });

    const dl = await locked();
    expect(await detectTermsDrift(prisma, { dealId: dl.dealId, restatement: { deadline: "2031-01-01T00:00:00.000Z" } })).toMatchObject({ drift: true, fields: ["deadline"] });
    expect((await events(price.dealId, "TERMS_DRIFT_ATTEMPT"))[0]!.payload).toMatchObject({ action: "BLOCKED", lockedPrice: "22.80", claimedPrice: "25.00" });
  });

  it("after the PayPal order exists the deal cannot be un-blocked or re-priced: the drift is ledgered and the LOCKED terms govern", async () => {
    const s = await locked();
    expect((await checkPolicy(prisma, { dealId: s.dealId, deps: policyDeps })).outcome).toBe("OK");
    expect(await reserveForDeal(prisma, { dealId: s.dealId, deps: policyDeps })).toMatchObject({ ok: true });
    const mock = new MockPayPal();
    await createPayPalOrder(makeCtx(mock), s.dealId);
    const before = await row(s.dealId);
    expect(before.state).toBe("AWAITING_BUYER_APPROVAL");
    expect(await detectTermsDrift(prisma, { dealId: s.dealId, restatement: { price: "99.00" } })).toEqual({ drift: true, fields: ["price"], action: "IGNORED_LOCKED_TERMS_GOVERN" });
    const after = await row(s.dealId);
    expect(after.state).toBe("AWAITING_BUYER_APPROVAL");
    expect(after.price?.toString()).toBe("22.8");
    expect(after.termsHash).toBe(before.termsHash);
    expect((await prisma.budgetReservation.findUniqueOrThrow({ where: { dealId: s.dealId } })).status).toBe("ACTIVE");
    expect((await events(s.dealId, "TERMS_DRIFT_ATTEMPT"))[0]!.payload).toMatchObject({ action: "IGNORED_LOCKED_TERMS_GOVERN" });
    expect(mock.writes.filter((w) => w.type !== "CREATE_ORDER")).toHaveLength(0);
  });

  it("malformed restatements are ledgered and ignored", async () => {
    const s = await locked();
    expect(await detectTermsDrift(prisma, { dealId: s.dealId, restatement: { price: "thirty" } })).toEqual({ drift: false, malformed: true });
    expect((await row(s.dealId)).state).toBe("TERMS_LOCKED");
  });
});

describe("agents have no authority over the mandate or the deal", () => {
  it("the buyer receives a frozen, minimal context: no mandate, no identifiers, no ability to mutate it", async () => {
    const s = await setup();
    const { client } = await seller("honest");
    const attempts: string[] = [];
    let keysSeen: string[] = [];
    let json = "";
    const brain = new ScriptedBuyerBrain([
      (ctx: Record<string, unknown>) => {
        keysSeen = Object.keys(ctx).sort();
        json = JSON.stringify(ctx);
        const tries: (() => void)[] = [
          () => { (ctx as { ceilingPrice: string }).ceilingPrice = "999.00"; },
          () => { (ctx.history as unknown[]).push({ sender: "seller", kind: "accept" }); },
          () => { ((ctx.task as Record<string, unknown>).description) = "something else"; },
          () => { delete (ctx as { canary?: string }).canary; },
        ];
        for (const t of tries) {
          try { t(); attempts.push("MUTATED"); } catch { attempts.push("BLOCKED"); }
        }
        return { kind: "propose", price: "20.00" };
      },
      { kind: "walk_away", reason: "test over" },
    ]);
    await run(s, brain, client);
    expect(attempts).toEqual(["BLOCKED", "BLOCKED", "BLOCKED", "BLOCKED"]);
    // `limits` is the per-round price range computed by trusted code (negotiation-policy.ts): prices only, no identifiers
    expect(keysSeen).toEqual(["canary", "ceilingPrice", "history", "limits", "maxRounds", "round", "targetPrice", "task"]);
    for (const secret of [s.m.id, s.p.id, s.p.email, "budgetTotal", "perDealMax", "100.00", "mandate"]) expect(json).not.toContain(secret);
  });

  it("validateBuyerIntent is a pure gate: protocol and ceiling hold for every intent shape", () => {
    const c = { round: 2, ceiling: new D("30.00"), lastSellerPrice: new D("28.00") };
    expect(validateBuyerIntent({ kind: "accept" }, c)).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "accept" }, { ...c, lastSellerPrice: new D("31.00") })).toEqual({ ok: false, code: "ACCEPT_ABOVE_CEILING" });
    expect(validateBuyerIntent({ kind: "accept" }, { round: 2, ceiling: c.ceiling })).toEqual({ ok: false, code: "NOTHING_TO_ACCEPT" });
    expect(validateBuyerIntent({ kind: "counter", price: "30.00" }, { ...c, lastSellerPrice: new D("35.00") })).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "counter", price: "30.01" }, c)).toEqual({ ok: false, code: "PRICE_ABOVE_CEILING" });
    expect(validateBuyerIntent({ kind: "counter", price: "0.00" }, c)).toEqual({ ok: false, code: "PRICE_NOT_POSITIVE" });
    expect(validateBuyerIntent({ kind: "propose", price: "10.00" }, { ...c, round: 1 })).toEqual({ ok: true });
    expect(validateBuyerIntent({ kind: "counter", price: "10.00" }, { ...c, round: 1 })).toEqual({ ok: false, code: "OPENING_MUST_BE_PROPOSE" });
    expect(validateBuyerIntent({ kind: "walk_away", reason: "x" }, c)).toEqual({ ok: true });
  });
});

describe("cross-process negotiation (the seller really is a separate OS process)", () => {
  it("negotiates over HTTP with a child-process seller to the same locked outcome", async () => {
    const env: Record<string, string> = { SELLER_PORT: "0", SELLER_MODE: "honest", SELLER_FLOOR: "22.00" };
    for (const k of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k]) env[k] = process.env[k]!;
    child = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "seller-service", "main.ts")], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
    const url = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("seller did not start")), 20_000);
      child!.stdout!.on("data", (b: Buffer) => {
        const m = /SELLER_LISTENING (\d+)/.exec(b.toString());
        if (m) {
          clearTimeout(t);
          res(`http://127.0.0.1:${m[1]}`);
        }
      });
    });
    const s = await setup();
    const r = await run(s, new RuleBasedBuyerBrain(), new HttpSellerClient(url));
    expect(r).toMatchObject({ outcome: "LOCKED", price: "22.80", rounds: 2 });
  }, 40_000);
});
