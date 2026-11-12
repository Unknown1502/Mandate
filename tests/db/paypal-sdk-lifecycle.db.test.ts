/**
 * The delayed-capture lifecycle driven THROUGH the official-SDK Sandbox gateway (SdkPayPalGateway), with FAKE SDK controllers that delegate to the in-memory mock.
 *   REAL: route handlers + session/CSRF/origin/ownership guards, orchestrator, settlement engine, SandboxWriteLock, SdkPayPalGateway (request mapping, response parsing, error
 *         classification), PostgreSQL (mandate_test), the seller simulator over loopback HTTP.
 *   FAKE: the PayPal SDK controllers and PayPal itself. NOTHING in this file contacts PayPal; it is evidence about OUR code, not about PayPal's behaviour.
 * The fake controllers receive exactly what the real SDK would (camelCase models, PayPal-Request-Id) and convert back to the REST shape the mock understands, so a mapping mistake
 * in the gateway (a lost field, a wrong id, a wrong intent) fails these tests.
 */
import type { AddressInfo } from "node:net";
import { ApiError } from "@paypal/paypal-server-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BuyerAgent, RuleBasedBuyerBrain } from "@/agents/buyer";
import { HttpSellerClient } from "@/agents/seller-client";
import { Orchestrator } from "@/orchestration/service";
import { getRuntime, SandboxWriteLock, type Runtime } from "@/lib/runtime";
import { CSRF_HEADER, createSession, SESSION_COOKIE } from "@/lib/session";
import type { GwResult } from "@/paypal/gateway";
import { MockPayPal } from "@/paypal/mock-gateway";
import { PAYPAL_JS_SDK_V6_SANDBOX_URL } from "@/paypal/checkout";
import { SdkPayPalGateway, type OrdersApi, type PaymentsApi, type SdkResponse } from "@/paypal/sdk-gateway";
import { defaultEngineConfig } from "@/settlement/engine";
import { createSettlementPort } from "@/settlement/port";
import { POST as previewPost } from "@/app/api/mandates/preview/route";
import { POST as mandatesPost } from "@/app/api/mandates/route";
import { POST as dealsPost } from "@/app/api/deals/route";
import { GET as dealGet } from "@/app/api/deals/[id]/route";
import { GET as checkoutGet } from "@/app/api/deals/[id]/checkout/route";
import { POST as advancePost } from "@/app/api/deals/[id]/advance/route";
import { POST as mockApprovalPost } from "@/app/api/deals/[id]/mock-approval/route";
import { POST as deliveryPost } from "@/app/api/deals/[id]/delivery/route";
import { POST as acceptPost } from "@/app/api/deals/[id]/accept/route";
import { createSellerServer } from "../../seller-service/server";
import { makePrincipal, prisma } from "./fixtures";

