/**
 * MOCK PayPal gateway (in memory). Everything here is a simulation written by us; nothing in this file is evidence of real PayPal behaviour. It is the gateway of the
 * explicit demo mode `PAYPAL_MODE=mock` (the default) and of the test suites. It cannot move real money and the UI labels it "MOCK". The idempotency replay and the
 * post-capture authorization status are ASSUMPTIONS to be verified in Sandbox.
 */
import { randomUUID } from "node:crypto";
import type { GwResult, PayPalGateway, WriteType } from "./gateway";

export type WriteFault =
  | "timeout_before" // request lost: not applied, caller sees an unknown outcome
  | "timeout_after" // applied, response lost
  | "http500_after" // applied, caller sees HTTP 500
  | "reject422" // PayPal refuses, nothing applied
  | "pending" // capture accepted but PENDING
  | "declined" // capture resource created as DECLINED
  | "lie_completed" // POST body says COMPLETED while the stored resource is DECLINED
  | "void_noop"; // void answers 204 but the authorization stays CREATED

interface MockOrder { id: string; status: string; amount: string; referenceId?: string; customId?: string; authIds: string[]; captures: { id: string; status: string; invoice_id?: string; amount: { currency_code: string; value: string } }[] }
interface MockAuth { id: string; status: string; amount: string; expiration_time: string; captured: number }
interface MockCapture { id: string; status: string; amount: { currency_code: string; value: string }; invoice_id?: string; final_capture?: boolean }

export class MockPayPal implements PayPalGateway {
  orders = new Map<string, MockOrder>();
  auths = new Map<string, MockAuth>();
  captures = new Map<string, MockCapture>();
  /** every write attempt that reached the "network", in order */
  writes: { type: WriteType; requestId: string; path: string; body: unknown }[] = [];
  reads: { kind: string; id: string }[] = [];
  private replay = new Map<string, GwResult>();
  private faults: { type: WriteType; fault: WriteFault }[] = [];
  private readFaults: ("order" | "authorization" | "capture")[] = [];
  /** hook to inspect external state at the moment a write is "sent" (used to prove persist-before-send) */
  onWrite?: (w: { type: WriteType; requestId: string }) => Promise<void> | void;
  private n = 0;
  /** ids are globally unique, like real PayPal ids (the test DB persists across tests) */
  private readonly uid = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  authLifetimeDays = 29;

  injectWriteFault(type: WriteType, fault: WriteFault) { this.faults.push({ type, fault }); }
  injectReadFault(kind: "order" | "authorization" | "capture") { this.readFaults.push(kind); }

  /** Simulates the human completing buyer checkout. */
  buyerApprove(orderId: string) { this.orders.get(orderId)!.status = "APPROVED"; }
  completePending(captureId: string, status: "COMPLETED" | "DECLINED") {
    const c = this.captures.get(captureId)!;
    c.status = status;
    const o = [...this.orders.values()].find((x) => x.captures.some((k) => k.id === captureId))!;
    o.captures.find((k) => k.id === captureId)!.status = status;
  }
  expireAuthorization(authId: string) { this.auths.get(authId)!.expiration_time = new Date(Date.now() - 1000).toISOString(); }
  voidExternally(authId: string) { this.auths.get(authId)!.status = "VOIDED"; }

  private takeFault(type: WriteType): WriteFault | undefined {
    const i = this.faults.findIndex((f) => f.type === type);
    return i >= 0 ? this.faults.splice(i, 1)[0]!.fault : undefined;
  }
  private ok(body: unknown, status = 200): GwResult { return { kind: "ok", status, debugId: `mock-${++this.n}`, body }; }

  async write(type: WriteType, a: { requestId: string; path: string; body?: unknown }): Promise<GwResult> {
    await this.onWrite?.({ type, requestId: a.requestId });
    this.writes.push({ type, requestId: a.requestId, path: a.path, body: a.body });
    const fault = this.takeFault(type);
    if (fault === "timeout_before") return { kind: "unknown", code: "PAYPAL_TIMEOUT", message: "mock timeout before apply" };
    const prior = this.replay.get(a.requestId); // emulated idempotency (ASSUMPTION)
    if (prior && fault !== "reject422") {
      if (fault === "timeout_after" || fault === "http500_after") return { kind: "unknown", code: "PAYPAL_TIMEOUT", message: "mock" };
      return prior;
    }
    if (fault === "reject422") return { kind: "rejected", status: 422, code: "PAYPAL_VALIDATION", body: { name: "UNPROCESSABLE_ENTITY" } };

    const res = this.apply(type, a, fault);
    this.replay.set(a.requestId, res);
    if (fault === "timeout_after") return { kind: "unknown", code: "PAYPAL_TIMEOUT", message: "mock timeout after apply" };
    if (fault === "http500_after") return { kind: "unknown", code: "PAYPAL_UNAVAILABLE", message: "HTTP 500", status: 500 };
    return res;
  }

