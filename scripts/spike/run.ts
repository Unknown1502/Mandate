/**
 * Phase 1 PayPal Sandbox spike. Usage: npm run spike -- <command> [--timeout-ms N] [--minutes N]
 * Server-side only. Sandbox only (enforced by PayPalClient). No UI, no agents, no settlement logic.
 * NOTE: this harness issues PayPal writes directly because Phase 1 is a spike; from Phase 2 on,
 * only the Settlement Engine may do so (AGENTS.md invariant 2).
 */
import { PayPalClient, toPayPalError, type PayPalResponse } from "../../src/paypal/client";
import { PayPalError } from "../../src/paypal/errors";
import { captureBody, createOrderBody } from "../../src/paypal/payloads";
import { authorizationSchema, captureSchema, orderSchema } from "../../src/paypal/schemas";
import { parsePayPalEnv } from "../../src/lib/env";
import { setContext, recordCall } from "./observations";
import {
  UnreconciledOperationError,
  executeWrite,
  loadState,
  saveState,
  sendOp,
  type Op,
  type State,
} from "./state";

const SCENARIOS = ["partial_open", "full", "partial_final", "void"] as const;
type ScenarioName = (typeof SCENARIOS)[number];
const AMOUNT = "10.00";
const PARTIAL = "6.00";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
};
const log = (...a: unknown[]) => console.log(...a);

const client = new PayPalClient({
  onCall: (r) => {
    recordCall(r);
    log(`  [paypal] ${r.method} ${r.path} -> ${r.status ?? r.outcome} debug_id=${r.debugId ?? "n/a"} ${r.durationMs}ms req_id=${r.requestId ?? "-"}`);
  },
});