const APP = process.env.APP_URL!;
const SECRET = process.env.SESSION_SECRET!;
type User = { id: string; email: string };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function call(user: User, body?: unknown, method = "POST") {
  const { token, payload } = createSession(user, SECRET);
  return new Request(`${APP}/api/x`, { method, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: APP, [CSRF_HEADER]: payload.csrf, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const anonymous = () => new Request(`${APP}/api/x`, { method: "GET", headers: { origin: APP } });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

// ---- fake SDK controllers over the mock ----------------------------------------------------------------------------------------------------------------------
type Call = { fn: string; args: any };
const snake = (v: unknown): unknown => (Array.isArray(v) ? v.map(snake) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snake(x)])) : v);
function sdkOver(mock: MockPayPal, log: Call[]): { orders: OrdersApi; payments: PaymentsApi } {
  const resp = (r: GwResult): SdkResponse => {
    if (r.kind === "ok") return { statusCode: r.status, headers: { "paypal-debug-id": r.debugId ?? "" }, body: r.body === null ? "" : JSON.stringify(r.body) };
    if (r.kind === "rejected") throw new ApiError({ request: { method: "POST", url: "https://api-m.sandbox.paypal.com/x", headers: {} }, response: { statusCode: r.status, headers: {}, body: JSON.stringify(r.body) } } as never, "rejected");
    throw new Error(`network failure (${r.code})`);
  };
  const note = (fn: string, args: unknown) => log.push({ fn, args: JSON.parse(JSON.stringify(args)) });
  return {
    orders: {
      createOrder: async (a) => (note("createOrder", a), resp(await mock.write("CREATE_ORDER", { requestId: a.paypalRequestId!, path: "/v2/checkout/orders", body: snake(a.body) }))),
      getOrder: async (a) => (note("getOrder", a), resp(await mock.getOrder(a.id))),
      authorizeOrder: async (a) => (note("authorizeOrder", a), resp(await mock.write("AUTHORIZE", { requestId: a.paypalRequestId!, path: `/v2/checkout/orders/${a.id}/authorize` }))),
    },
    payments: {
      getAuthorizedPayment: async (a) => (note("getAuthorizedPayment", a), resp(await mock.getAuthorization(a.authorizationId))),
      captureAuthorizedPayment: async (a) => (note("captureAuthorizedPayment", a), resp(await mock.write("CAPTURE", { requestId: a.paypalRequestId!, path: `/v2/payments/authorizations/${a.authorizationId}/capture`, body: snake(a.body) }))),
      voidPayment: async (a) => (note("voidPayment", a), resp(await mock.write("VOID", { requestId: a.paypalRequestId!, path: `/v2/payments/authorizations/${a.authorizationId}/void` }))),
      reauthorizePayment: async (a) => (note("reauthorizePayment", a), resp(await mock.write("REAUTHORIZE", { requestId: a.paypalRequestId!, path: `/v2/payments/authorizations/${a.authorizationId}/reauthorize`, body: snake(a.body) }))),
      getCapturedPayment: async (a) => (note("getCapturedPayment", a), resp(await mock.getCapture(a.captureId))),
    },
  };
}

// ---- composition (what buildRuntime does in Sandbox mode, with fake controllers) ---------------------------------------------------------------------------
let sellerServer: ReturnType<typeof createSellerServer>;
let sellerUrl = "";
let mock: MockPayPal;
let log: Call[];
const g = globalThis as unknown as { __mandateRuntime?: Runtime };
/** the env-built runtime supplies the signing keys and policy the mandate routes use; only the PayPal side is replaced */
let base: Runtime;
function install(writesAuthorized: boolean) {
  mock = new MockPayPal();
  log = [];
  const sdk = sdkOver(mock, log);
  const { keys, policy } = base;
  const port = createSettlementPort({ db: prisma, gateway: new SandboxWriteLock(new SdkPayPalGateway(sdk.orders, sdk.payments), writesAuthorized), deps: policy, config: defaultEngineConfig(APP), now: () => new Date() });
  const seller = new HttpSellerClient(sellerUrl);
  const orchestrator = new Orchestrator({ db: prisma, port, policy, negotiation: { buyer: new BuyerAgent(new RuleBasedBuyerBrain()), seller, maxRounds: 4 } });
  g.__mandateRuntime = {
    db: prisma,
    keys,
    policy,
    orchestrator,
    sellerDelivery: seller,
    mockPayPal: mock, // ONLY to simulate the human approving on PayPal's page; it is the same in-memory object that backs the fake controllers
    checkout: { clientId: "public-test-client-id", sdkUrl: PAYPAL_JS_SDK_V6_SANDBOX_URL },
    info: { paypal: "sandbox-live", paypalGateway: "sandbox-sdk", sandboxWritesAuthorized: writesAuthorized, buyerBrain: "rule-based", llmVendor: null, llmConfig: "not_requested", llmConfigNote: null, llmModel: null, sellerConfigured: true, challengeWindowSeconds: 900, v2: "disabled" },
  } as unknown as Runtime;
}

