/**
 * Demo approval boundary (hackathon): authenticated HTTP routes for mandates and deals, on real PostgreSQL (mandate_test). PayPal is a MOCK, there is no model, the route
 * handlers are called directly with real signed session cookies. The composition root (@/lib/runtime) is replaced by a test runtime so no network or real PayPal exists.
 *
 *   R1 nothing reaches a mandate, a deal or a payment operation without a valid session + same origin + CSRF token
 *   R2 identity comes only from the session; a body that names a principal is refused
 *   R3 ownership is checked before every approval, decision and advance; foreign and missing objects look identical (404)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ runtimeCalls: 0, mock: undefined as undefined | import("../helpers/mockPayPal").MockPayPal }));
const built = vi.hoisted(() => ({ rt: undefined as unknown as any }));

vi.mock("@/lib/runtime", async () => {
  const f = await import("./engineFixtures");
  const { MockPayPal } = await import("../helpers/mockPayPal");
  const { Orchestrator } = await import("@/orchestration/service");
  const { createSettlementPort } = await import("@/settlement/port");
  const { BuyerAgent, RuleBasedBuyerBrain } = await import("@/agents/buyer");
  const sellerAccepts = { negotiate: async (req: { buyer: { kind: string; price?: string } }) => ({ ok: true as const, body: { kind: "accept" as const, ...(req.buyer.price ? {} : {}) } }) };
  return {
    getRuntime: () => {
      probe.runtimeCalls++;
      if (!built.rt) {
        probe.mock = new MockPayPal();
        const ctx = f.makeCtx(probe.mock);
        const orchestrator = new Orchestrator({ db: f.prisma, port: createSettlementPort(ctx), policy: f.deps, negotiation: { buyer: new BuyerAgent(new RuleBasedBuyerBrain()), seller: sellerAccepts, maxRounds: 4 } });
        built.rt = { db: f.prisma, keys: f.keys, policy: f.deps, orchestrator, info: { paypal: "sandbox-live", sandboxWritesAuthorized: false, buyerBrain: "rule-based", llmVendor: null, llmModel: null, sellerConfigured: true, challengeWindowSeconds: 900, v2: "disabled" } };
      }
      return built.rt;
    },
  };
});

import { NextResponse } from "next/server";
import { prisma, keys, makeMandate, makePrincipal } from "./fixtures";
import { policyCheckedDeal } from "./engineFixtures";
import { createDeal } from "@/domain/deals";
import { createSession, SESSION_COOKIE, CSRF_HEADER } from "@/lib/session";
import { POST as previewPost } from "@/app/api/mandates/preview/route";
import { GET as mandatesGet, POST as mandatesPost } from "@/app/api/mandates/route";
import { GET as dealsGet, POST as dealsPost } from "@/app/api/deals/route";
import { GET as dealGet } from "@/app/api/deals/[id]/route";
import { POST as decisionPost } from "@/app/api/deals/[id]/decision/route";
import { POST as advancePost } from "@/app/api/deals/[id]/advance/route";

const APP = process.env.APP_URL!;
const SECRET = process.env.SESSION_SECRET!;
type User = { id: string; email: string };

function authed(user: User, over: { body?: unknown; csrf?: boolean; origin?: string | null; secret?: string; ttlPast?: boolean; method?: string } = {}) {
  const now = over.ttlPast ? Math.floor(Date.now() / 1000) - 9 * 3600 : undefined;
  const { token, payload } = createSession(user, over.secret ?? SECRET, now);
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" };
  if (over.origin !== null) headers.origin = over.origin ?? APP;
  if (over.csrf !== false) headers[CSRF_HEADER] = payload.csrf;
  return new Request(`${APP}/api/x`, { method: over.method ?? "POST", headers, body: over.body === undefined ? undefined : JSON.stringify(over.body) });
}
const anonymous = (body?: unknown, method = "POST") => new Request(`${APP}/api/x`, { method, headers: { origin: APP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", requireHumanAbove: "50", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
const brief = { description: "Clean the CSV", criteria: [{ id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: true, weight: 100 }], deadline: "2029-01-01T00:00:00.000Z", targetPrice: "20.00" };
const json = async (r: Response | NextResponse) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

beforeEach(() => {
  probe.runtimeCalls = 0;
  probe.mock = undefined;
  built.rt = undefined;
});

describe("R1: nothing is reachable without a valid session, origin and CSRF token", () => {
  const mutating: [string, (r: Request) => Promise<Response>][] = [
    ["POST /api/mandates/preview", (r) => previewPost(r)],
    ["POST /api/mandates", (r) => mandatesPost(r)],
    ["POST /api/deals", (r) => dealsPost(r)],
    ["POST /api/deals/[id]/decision", (r) => decisionPost(r, params("anything"))],
    ["POST /api/deals/[id]/advance", (r) => advancePost(r, params("anything"))],
  ];
  const readers: [string, (r: Request) => Promise<Response>][] = [
    ["GET /api/mandates", (r) => mandatesGet(r)],
    ["GET /api/deals", (r) => dealsGet(r)],
    ["GET /api/deals/[id]", (r) => dealGet(r, params("anything"))],
  ];

  it("anonymous requests get 401 and never construct the runtime (no database, no PayPal)", async () => {
    for (const [name, call] of mutating) expect((await call(anonymous({}))).status, name).toBe(401);
    for (const [name, call] of readers) expect((await call(anonymous(undefined, "GET"))).status, name).toBe(401);
    expect(probe.runtimeCalls).toBe(0);
  });

  it("a forged, expired or unknown-user session is 401; a wrong origin or a missing CSRF token is 403", async () => {
    const u = await makePrincipal();
    for (const [name, call] of mutating) {
      expect((await call(authed(u, { secret: "x".repeat(40), body: {} }))).status, `${name} forged`).toBe(401);
      expect((await call(authed(u, { ttlPast: true, body: {} }))).status, `${name} expired`).toBe(401);
      expect((await call(authed({ id: "no-such-user", email: "ghost@example.com" }, { body: {} }))).status, `${name} unknown user`).toBe(401);
      expect((await call(authed(u, { origin: "https://evil.example", body: {} }))).status, `${name} origin`).toBe(403);
      expect((await call(authed(u, { origin: null, body: {} }))).status, `${name} no origin`).toBe(403);
      expect((await call(authed(u, { csrf: false, body: {} }))).status, `${name} csrf`).toBe(403);
    }
    expect(probe.runtimeCalls).toBe(0);
  });

  it("a session whose stored email differs from the user's is refused", async () => {
    const u = await makePrincipal();
    expect((await mandatesGet(authed({ id: u.id, email: "someone-else@example.com" }, { method: "GET" }))).status).toBe(401);
  });
});

describe("R2: identity comes only from the session", () => {
  it("preview and approval are for the session principal; a body that names a principal is a 400", async () => {
    const a = await makePrincipal();
    const b = await makePrincipal();
    const pre = await json(await previewPost(authed(a, { body: { draft } })));
    expect(pre.status).toBe(200);
    expect(pre.body.document.principalId).toBe(a.id);
    expect((await previewPost(authed(a, { body: { draft, principalId: b.id } }))).status).toBe(400);

    const ok = await json(await mandatesPost(authed(a, { body: { draft, confirmDigest: pre.body.digest } })));
    expect(ok.status).toBe(201);
    const row = await prisma.mandate.findUniqueOrThrow({ where: { id: ok.body.mandate.id } });
    expect(row.principalId).toBe(a.id);
    expect(row.approvedBy).toBe(a.email);
    const before = await prisma.mandate.count({ where: { principalId: b.id } });
    expect((await mandatesPost(authed(a, { body: { draft, confirmDigest: pre.body.digest, principalId: b.id, approvedBy: "x" } }))).status).toBe(400);
    expect(await prisma.mandate.count({ where: { principalId: b.id } })).toBe(before);
  });

  it("a confirmation digest that does not match is refused and nothing is stored", async () => {
    const a = await makePrincipal();
    const n = await prisma.mandate.count({ where: { principalId: a.id } });
    const r = await mandatesPost(authed(a, { body: { draft, confirmDigest: "0".repeat(64) } }));
    expect([400, 409]).toContain(r.status);
    expect(await prisma.mandate.count({ where: { principalId: a.id } })).toBe(n);
  });

  it("an invalid draft or an oversized body is a 400/413 and never a 500", async () => {
    const a = await makePrincipal();
    expect((await previewPost(authed(a, { body: { draft: { ...draft, budgetTotal: "-5" } } }))).status).toBe(400);
    expect([400, 413]).toContain((await previewPost(authed(a, { body: { draft, pad: "x".repeat(70_000) } }))).status);
  });

  it("lists only the session principal's own mandates and deals", async () => {
    const a = await makePrincipal();
    const b = await makePrincipal();
    const ma = await makeMandate(a);
    await makeMandate(b);
    const da = await createDeal(prisma, { principalId: a.id, mandateId: ma.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
    const ms = await json(await mandatesGet(authed(a, { method: "GET" })));
    expect(ms.body.mandates.map((m: { id: string }) => m.id)).toEqual([ma.id]);
    const ds = await json(await dealsGet(authed(a, { method: "GET" })));
    expect(ds.body.deals.map((d: { id: string }) => d.id)).toEqual([da.id]);
    const none = await json(await dealsGet(authed(b, { method: "GET" })));
    expect(none.body.deals).toEqual([]);
  });
});

describe("R3: ownership is verified before every approval, decision and advance", () => {
  it("another principal's mandate cannot be used to open a deal (404), the owner can", async () => {
    const a = await makePrincipal();
    const b = await makePrincipal();
    const ma = await makeMandate(a);
    const deals0 = await prisma.deal.count({ where: { mandateId: ma.id } });
    const foreign = await json(await dealsPost(authed(b, { body: { mandateId: ma.id, sellerId: "seller-sim", brief } })));
    expect(foreign.status).toBe(404);
    expect(await prisma.deal.count({ where: { mandateId: ma.id } })).toBe(deals0);
    expect((await dealsPost(authed(a, { body: { mandateId: ma.id, sellerId: "seller-sim", brief, principalId: b.id } }))).status).toBe(400);
    const own = await json(await dealsPost(authed(a, { body: { mandateId: ma.id, sellerId: "seller-sim", brief } })));
    expect(own.status).toBe(201);
    expect(typeof own.body.dealId).toBe("string");
    expect(own.body.negotiation.outcome).toBe("LOCKED");
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: own.body.dealId }, include: { mandate: true } });
    expect(deal.mandate.principalId).toBe(a.id);
  });

  it("a foreign deal looks exactly like a missing one: read, decide and advance are 404, write nothing and make no PayPal call", async () => {
    const base = await policyCheckedDeal();
    const intruder = await makePrincipal();
    const events0 = await prisma.dealEvent.count({ where: { dealId: base.dealId } });
    const state0 = (await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } })).state;
    for (const id of [base.dealId, "no-such-deal-id"]) {
      expect((await dealGet(authed(intruder, { method: "GET" }), params(id))).status).toBe(404);
      expect((await decisionPost(authed(intruder, { body: { decision: "approve" } }), params(id))).status).toBe(404);
      expect((await advancePost(authed(intruder, { body: {} }), params(id))).status).toBe(404);
    }
    const foreign = await json(await advancePost(authed(intruder, { body: {} }), params(base.dealId)));
    const missing = await json(await advancePost(authed(intruder, { body: {} }), params("no-such-deal-id")));
    expect(foreign).toEqual(missing);
    expect(await prisma.dealEvent.count({ where: { dealId: base.dealId } })).toBe(events0);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } })).state).toBe(state0);
    expect(probe.mock?.writes ?? []).toEqual([]);
  });

  it("the owner's advance drives the deal through the engine to a PayPal order (mock); decisions are validated", async () => {
    const base = await policyCheckedDeal();
    const owner = { id: base.p.id, email: base.p.email };
    expect((await decisionPost(authed(owner, { body: { decision: "maybe" } }), params(base.dealId))).status).toBe(400);
    expect((await decisionPost(authed(owner, { body: { decision: "approve", principalId: "x" } }), params(base.dealId))).status).toBe(400);
    const adv = await json(await advancePost(authed(owner, { body: {} }), params(base.dealId)));
    expect(adv.status).toBe(200);
    expect(adv.body.state).toBe("AWAITING_BUYER_APPROVAL");
    expect(typeof adv.body.approvalUrl).toBe("string");
    expect(probe.mock!.writes.map((w) => w.type)).toEqual(["CREATE_ORDER"]);
    const read = await json(await dealGet(authed(owner, { method: "GET" }), params(base.dealId)));
    expect(read.status).toBe(200);
    expect(read.body.deal.id).toBe(base.dealId);
    expect(read.body.events.length).toBeGreaterThan(0);
  });
});
