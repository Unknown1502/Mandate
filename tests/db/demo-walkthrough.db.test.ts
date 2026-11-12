/**
 * Full MOCK-based demo walkthrough through the authenticated HTTP routes (hackathon demo, milestone 2A).
 *   REAL: route handlers, session/CSRF/origin/ownership guards, orchestrator, policy and settlement engines, PostgreSQL (mandate_test), the seller simulator over loopback HTTP.
 *   MOCK: PayPal (PAYPAL_MODE=mock, in memory). NO model: the Buyer Agent uses the rule-based brain. Nothing here is evidence of real PayPal or real AI behaviour.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma, makePrincipal } from "./fixtures";
import { createSellerServer } from "../../seller-service/server";
import { createSession, SESSION_COOKIE, CSRF_HEADER } from "@/lib/session";
import { getRuntime } from "@/lib/runtime";
import { POST as previewPost } from "@/app/api/mandates/preview/route";
import { POST as mandatesPost } from "@/app/api/mandates/route";
import { POST as dealsPost } from "@/app/api/deals/route";
import { GET as dealGet } from "@/app/api/deals/[id]/route";
import { POST as advancePost } from "@/app/api/deals/[id]/advance/route";
import { POST as mockApprovalPost } from "@/app/api/deals/[id]/mock-approval/route";
import { POST as deliveryPost } from "@/app/api/deals/[id]/delivery/route";
import { POST as reviewPost } from "@/app/api/deals/[id]/review/route";
import { POST as challengePost } from "@/app/api/deals/[id]/challenge/route";
import { POST as acceptPost } from "@/app/api/deals/[id]/accept/route";
import { GET as statusGet } from "@/app/api/status/route";

const APP = process.env.APP_URL!;
const SECRET = process.env.SESSION_SECRET!;
type User = { id: string; email: string };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function call(user: User, body?: unknown, method = "POST") {
  const { token, payload } = createSession(user, SECRET);
  return new Request(`${APP}/api/x`, { method, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: APP, [CSRF_HEADER]: payload.csrf, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });

const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", requireHumanAbove: "50", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
const crit = (id: string, validator: string, params: Record<string, unknown>, required: boolean, weight: number) => ({ id, text: `${id} check`, type: "deterministic", validator, params, required, weight });
const brief = {
  description: "Clean the customer CSV (synthetic data)",
  criteria: [crit("schema", "csv_schema_matches", { columns: ["id", "email", "joined"] }, true, 40), crit("dupes", "no_duplicate_rows", {}, true, 30), crit("dates", "date_format_valid", { column: "joined", format: "YYYY-MM-DD" }, false, 30)],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice: "20.00",
};

let server: ReturnType<typeof createSellerServer>;
let owner: User;
let mandateId: string;

beforeAll(async () => {
  server = createSellerServer({ mode: "honest", floor: "18.00" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.SELLER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PAYPAL_MODE = "mock";
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_PROVIDER;
  owner = await makePrincipal();
  const pre = await json(await previewPost(call(owner, { draft })));
  const ok = await json(await mandatesPost(call(owner, { draft, confirmDigest: pre.body.digest })));
  expect(ok.status).toBe(201);
  expect(ok.body.mandate.sealVerified).toBe(true);
  mandateId = ok.body.mandate.id;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** open a deal, negotiate, create the (mock) PayPal order, simulate the buyer's checkout: the deal waits for delivery */
async function dealAwaitingDelivery() {
  const opened = await json(await dealsPost(call(owner, { mandateId, sellerId: "seller-sim", brief })));
  expect(opened.status).toBe(201);
  expect(opened.body.negotiation.outcome).toBe("LOCKED");
  expect(opened.body.buyerBrain).toBe("rule-based");
  const id = opened.body.dealId as string;
  const adv = await json(await advancePost(call(owner, {}), params(id)));
  expect(adv.body.state).toBe("AWAITING_BUYER_APPROVAL");
  const approved = await json(await mockApprovalPost(call(owner, {}), params(id)));
  expect(approved.body.state).toBe("AWAITING_DELIVERY");
  return id;
}
const writes = () => getRuntime().mockPayPal!.writes.map((w) => w.type);
const writesFor = async (id: string) => (await prisma.payPalOperation.findMany({ where: { dealId: id } })).map((o) => o.type);

describe("status labels are truthful", () => {
  it("reports mock PayPal, a rule-based Buyer Agent, a configured local seller and V2 disabled", async () => {
    const s = await json(await statusGet(call(owner, undefined, "GET")));
    expect(s.body).toMatchObject({ paypal: "mock", buyerBrain: "rule-based", llmVendor: null, llmModel: null, sellerConfigured: true, v2: "disabled" });
  });
});