const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", requireHumanAbove: "50", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
const crit = (id: string, validator: string, params: Record<string, unknown>, required: boolean, weight: number) => ({ id, text: `${id} check`, type: "deterministic", validator, params, required, weight });
const brief = {
  description: "Clean the customer CSV (synthetic data)",
  criteria: [crit("schema", "csv_schema_matches", { columns: ["id", "email", "joined"] }, true, 40), crit("dupes", "no_duplicate_rows", {}, true, 30), crit("dates", "date_format_valid", { column: "joined", format: "YYYY-MM-DD" }, false, 30)],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice: "20.00",
};
let owner: User;
let stranger: User;
let mandateId: string;
beforeAll(async () => {
  sellerServer = createSellerServer({ mode: "honest", floor: "18.00" });
  await new Promise<void>((r) => sellerServer.listen(0, "127.0.0.1", () => r()));
  sellerUrl = `http://127.0.0.1:${(sellerServer.address() as AddressInfo).port}`;
  base = getRuntime();
});
/** a fresh mandate per test: every deal reserves budget, and a shared mandate would run out */
async function newMandate() {
  const pre = await json(await previewPost(call(owner, { draft })));
  const ok = await json(await mandatesPost(call(owner, { draft, confirmDigest: pre.body.digest })));
  expect(ok.status).toBe(201);
  mandateId = ok.body.mandate.id;
}
afterAll(async () => {
  await new Promise<void>((r) => sellerServer.close(() => r()));
  delete g.__mandateRuntime;
});
beforeEach(async () => {
  install(true);
  owner = await makePrincipal(); // a fresh buyer per test also keeps each test inside the per-principal rate limit
  stranger = await makePrincipal();
  await newMandate();
});

const calls = (fn: string) => log.filter((c) => c.fn === fn);
async function openAndCreateOrder() {
  const opened = await json(await dealsPost(call(owner, { mandateId, sellerId: "seller-sim", brief })));
  expect(opened.status).toBe(201);
  expect(opened.body.negotiation.outcome).toBe("LOCKED");
  const id = opened.body.dealId as string;
  const adv = await json(await advancePost(call(owner, {}), params(id)));
  expect(adv.body.state).toBe("AWAITING_BUYER_APPROVAL");
  return id;
}
const approve = async (id: string) => json(await mockApprovalPost(call(owner, {}), params(id))); // the human approving on PayPal's page (simulated by the in-memory mock)
const stateOf = async (id: string) => (await prisma.deal.findUniqueOrThrow({ where: { id } })).state;

describe("order creation: the amount, currency and intent come from the server's locked terms", () => {
  it("creates exactly one AUTHORIZE order for the locked price, bound to the deal, with a stable idempotency key; nothing is authorized or captured", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    const created = calls("createOrder");
    expect(created).toHaveLength(1);
    expect(created[0]!.args.paypalRequestId).toBe(`${id}-CREATE_ORDER-1`);
    expect(created[0]!.args.body).toMatchObject({ intent: "AUTHORIZE", purchaseUnits: [{ referenceId: id, customId: id, amount: { currencyCode: "USD", value: Number(deal.price).toFixed(2) } }] });
    expect(calls("authorizeOrder")).toHaveLength(0);
    expect(calls("captureAuthorizedPayment")).toHaveLength(0);
    expect(deal.paypalOrderId).toMatch(/^ORD/); // the real provider order id is persisted against the deal
    expect(deal.paypalAuthId).toBeNull(); // an order is not an authorization
  });
  it("polling before the buyer approves never authorizes: the order is only READ", async () => {
    const id = await openAndCreateOrder();
    for (let i = 0; i < 3; i++) await advancePost(call(owner, {}), params(id));
    expect(calls("authorizeOrder")).toHaveLength(0);
    expect(calls("captureAuthorizedPayment")).toHaveLength(0);
    expect(calls("getOrder").length).toBeGreaterThan(0);
    expect(await stateOf(id)).toBe("AWAITING_BUYER_APPROVAL");
  });
});

describe("the checkout route: owner only, server-derived", () => {
  it("shows the owner the order id and exact amount from the deal record; the secret is never in the answer", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    const r = await json(await checkoutGet(call(owner, undefined, "GET"), params(id)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "sandbox", eligible: true, clientId: "public-test-client-id", sdkUrl: PAYPAL_JS_SDK_V6_SANDBOX_URL, orderId: deal.paypalOrderId, currency: "USD" });
    expect(Number(r.body.amount)).toBe(Number(deal.price));
    expect(JSON.stringify(r.body)).not.toMatch(/secret/i);
    expect(log.filter((c) => c.fn !== "createOrder" && c.fn !== "getOrder" && c.fn !== "getAuthorizedPayment")).toHaveLength(0); // the route itself made no PayPal call
  });
  it("is a 401 without a session and a 404 for a deal that belongs to someone else (or does not exist)", async () => {
    const id = await openAndCreateOrder();
    expect((await checkoutGet(anonymous(), params(id))).status).toBe(401);
    expect((await checkoutGet(call(stranger, undefined, "GET"), params(id))).status).toBe(404);
    expect((await checkoutGet(call(owner, undefined, "GET"), params("does-not-exist"))).status).toBe(404);
  });
  it("offers no button once the deal is past the approval stage, and none while Sandbox writes are locked", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    const after = await json(await checkoutGet(call(owner, undefined, "GET"), params(id)));
    expect(after.body).toMatchObject({ eligible: false });
    install(false);
    const locked = await json(await checkoutGet(call(owner, undefined, "GET"), params(id)));
    expect(locked.body).toMatchObject({ eligible: false, reason: "SANDBOX_WRITES_LOCKED" });
  });
});