// ---------- helpers ----------
async function getOrder(id: string, quiet = false) {
  const res = await client.request({ method: "GET", path: `/v2/checkout/orders/${id}`, quiet });
  if (!res.ok) throw toPayPalError(res);
  return { res, order: orderSchema.parse(res.body) };
}
async function getAuth(id: string) {
  const res = await client.request({ method: "GET", path: `/v2/payments/authorizations/${id}` });
  if (!res.ok) throw toPayPalError(res);
  return { res, auth: authorizationSchema.parse(res.body) };
}
async function getCapture(id: string) {
  const res = await client.request({ method: "GET", path: `/v2/payments/captures/${id}` });
  if (!res.ok) throw toPayPalError(res);
  return { res, capture: captureSchema.parse(res.body) };
}
function scenarioOf(st: State, name: ScenarioName) {
  const s = st.scenarios[name];
  if (!s) throw new Error(`Scenario ${name} does not exist yet (run create-orders)`);
  return s;
}
function authIdOf(st: State, name: ScenarioName): string {
  const id = scenarioOf(st, name).authId;
  if (!id) throw new Error(`Scenario ${name} has no authorization id yet (run authorize)`);
  return id;
}
function show(label: string, v: unknown) {
  log(`  ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}
function reportWrite(r: Awaited<ReturnType<typeof executeWrite>>) {
  const o = r.op;
  show("op", `${o.key} status=${o.status} http=${o.httpStatus ?? "-"} attempts=${o.attempts} request_id=${o.requestId}`);
  if (r.skipped) log("  (already terminal in state; no call made)");
  if (r.response && !r.response.ok) show("error", toPayPalError(r.response).code + " " + JSON.stringify(r.response.body));
  if (r.error) show("error", `${r.error.code}: ${r.error.message}`);
}

async function inspectAuth(name: ScenarioName, testId: string) {
  setContext(testId, `GET authorization after operation (scenario: ${name})`);
  const { auth } = await getAuth(authIdOf(loadState(), name));
  show("authorization", { id: auth.id, status: auth.status, amount: auth.amount });
}
async function inspectOrder(name: ScenarioName, testId: string) {
  setContext(testId, `GET order after operation (scenario: ${name})`);
  const { order } = await getOrder(scenarioOf(loadState(), name).orderId!);
  const p = order.purchase_units?.[0]?.payments;
  show("order", { id: order.id, status: order.status, authorizations: p?.authorizations, captures: p?.captures });
}

// ---------- commands ----------
const commands: Record<string, () => Promise<void>> = {
  async preflight() {
    const env = parsePayPalEnv(process.env); // throws unless sandbox literals + credentials present
    log("PAYPAL_ENV=sandbox: OK");
    log("PAYPAL_BASE_URL is the exact Sandbox host: OK");
    log(`Client id/secret present: ${env.PAYPAL_CLIENT_ID.length > 0 && env.PAYPAL_CLIENT_SECRET.length > 0} (values not shown)`);
    log(`PAYPAL_WEBHOOK_ID present: ${Boolean(env.PAYPAL_WEBHOOK_ID)} (webhook tests are UNVERIFIED unless true)`);
    log("Partial-capture setting: not readable via the REST API; it is tested empirically in 'partial-final'.");
  },

  async oauth() {
    setContext("S01", "OAuth token acquisition");
    await client.getAccessToken();
    log(`  token acquired; ttl ~${client.tokenTtlSeconds()}s (token value never printed)`);
  },

  async "create-orders"() {
    const env = parsePayPalEnv(process.env);
    void env;
    const st = loadState();
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    for (const name of SCENARIOS) {
      setContext("S02", `Create AUTHORIZE order (scenario: ${name})`);
      st.scenarios[name] ??= { name, amount: AMOUNT };
      const body = createOrderBody({
        referenceId: `${st.runId}-${name}`,
        description: `MANDATE spike ${name}`,
        amount: AMOUNT,
        returnUrl: `${appUrl}/paypal/return`,
        cancelUrl: `${appUrl}/paypal/cancel`,
      });
      const r = await executeWrite(client, st, {
        key: `${name}:create:1`,
        type: "CREATE_ORDER",
        scenario: name,
        path: "/v2/checkout/orders",
        body,
        prefer: "return=representation",
      });
      reportWrite(r);
      if (r.response?.ok) {
        const order = orderSchema.parse(r.response.body);
        const sc = st.scenarios[name]!;
        sc.orderId = order.id;
        const link = order.links?.find((l) => l.rel === "payer-action") ?? order.links?.find((l) => l.rel === "approve");
        if (!link) throw new Error(`No approval link found. rels present: ${order.links?.map((l) => l.rel).join(",")}`);
        sc.approvalUrl = link.href;
        sc.approvalRel = link.rel;
        saveState(st);
      }
    }
    log("\nBuyer approval required. Open EACH URL, log in as the Sandbox PERSONAL buyer and approve:");
    for (const name of SCENARIOS) {
      const s = st.scenarios[name];
      if (s?.approvalUrl) log(`  [${name}] order=${s.orderId} rel=${s.approvalRel}\n    ${s.approvalUrl}`);
    }
    log("\nThe return redirect may show a 404 page: expected (no return route exists in Phase 1).");
    log("When done, run: npm run spike -- wait-approval");
  },

  async "wait-approval"() {
    const st = loadState();
    const deadline = Date.now() + flag("minutes", 10) * 60_000;
    const last: Record<string, string> = {};
    for (;;) {
      let allApproved = true;
      for (const name of SCENARIOS) {
        const s = st.scenarios[name];
        if (!s?.orderId) continue;
        const { order } = await getOrder(s.orderId, true);
        if (last[name] !== order.status) {
          log(`  ${name}: order ${s.orderId} status=${order.status}`);
          last[name] = order.status;
        }
        if (order.status !== "APPROVED") allApproved = false;
      }
      if (allApproved) break;
      if (Date.now() > deadline) {
        log("Timed out waiting for human approval. Nothing was automated. Re-run when you have approved.");
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    for (const name of SCENARIOS) {
      setContext("S03", `Order status after human buyer approval (scenario: ${name})`);
      await getOrder(st.scenarios[name]!.orderId!);
    }
    log("All orders report APPROVED per PayPal. Next: npm run spike -- authorize");
  },

  async authorize() {
    const st = loadState();
    for (const name of SCENARIOS) {
      const s = scenarioOf(st, name);
      setContext("S04", `Authorize approved order (scenario: ${name})`);
      const { order } = await getOrder(s.orderId!);
      show(`${name} order status (fresh GET)`, order.status);
      if (order.status !== "APPROVED" && !st.ops[`${name}:authorize:1`]) {
        log(`  skipping ${name}: order is not APPROVED`);
        continue;
      }
      const r = await executeWrite(client, st, {
        key: `${name}:authorize:1`,
        type: "AUTHORIZE",
        scenario: name,
        path: `/v2/checkout/orders/${s.orderId}/authorize`,
        prefer: "return=representation",
      });
      reportWrite(r);
      if (r.response?.ok) {
        const authz = orderSchema.parse(r.response.body).purchase_units?.[0]?.payments?.authorizations?.[0];
        if (!authz) throw new Error("authorize succeeded but purchase_units[0].payments.authorizations[0] missing");
        s.authId = authz.id;
        saveState(st);
        show(`${name} authorization id`, `${authz.id} (status ${authz.status})`);
      }
      if (s.authId) await inspectAuth(name, "S05");
    }
  },

  async "full-capture"() {
    const st = loadState();
    const authId = authIdOf(st, "full");
    setContext("S06", "Full capture (scenario: full)");
    const r = await executeWrite(client, st, {
      key: "full:capture:1",
      type: "CAPTURE",
      scenario: "full",
      path: `/v2/payments/authorizations/${authId}/capture`,
      body: captureBody({ amount: AMOUNT, finalCapture: true, invoiceId: `${st.runId}-full` }),
      prefer: "return=representation",
    });
    reportWrite(r);
    await inspectAuth("full", "S06b");
    if (r.op.resourceId) {
      setContext("S06c", "GET capture (scenario: full)");
      const { capture } = await getCapture(r.op.resourceId);
      show("capture", { id: capture.id, status: capture.status, amount: capture.amount, final_capture: capture.final_capture });
    }
    await inspectOrder("full", "S06d");
  },

  async "idempotent-repeat"() {
    const st = loadState();
    const op = st.ops["full:capture:1"];
    if (!op || op.status !== "CONFIRMED") throw new Error("full:capture:1 must be CONFIRMED first");
    setContext("S11", "Idempotent repeat: SAME PayPal-Request-Id and SAME body as full:capture:1");
    const first = op.resourceId;
    const { response, error } = await sendOp(client, st, op);
    show("first capture id", first ?? "?");
    if (response) show("repeat response", { http: response.status, id: (response.body as { id?: string })?.id, body: response.body });
    if (error) show("repeat error", `${error.code}: ${error.message}`);
    op.resourceId = first ?? op.resourceId;
    saveState(st);
    await inspectOrder("full", "S11b");
  },

  async "partial-final"() {
    const st = loadState();
    const authId = authIdOf(st, "partial_final");
    setContext("S07", `Partial capture ${PARTIAL} of ${AMOUNT}, final_capture=true (scenario: partial_final)`);
    const r = await executeWrite(client, st, {
      key: "partial_final:capture:1",
      type: "CAPTURE",
      scenario: "partial_final",
      path: `/v2/payments/authorizations/${authId}/capture`,
      body: captureBody({ amount: PARTIAL, finalCapture: true, invoiceId: `${st.runId}-partial_final` }),
      prefer: "return=representation",
    });
    reportWrite(r);
    await inspectAuth("partial_final", "S08");
    await inspectOrder("partial_final", "S08b");
  },

  async "probe-final"() {
    // Observation only: what does PayPal do with the remainder after final_capture=true?
    const st = loadState();
    const authId = authIdOf(st, "partial_final");
    setContext("S08c", "Probe: second capture of 2.00 after final_capture=true (expected to be rejected)");
    reportWrite(
      await executeWrite(client, st, {
        key: "partial_final:capture:2",
        type: "CAPTURE",
        scenario: "partial_final",
        path: `/v2/payments/authorizations/${authId}/capture`,
        body: captureBody({ amount: "2.00", finalCapture: true, invoiceId: `${st.runId}-partial_final-2` }),
      }),
    );
    setContext("S08d", "Probe: explicit void after final_capture=true");
    reportWrite(
      await executeWrite(client, st, {
        key: "partial_final:void:1",
        type: "VOID",
        scenario: "partial_final",
        path: `/v2/payments/authorizations/${authId}/void`,
      }),
    );
    await inspectAuth("partial_final", "S08e");
  },

  async "partial-open"() {
    const st = loadState();
    const authId = authIdOf(st, "partial_open");
    const timeoutMs = flag("timeout-ms", 300);
    setContext("S09", `Partial capture ${PARTIAL}, final_capture=false, client timeout ${timeoutMs}ms (scenario: partial_open)`);
    const r = await executeWrite(
      client,
      st,
      {
        key: "partial_open:capture:1",
        type: "CAPTURE",
        scenario: "partial_open",
        path: `/v2/payments/authorizations/${authId}/capture`,
        body: captureBody({ amount: PARTIAL, finalCapture: false, invoiceId: `${st.runId}-partial_open` }),
        prefer: "return=representation",
      },
      timeoutMs,
    );
    reportWrite(r);
    if (r.op.status === "UNKNOWN") {
      log("  Outcome UNKNOWN. NOT retrying. Run: npm run spike -- reconcile");
    }
  },

  async "inspect-remainder"() {
    await inspectAuth("partial_open", "S10");
    await inspectOrder("partial_open", "S10b");
  },

  async "void-remainder"() {
    const st = loadState();
    const authId = authIdOf(st, "partial_open");
    setContext("S10c", "Explicit void of the remaining authorization after partial capture (scenario: partial_open)");
    reportWrite(
      await executeWrite(client, st, {
        key: "partial_open:void:1",
        type: "VOID",
        scenario: "partial_open",
        path: `/v2/payments/authorizations/${authId}/void`,
      }),
    );
    await inspectAuth("partial_open", "S10d");
  },

  async void() {
    const st = loadState();
    const authId = authIdOf(st, "void");
    setContext("S12", "Void an untouched authorization (scenario: void)");
    reportWrite(
      await executeWrite(client, st, {
        key: "void:void:1",
        type: "VOID",
        scenario: "void",
        path: `/v2/payments/authorizations/${authId}/void`,
      }),
    );
    await inspectAuth("void", "S12b");
  },

  async "capture-after-void"() {
    const st = loadState();
    const authId = authIdOf(st, "void");
    setContext("S13", "Capture attempt AFTER void (expected rejection; error shape)");
    const r = await executeWrite(client, st, {
      key: "void:capture:1",
      type: "CAPTURE",
      scenario: "void",
      path: `/v2/payments/authorizations/${authId}/capture`,
      body: captureBody({ amount: AMOUNT, finalCapture: true, invoiceId: `${st.runId}-void-late` }),
    });
    reportWrite(r);
    if (r.response && !r.response.ok) show("normalized", toPayPalError(r.response).code);
    await inspectAuth("void", "S13b");
  },

  /** Reconcile non-terminal operations: fresh GET first; re-send only with the SAME request id. */
  async reconcile() {
    const st = loadState();
    const pending = Object.values(st.ops).filter((o) => o.status !== "CONFIRMED" && o.status !== "FAILED");
    if (pending.length === 0) return log("No unresolved operations.");
    for (const op of pending) {
      setContext("S14", `Reconcile ${op.key} (status ${op.status}) via fresh GET`);
      log(`- ${op.key}: ${op.status}`);
      await reconcileOp(st, op);
    }
  },

  /** Step 10: fresh GET of every order/authorization/capture against recorded operations. */
  async "reconcile-all"() {
    const st = loadState();
    for (const name of SCENARIOS) {
      const s = st.scenarios[name];
      if (!s?.orderId) continue;
      log(`\n== ${name}`);
      setContext("S15", `Final reconcile: fresh order (scenario: ${name})`);
      const { order } = await getOrder(s.orderId);
      const p = order.purchase_units?.[0]?.payments;
      show("order", { status: order.status, captures: p?.captures?.map((c) => `${c.id}:${c.status}`) });
      if (s.authId) {
        setContext("S15", `Final reconcile: fresh authorization (scenario: ${name})`);
        const { auth } = await getAuth(s.authId);
        show("authorization", { status: auth.status, amount: auth.amount });
      }
      for (const op of Object.values(st.ops).filter((o) => o.scenario === name)) {
        show("  op", `${op.key} local=${op.status} http=${op.httpStatus ?? "-"} resource=${op.resourceId ?? "-"}`);
      }
    }
  },

  async status() {
    const st = loadState();
    log(`runId=${st.runId}`);
    for (const s of Object.values(st.scenarios)) log(`  ${s.name}: order=${s.orderId ?? "-"} auth=${s.authId ?? "-"}`);
    for (const o of Object.values(st.ops)) log(`  op ${o.key}: ${o.status} http=${o.httpStatus ?? "-"} attempts=${o.attempts}`);
  },
};

async function reconcileOp(st: State, op: Op) {
  const sc = st.scenarios[op.scenario]!;
  if (op.type === "CAPTURE") {
    const { order } = await getOrder(sc.orderId!);
    const invoice = (op.body as { invoice_id?: string }).invoice_id;
    const found = order.purchase_units?.[0]?.payments?.captures?.find((c) => c.invoice_id === invoice);
    if (found) {
      op.status = "CONFIRMED";
      op.resourceId = found.id;
      op.error = `reconciled: capture ${found.id} exists with status ${found.status}`;
      saveState(st);
      return log(`  capture exists on PayPal (${found.id}, ${found.status}); marked CONFIRMED, NOT re-sent`);
    }
    const { auth } = await getAuth(sc.authId!);
    if (auth.status === "CREATED") {
      log("  no capture exists and the authorization is untouched: re-sending with the SAME request id");
      const r = await sendOp(client, st, op);
      return show("resend", r.response ? `http ${r.response.status} -> ${op.status}` : `${r.error?.code} -> ${op.status}`);
    }
    return log(`  authorization status ${auth.status} without a matching capture: needs a human; NOT re-sending`);
  }
  if (op.type === "AUTHORIZE") {
    const { order } = await getOrder(sc.orderId!);
    const a = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (a) {
      op.status = "CONFIRMED";
      op.resourceId = a.id;
      sc.authId = a.id;
      saveState(st);
      return log(`  authorization ${a.id} exists; marked CONFIRMED, NOT re-sent`);
    }
    if (order.status === "APPROVED") {
      const r = await sendOp(client, st, op);
      return show("resend (same request id)", r.response ? `http ${r.response.status} -> ${op.status}` : `${r.error?.code}`);
    }
    return log(`  order status ${order.status}: needs a human`);
  }
  if (op.type === "VOID") {
    const { auth } = await getAuth(sc.authId!);
    if (auth.status === "VOIDED") {
      op.status = "CONFIRMED";
      saveState(st);
      return log("  authorization is VOIDED on PayPal; marked CONFIRMED, NOT re-sent");
    }
    const r = await sendOp(client, st, op);
    return show("resend (same request id)", r.response ? `http ${r.response.status} -> ${op.status}` : `${r.error?.code}`);
  }
  if (op.type === "CREATE_ORDER") {
    const r = await sendOp(client, st, op); // same request id: PayPal returns the original order if it was created
    if (r.response?.ok) sc.orderId = (r.response.body as { id: string }).id;
    saveState(st);
    return show("resend (same request id)", r.response ? `http ${r.response.status}` : `${r.error?.code}`);
  }
}

async function main() {
  const fn = command ? commands[command] : undefined;
  if (!fn) {
    log(`Unknown command. Available: ${Object.keys(commands).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  try {
    await fn();
  } catch (e) {
    if (e instanceof UnreconciledOperationError || e instanceof PayPalError || e instanceof Error) {
      console.error(`ERROR: ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  }
}

void main();
export type { PayPalResponse };
