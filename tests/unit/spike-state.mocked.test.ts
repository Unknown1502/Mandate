/** MOCKED tests of the spike's crash-safety bookkeeping. They do not exercise real PayPal. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mandate-spike-"));
process.env.SPIKE_STATE_PATH = join(dir, "state.json");

const ENV = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "cid",
  PAYPAL_CLIENT_SECRET: "sec",
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let mods: {
  PayPalClient: typeof import("@/paypal/client").PayPalClient;
  executeWrite: typeof import("../../scripts/spike/state").executeWrite;
  sendOp: typeof import("../../scripts/spike/state").sendOp;
  loadState: typeof import("../../scripts/spike/state").loadState;
  UnreconciledOperationError: typeof import("../../scripts/spike/state").UnreconciledOperationError;
};

beforeAll(async () => {
  const c = await import("@/paypal/client");
  const s = await import("../../scripts/spike/state");
  mods = {
    PayPalClient: c.PayPalClient,
    executeWrite: s.executeWrite,
    sendOp: s.sendOp,
    loadState: s.loadState,
    UnreconciledOperationError: s.UnreconciledOperationError,
  };
});
afterAll(() => {
  delete process.env.SPIKE_STATE_PATH;
});

const spec = {
  key: "full:capture:1",
  type: "CAPTURE" as const,
  scenario: "full",
  path: "/v2/payments/authorizations/AUTH1/capture",
  body: { amount: { currency_code: "USD", value: "10.00" }, final_capture: true, invoice_id: "inv-1" },
};

describe("executeWrite crash safety (mocked)", () => {
  it("persists the operation as SENT with its request id BEFORE the network write", async () => {
    let seenAtWriteTime: { status: string; requestId: string } | undefined;
    const f = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 3600 });
      const st = JSON.parse(readFileSync(process.env.SPIKE_STATE_PATH!, "utf8"));
      seenAtWriteTime = { status: st.ops[spec.key].status, requestId: st.ops[spec.key].requestId };
      return json(201, { id: "CAP1", status: "COMPLETED" });
    }) as unknown as typeof fetch;
    const client = new mods.PayPalClient({ env: ENV, fetchImpl: f });
    const st = mods.loadState();
    const r = await mods.executeWrite(client, st, spec);
    expect(seenAtWriteTime?.status).toBe("SENT");
    expect(seenAtWriteTime?.requestId).toBe(r.op.requestId);
    expect(r.op.status).toBe("CONFIRMED");
    expect(r.op.resourceId).toBe("CAP1");
  });

  it("does not re-send a terminal operation", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const client = new mods.PayPalClient({ env: ENV, fetchImpl: f });
    const st = mods.loadState();
    const r = await mods.executeWrite(client, st, spec);
    expect(r.skipped).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("marks a timeout UNKNOWN, refuses a new write for it, and reuses the SAME request id on resend", async () => {
    const bodyKey = { ...spec, key: "partial_open:capture:1", scenario: "partial_open" };
    const seenRequestIds: string[] = [];
    let first = true;
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 3600 });
      const headers = init?.headers as Record<string, string>;
      seenRequestIds.push(headers["PayPal-Request-Id"] as string);
      if (first) {
        first = false;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return json(201, { id: "CAP2", status: "COMPLETED" });
    }) as unknown as typeof fetch;
    const client = new mods.PayPalClient({ env: ENV, fetchImpl: f });
    const st = mods.loadState();

    const r1 = await mods.executeWrite(client, st, bodyKey, 10);
    expect(r1.op.status).toBe("UNKNOWN");
    expect(r1.error?.code).toBe("PAYPAL_TIMEOUT");

    // A second logical write for the same key must be refused until reconciled.
    await expect(mods.executeWrite(client, st, bodyKey)).rejects.toBeInstanceOf(mods.UnreconciledOperationError);
    expect(seenRequestIds.length).toBe(1);

    // Reconciliation may resend, but only with the identical request id.
    const r2 = await mods.sendOp(client, st, r1.op);
    expect(r2.response?.ok).toBe(true);
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[1]).toBe(seenRequestIds[0]);
    expect(r1.op.attempts).toBe(2);
    expect(r1.op.status).toBe("CONFIRMED");
  });

  it("marks 5xx UNKNOWN (outcome not proven) but 422 FAILED (definitive)", async () => {
    const mk = (status: number) =>
      new mods.PayPalClient({
        env: ENV,
        fetchImpl: vi.fn(async (url: string | URL | Request) =>
          String(url).endsWith("/v1/oauth2/token") ? json(200, { access_token: "t", expires_in: 3600 }) : json(status, { name: "X" }),
        ) as unknown as typeof fetch,
      });
    const st = mods.loadState();
    const a = await mods.executeWrite(mk(503), st, { ...spec, key: "k:503", scenario: "k" });
    const b = await mods.executeWrite(mk(422), st, { ...spec, key: "k:422", scenario: "k" });
    expect(a.op.status).toBe("UNKNOWN");
    expect(b.op.status).toBe("FAILED");
  });
});