describe("authorization happens only after the buyer's approval, and only the provider's record counts", () => {
  it("after approval the server authorizes once with a stable key and persists the authorization id; the deal waits for delivery", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    expect(deal.state).toBe("AWAITING_DELIVERY");
    expect(calls("authorizeOrder")).toHaveLength(1);
    expect(calls("authorizeOrder")[0]!.args).toMatchObject({ id: deal.paypalOrderId, paypalRequestId: `${id}-AUTHORIZE-1` });
    expect(deal.paypalAuthId).toMatch(/^AUTH/);
    expect(calls("captureAuthorizedPayment")).toHaveLength(0); // authorized is not captured
    await advancePost(call(owner, {}), params(id)); // a repeated nudge never authorizes twice
    expect(calls("authorizeOrder")).toHaveLength(1);
  });
  it("an order that does not match the deal's locked price is refused before authorization (tampered amount)", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.orders.get(deal.paypalOrderId!)!.amount = "1.00";
    await approve(id);
    expect(calls("authorizeOrder")).toHaveLength(0);
    expect(await stateOf(id)).toBe("AWAITING_BUYER_APPROVAL");
    const ev = await prisma.dealEvent.findMany({ where: { dealId: id, type: "ORDER_BINDING_MISMATCH" } });
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev[0]!.payload)).toMatch(/ORDER_AMOUNT_MISMATCH/);
  });
  it("an order that carries another deal's id is refused before authorization", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.orders.get(deal.paypalOrderId!)!.referenceId = "some-other-deal";
    await approve(id);
    expect(calls("authorizeOrder")).toHaveLength(0);
    const ev = await prisma.dealEvent.findMany({ where: { dealId: id, type: "ORDER_BINDING_MISMATCH" } });
    expect(JSON.stringify(ev[0]!.payload)).toMatch(/ORDER_NOT_BOUND_TO_DEAL/);
  });
  it("another principal cannot drive the deal at all: no PayPal call is made on their behalf", async () => {
    const id = await openAndCreateOrder();
    const before = log.length;
    expect((await advancePost(call(stranger, {}), params(id))).status).toBe(404);
    expect((await mockApprovalPost(call(stranger, {}), params(id))).status).toBe(404);
    expect((await acceptPost(call(stranger, {}), params(id))).status).toBe(404);
    expect((await deliveryPost(call(stranger, { quality: "good" }), params(id))).status).toBe(404);
    expect(log.length).toBe(before);
  });
});