  private apply(type: WriteType, a: { path: string; body?: unknown }, fault?: WriteFault): GwResult {
    if (type === "CREATE_ORDER") {
      const body = a.body as { purchase_units: { amount: { value: string }; reference_id?: string; custom_id?: string }[] };
      const id = `ORD${this.uid}${++this.n}`;
      this.orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", amount: body.purchase_units[0]!.amount.value, referenceId: body.purchase_units[0]!.reference_id, customId: body.purchase_units[0]!.custom_id, authIds: [], captures: [] });
      return this.ok(this.orderJson(id));
    }
    if (type === "AUTHORIZE") {
      const id = /\/orders\/([^/]+)\/authorize$/.exec(a.path)![1]!;
      const o = this.orders.get(id);
      if (!o || o.status !== "APPROVED") return { kind: "rejected", status: 422, code: "PAYPAL_VALIDATION", body: { name: "ORDER_NOT_APPROVED" } };
      const authId = `AUTH${this.uid}${++this.n}`;
      this.auths.set(authId, { id: authId, status: "CREATED", amount: o.amount, expiration_time: new Date(Date.now() + this.authLifetimeDays * 86_400_000).toISOString(), captured: 0 });
      o.authIds.push(authId);
      o.status = "COMPLETED";
      return this.ok(this.orderJson(id));
    }
    const authId = /\/authorizations\/([^/]+)\/(capture|void)$/.exec(a.path)![1]!;
    const auth = this.auths.get(authId);
    if (!auth) return { kind: "rejected", status: 404, code: "PAYPAL_NOT_FOUND", body: {} };
    if (type === "VOID") {
      if (auth.status !== "CREATED") return { kind: "rejected", status: 422, code: "PAYPAL_VALIDATION", body: { name: "AUTHORIZATION_ALREADY_CAPTURED_OR_VOIDED" } };
      if (fault !== "void_noop") auth.status = "VOIDED";
      return this.ok(null, 204);
    }
    // CAPTURE
    const body = a.body as { amount: { currency_code: string; value: string }; invoice_id?: string; final_capture?: boolean };
    if (auth.status !== "CREATED") return { kind: "rejected", status: 422, code: "PAYPAL_VALIDATION", body: { name: "AUTHORIZATION_NOT_CAPTURABLE" } };
    if (Number(body.amount.value) > Number(auth.amount)) return { kind: "rejected", status: 422, code: "PAYPAL_VALIDATION", body: { name: "AMOUNT_EXCEEDS_AUTHORIZATION" } };
    const id = `CAP${this.uid}${++this.n}`;
    const status = fault === "pending" ? "PENDING" : fault === "declined" || fault === "lie_completed" ? "DECLINED" : "COMPLETED";
    const cap: MockCapture = { id, status, amount: body.amount, invoice_id: body.invoice_id, final_capture: body.final_capture };
    this.captures.set(id, cap);
    const order = [...this.orders.values()].find((o) => o.authIds.includes(authId))!;
    order.captures.push({ id, status, invoice_id: body.invoice_id, amount: body.amount });
    if (status === "COMPLETED" || status === "PENDING") {
      // ASSUMPTION about what happens to the authorization after a final capture; UNVERIFIED in Sandbox.
      auth.status = Number(body.amount.value) === Number(auth.amount) ? "CAPTURED" : "PARTIALLY_CAPTURED";
    }
    return this.ok({ id, status: fault === "lie_completed" ? "COMPLETED" : status }, 201);
  }

  private orderJson(id: string) {
    const o = this.orders.get(id)!;
    return {
      id: o.id,
      status: o.status,
      links: o.status === "PAYER_ACTION_REQUIRED" ? [{ href: `https://sandbox.example/checkout?token=${o.id}`, rel: "payer-action", method: "GET" }] : [],
      purchase_units: [{ reference_id: o.referenceId, custom_id: o.customId, amount: { currency_code: "USD", value: o.amount }, payments: { authorizations: o.authIds.map((i) => ({ id: i, status: this.auths.get(i)!.status })), captures: o.captures.map((c) => ({ id: c.id, status: c.status, invoice_id: c.invoice_id })) } }],
    };
  }

  private async read(kind: "order" | "authorization" | "capture", id: string, f: () => unknown): Promise<GwResult> {
    this.reads.push({ kind, id });
    const i = this.readFaults.indexOf(kind);
    if (i >= 0) { this.readFaults.splice(i, 1); return { kind: "unknown", code: "PAYPAL_TIMEOUT", message: "mock read timeout" }; }
    const body = f();
    return body ? this.ok(body) : { kind: "rejected", status: 404, code: "PAYPAL_NOT_FOUND", body: {} };
  }
  getOrder(id: string) { return this.read("order", id, () => (this.orders.has(id) ? this.orderJson(id) : null)); }
  getAuthorization(id: string) {
    return this.read("authorization", id, () => {
      const a = this.auths.get(id);
      return a ? { id: a.id, status: a.status, amount: { currency_code: "USD", value: a.amount }, expiration_time: a.expiration_time } : null;
    });
  }
  getCapture(id: string) { return this.read("capture", id, () => this.captures.get(id) ?? null); }

  /** helpers for assertions */
  writesOf(type: WriteType) { return this.writes.filter((w) => w.type === type); }
}