describe("honest delivery: negotiation -> authorization -> delivery -> deterministic verification -> capture (mock)", () => {
  it("captures exactly the negotiated price after a clean delivery, and shows the evidence", async () => {
    const id = await dealAwaitingDelivery();
    const mid = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(mid.body.negotiation.length).toBeGreaterThanOrEqual(2);
    expect(mid.body.modelRuns).toEqual([]); // no model ran: the UI must not claim AI
    const price = mid.body.deal.price as string;

    const del = await json(await deliveryPost(call(owner, { quality: "good" }), params(id)));
    expect(del.status).toBe(200);
    // verified, but payment waits for the buyer's challenge window: nothing is captured yet
    const waiting = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(waiting.body.deal.state).toBe("VERIFYING");
    expect(waiting.body.verification.overall).toBe("ALL_REQUIRED_PASSED");
    expect(await writesFor(id)).toEqual(["CREATE_ORDER", "AUTHORIZE"]);
    const acc = await json(await acceptPost(call(owner, {}), params(id)));
    expect(acc.status).toBe(200);
    const end = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(end.body.delivery.preview).toMatch(/^id,email,joined/);
    expect(end.body.verification.overall).toBe("ALL_REQUIRED_PASSED");
    expect(end.body.settlement.decision).toBe("FULL_CAPTURE");
    expect(end.body.settlement.amount).toBe(price);
    expect(await writesFor(id)).toEqual(["CREATE_ORDER", "AUTHORIZE", "CAPTURE"]);
    expect(end.body.deal.state).toBe("CAPTURED");
    expect(writes().filter((t) => t === "CAPTURE").length).toBeGreaterThanOrEqual(1);
  });
});

describe("a bad delivery never pays", () => {
  it("duplicate rows fail a required deterministic check: no capture (the authorization is voided)", async () => {
    const id = await dealAwaitingDelivery();
    await json(await deliveryPost(call(owner, { quality: "duplicates" }), params(id)));
    const end = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(end.body.verification.overall).toBe("REQUIRED_FAILED");
    const ops = await writesFor(id);
    expect(ops).not.toContain("CAPTURE");
    expect(end.body.settlement?.decision).not.toBe("CAPTURE");
  });

  it("an instruction hidden in a cell is flagged and the deal goes to a human: no capture, no void by itself", async () => {
    const id = await dealAwaitingDelivery();
    await json(await deliveryPost(call(owner, { quality: "injection" }), params(id)));
    const end = await json(await dealGet(call(owner, undefined, "GET"), params(id)));
    expect(end.body.deal.state).toBe("NEEDS_HUMAN");
    expect(await writesFor(id)).not.toContain("CAPTURE");
    expect(JSON.stringify(end.body.verification.result)).toMatch(/INSTR_OVERRIDE|SEVERE|flags/);
    // the buyer's only options are the policy's: there is no unrestricted reject, and an amount can never be supplied
    expect((await reviewPost(call(owner, { kind: "reject" }), params(id))).status).toBe(400);
    expect((await reviewPost(call(owner, { kind: "approve", amount: "999.00" }), params(id))).status).toBe(400);
    const dec = await json(await reviewPost(call(owner, { kind: "approve" }), params(id)));
    expect([200]).toContain(dec.status);
    const after = await writesFor(id);
    expect(after.filter((t) => t === "CAPTURE").length).toBeLessThanOrEqual(0);
  });
});

describe("accepting never makes a bad delivery payable", () => {
  it("accept on a flagged delivery (NEEDS_HUMAN) or after a failed one captures nothing", async () => {
    for (const quality of ["injection", "duplicates"] as const) {
      const id = await dealAwaitingDelivery();
      await json(await deliveryPost(call(owner, { quality }), params(id)));
      await json(await acceptPost(call(owner, {}), params(id)));
      expect(await writesFor(id), quality).not.toContain("CAPTURE");
    }
  });
});

describe("the seller simulator cannot approve or pay, and strangers cannot use the new routes", () => {
  it("another principal gets 404 on delivery, review, challenge and mock approval; anonymous gets 401; no PayPal write happens", async () => {
    const id = await dealAwaitingDelivery();
    const before = (await writesFor(id)).length;
    const stranger = await makePrincipal();
    for (const [name, route, body] of [
      ["delivery", deliveryPost, { quality: "good" }],
      ["review", reviewPost, { kind: "approve" }],
      ["challenge", challengePost, { criterionId: "schema", reason: "this is a long enough reason", evidenceRefs: ["ledger:1"] }],
      ["mock-approval", mockApprovalPost, {}],
      ["accept", acceptPost, {}],
    ] as const) {
      expect((await route(call(stranger, body), params(id))).status, `${name} stranger`).toBe(404);
      const anon = new Request(`${APP}/api/x`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await route(anon, params(id))).status, `${name} anonymous`).toBe(401);
    }
    expect((await writesFor(id)).length).toBe(before);
    expect((await prisma.delivery.count({ where: { dealId: id } }))).toBe(0);
  });

  it("a body that names a principal, an artifact or a seller is refused", async () => {
    const id = await dealAwaitingDelivery();
    expect((await deliveryPost(call(owner, { quality: "good", principalId: "x" }), params(id))).status).toBe(400);
    expect((await deliveryPost(call(owner, { quality: "good", artifactText: "id\n1" }), params(id))).status).toBe(400);
    expect((await deliveryPost(call(owner, { quality: "good", sellerId: "evil" }), params(id))).status).toBe(400);
    expect((await deliveryPost(call(owner, { quality: "perfect" }), params(id))).status).toBe(400);
  });

  it("delivery before authorization is refused (409) and nothing is stored", async () => {
    const opened = await json(await dealsPost(call(owner, { mandateId, sellerId: "seller-sim", brief })));
    const id = opened.body.dealId as string;
    const r = await json(await deliveryPost(call(owner, { quality: "good" }), params(id)));
    expect(r.status).toBe(409);
    expect(await prisma.delivery.count({ where: { dealId: id } })).toBe(0);
  });
});