describe("capture is impossible before eligible delivery acceptance, and happens exactly once for the locked price", () => {
  it("no capture while awaiting delivery or while the delivery is only verified; after the buyer accepts: one capture of the exact price against the stored authorization", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    for (let i = 0; i < 2; i++) await advancePost(call(owner, {}), params(id));
    expect(calls("captureAuthorizedPayment")).toHaveLength(0); // approved + authorized, but nothing delivered

    const del = await json(await deliveryPost(call(owner, { quality: "good" }), params(id)));
    expect(del.status).toBe(200);
    expect(await stateOf(id)).toBe("VERIFYING"); // verified; the challenge window protects the buyer
    for (let i = 0; i < 2; i++) await advancePost(call(owner, {}), params(id));
    expect(calls("captureAuthorizedPayment")).toHaveLength(0); // verification alone never captures

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    const acc = await json(await acceptPost(call(owner, {}), params(id)));
    expect(acc.status).toBe(200);
    const caps = calls("captureAuthorizedPayment");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.args).toMatchObject({ authorizationId: deal.paypalAuthId, paypalRequestId: `${id}-CAPTURE-1`, body: { amount: { currencyCode: "USD", value: Number(deal.price).toFixed(2) }, finalCapture: true } });
    expect(await stateOf(id)).toBe("CAPTURED");
    // duplicate triggers cannot capture again
    await advancePost(call(owner, {}), params(id));
    await acceptPost(call(owner, {}), params(id));
    expect(calls("captureAuthorizedPayment")).toHaveLength(1);
    expect(mock.captures.size).toBe(1);
  });
  it("a delivery that fails a required check is never captured: the authorization is voided with a stable key", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    await deliveryPost(call(owner, { quality: "duplicates" }), params(id));
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    expect(calls("captureAuthorizedPayment")).toHaveLength(0);
    const voids = calls("voidPayment");
    expect(voids.length).toBeGreaterThanOrEqual(1);
    expect(voids[0]!.args).toMatchObject({ authorizationId: deal.paypalAuthId, paypalRequestId: `${id}-VOID-1` });
    expect(await stateOf(id)).toBe("VOIDED");
  });
  it("a flagged delivery waits for a human: no capture and no void by itself", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    await deliveryPost(call(owner, { quality: "injection" }), params(id));
    expect(await stateOf(id)).toBe("NEEDS_HUMAN");
    expect(calls("captureAuthorizedPayment")).toHaveLength(0);
    expect(calls("voidPayment")).toHaveLength(0);
  });
});

describe("ambiguous provider outcomes are reconciled from PayPal, never assumed", () => {
  it("a capture whose response is lost (network failure after PayPal applied it) ends captured exactly once, retried only under the same idempotency key", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    await deliveryPost(call(owner, { quality: "good" }), params(id));
    mock.injectWriteFault("CAPTURE", "timeout_after");
    await acceptPost(call(owner, {}), params(id));
    for (let i = 0; i < 3 && (await stateOf(id)) !== "CAPTURED"; i++) await advancePost(call(owner, {}), params(id));
    expect(await stateOf(id)).toBe("CAPTURED");
    expect(mock.captures.size).toBe(1); // PayPal holds ONE capture
    const keysUsed = new Set(calls("captureAuthorizedPayment").map((c) => c.args.paypalRequestId));
    expect(keysUsed).toEqual(new Set([`${id}-CAPTURE-1`]));
  });
  it("a refused write (422) is a definitive failure and does not move the deal forward", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.buyerApprove(deal.paypalOrderId!);
    mock.injectWriteFault("AUTHORIZE", "reject422");
    await advancePost(call(owner, {}), params(id));
    expect(await stateOf(id)).not.toBe("AWAITING_DELIVERY");
    expect(mock.auths.size).toBe(0); // nothing was authorized at PayPal
  });
});

describe("Sandbox writes locked: nothing is sent to the SDK", () => {
  it("with PAYPAL_SANDBOX_WRITES not authorized, opening a deal never reaches createOrder", async () => {
    install(false);
    const opened = await json(await dealsPost(call(owner, { mandateId, sellerId: "seller-sim", brief })));
    expect(opened.status).toBe(201);
    await advancePost(call(owner, {}), params(opened.body.dealId));
    expect(calls("createOrder")).toHaveLength(0);
    expect(calls("authorizeOrder")).toHaveLength(0);
    expect(mock.orders.size).toBe(0);
  });
});

describe("the dashboard's deal view carries what the PayPal card shows", () => {
  it("exposes the persisted ids and operations, in the engine's own terms", async () => {
    const id = await openAndCreateOrder();
    await approve(id);
    const v = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(v.body.deal.paypalOrderId).toMatch(/^ORD/);
    expect(v.body.paypalOperations.map((o: any) => o.type)).toEqual(["CREATE_ORDER", "AUTHORIZE"]);
  });
});

describe("Stage 3 plan: the engine's approval step makes EXACTLY the planned PayPal calls, in order", () => {
  it("after the buyer's approval one advance = fresh order read, ONE authorize, order read-back, authorization read; no capture, void, refund or second order", async () => {
    const id = await openAndCreateOrder();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.buyerApprove(deal.paypalOrderId!); // the human approving on PayPal's page
    const before = log.length;
    await advancePost(call(owner, {}), params(id));
    const seq = log.slice(before);
    expect(seq.map((c) => c.fn)).toEqual(["getOrder", "authorizeOrder", "getOrder", "getAuthorizedPayment"]);
    expect(seq[0]!.args).toEqual({ id: deal.paypalOrderId });
    expect(seq[1]!.args).toEqual({ id: deal.paypalOrderId, paypalRequestId: `${id}-AUTHORIZE-1`, prefer: "return=representation" }); // no body: an empty authorize
    expect(seq[2]!.args).toEqual({ id: deal.paypalOrderId });
    expect(seq[3]!.args.authorizationId).toBe((await prisma.deal.findUniqueOrThrow({ where: { id } })).paypalAuthId);
    expect(await stateOf(id)).toBe("AWAITING_DELIVERY");
    for (const never of ["captureAuthorizedPayment", "voidPayment", "reauthorizePayment", "createOrder", "getCapturedPayment"]) expect(seq.some((c) => c.fn === never), never).toBe(false);
  });
});

describe("Stage 5 plan (derivation): the PayPal calls the engine makes from the buyer's acceptance to the capture", () => {
  it("prints and pins the exact gateway call sequence after acceptance", async () => {
    const id = await openAndCreateOrder();
    const deal0 = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.buyerApprove(deal0.paypalOrderId!);
    await advancePost(call(owner, {}), params(id)); // authorization (Stage 3 behaviour)
    await deliveryPost(call(owner, { quality: "good" }), params(id)); // Stage 4: verified, nothing captured
    const before = log.length;
    await acceptPost(call(owner, {}), params(id)); // the buyer's acceptance
    const seq = log.slice(before).map((c) => c.fn);
    // fresh authorization read (settlement decision), the pre-capture authorization check, THE capture write, the capture read-back, the authorization read-back; no order read, no void, no refund
    expect(seq).toEqual(["getAuthorizedPayment", "getAuthorizedPayment", "captureAuthorizedPayment", "getCapturedPayment", "getAuthorizedPayment"]);
    const cap = log.slice(before).find((c) => c.fn === "captureAuthorizedPayment")!;
    expect(cap.args).toMatchObject({ authorizationId: deal0.paypalAuthId ?? (await prisma.deal.findUniqueOrThrow({ where: { id } })).paypalAuthId, paypalRequestId: `${id}-CAPTURE-1`, body: { amount: { currencyCode: "USD", value: "20.00" }, finalCapture: true } });
    expect(await stateOf(id)).toBe("CAPTURED");
  });
});

describe("Stage 5 basis: verification passed and the challenge window ended unused (no acceptance), driven by Orchestrator.advance as scripts/paypal-e2e-stage5.ts does", () => {
  it("makes exactly the five gateway calls the live guard permits, records no acceptance, and captures once", async () => {
    const id = await openAndCreateOrder();
    const deal0 = await prisma.deal.findUniqueOrThrow({ where: { id } });
    mock.buyerApprove(deal0.paypalOrderId!);
    await advancePost(call(owner, {}), params(id));
    await deliveryPost(call(owner, { quality: "good" }), params(id));
    expect(await stateOf(id)).toBe("VERIFYING");
    await prisma.deal.update({ where: { id }, data: { challengeWindowEndsAt: new Date(Date.now() - 60_000) } }); // the window ends unused (test database only)
    const acceptBefore = await prisma.dealEvent.count({ where: { dealId: id, type: "HUMAN_REVIEW_DECISION" } });
    const before = log.length;
    const out = await (g.__mandateRuntime as { orchestrator: Orchestrator }).orchestrator.advance(id);
    expect(log.slice(before).map((c) => c.fn)).toEqual(["getAuthorizedPayment", "getAuthorizedPayment", "captureAuthorizedPayment", "getCapturedPayment", "getAuthorizedPayment"]);
    expect(out.state).toBe("CAPTURED");
    expect(mock.captures.size).toBe(1);
    expect(await prisma.dealEvent.count({ where: { dealId: id, type: "HUMAN_REVIEW_DECISION" } })).toBe(acceptBefore); // no acceptance fabricated
    const again = log.length;
    await (g.__mandateRuntime as { orchestrator: Orchestrator }).orchestrator.advance(id); // a second drive is inert
    expect(log.length).toBe(again);
    expect(mock.captures.size).toBe(1);
  });
});
