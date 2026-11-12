/**
 * PayPal SANDBOX end-to-end test, STAGE 1 ONLY: create ONE new 20.00 USD Orders v2 order with intent AUTHORIZE for ONE new local deal, then stop.
 *
 *   PAYPAL_MODE=sandbox PAYPAL_SANDBOX_WRITES=authorized DATABASE_URL=<.../mandate_e2e> \
 *     npx tsx scripts/paypal-e2e-stage1.ts --env-file .env.local --expect-client-id-fingerprint <8 hex> --expect-business-email <alias> --approve-stage1-three-requests
 *
 * EXACTLY THREE outbound requests are permitted, enforced at the network entry points by an allow-list guard that refuses anything else BEFORE it is sent (scripts/lib/outbound-guard.ts):
 *   1. POST /v1/oauth2/token             (the SDK's own token request, once)
 *   2. POST /v2/checkout/orders          (create the order)
 *   3. GET  /v2/checkout/orders/{id}     (the engine's read-back that records the approval link and checks the order belongs to the deal)
 * No retry can leave the process. Nothing else is sent: no checkout, approval, authorization, capture, void or refund. The engine's usual follow-up read is stopped by a wrapper
 * (refreshApproval answers WAITING without a request), so the buyer's approval step is not even polled.
 *
 * It refuses to start (exit 3, no request) unless: PAYPAL_MODE=sandbox and PAYPAL_SANDBOX_WRITES=authorized are set in the PROCESS environment by the operator, the Sandbox base
 * URL and credentials validate, the Client ID fingerprint equals the expected one, the database is named mandate_e2e, and that database holds no PayPal order yet. Without the approval flag it
 * prints the plan and exits 4. The deal is negotiated in-process with the honest seller simulator and the rule-based buyer (no model call); the locked price is 20.00 USD.
 * It never prints or stores a token, a credential or an approval link; the evidence file holds sanitized fields only.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BuyerAgent, RuleBasedBuyerBrain } from "../src/agents/buyer";
import { HttpSellerClient } from "../src/agents/seller-client";
import { prisma } from "../src/db/client";
import { approveMandate, previewMandate } from "../src/domain/mandates";
import { loadSigningKeys } from "../src/domain/signing";
import type { TaskBrief } from "../src/domain/negotiation";
import { getEnv, parsePayPalEnv, SANDBOX_BASE_URL } from "../src/lib/env";
import { SandboxWriteLock } from "../src/lib/runtime";
import { Orchestrator } from "../src/orchestration/service";
import type { SettlementPort } from "../src/orchestration/ports";
import type { GwResult, PayPalGateway, WriteType } from "../src/paypal/gateway";
import { createSandboxSdkGateway } from "../src/paypal/sdk-gateway";
import { defaultEngineConfig } from "../src/settlement/engine";
import { createSettlementPort } from "../src/settlement/port";
import { createSellerServer } from "../seller-service/server";
import { installOutboundGuard } from "./lib/outbound-guard";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const E2E_DB = "mandate_e2e";

const envFile = arg("env-file");
if (envFile) {
  if (/onedrive/i.test(envFile)) console.log("WARNING: the env file is inside OneDrive (cloud-synced).");
  process.loadEnvFile(envFile); // does NOT override variables already set in the process (the operator's temporary PAYPAL_MODE, PAYPAL_SANDBOX_WRITES, DATABASE_URL win)
}

// ---- preconditions (no network, no database write) --------------------------------------------------------------------------------------------------------
const problems: string[] = [];
if (process.env.PAYPAL_MODE !== "sandbox") problems.push("PAYPAL_MODE must be set to sandbox in the process environment");
if (process.env.PAYPAL_SANDBOX_WRITES !== "authorized") problems.push("PAYPAL_SANDBOX_WRITES=authorized must be set by the operator for this run (the write lock is not open)");
let pp: ReturnType<typeof parsePayPalEnv> | undefined;
try {
  pp = parsePayPalEnv(process.env);
} catch (e) {
  problems.push(`PayPal Sandbox configuration invalid: ${String((e as Error).message).split("\n").slice(1, 5).join("; ")}`);
}
const fp = pp ? createHash("sha256").update(pp.PAYPAL_CLIENT_ID).digest("hex").slice(0, 8) : undefined;
if (!arg("expect-client-id-fingerprint")) problems.push("--expect-client-id-fingerprint is required");
else if (fp !== arg("expect-client-id-fingerprint")) problems.push("the Client ID fingerprint does not match the expected one (these are not the approved credentials)");
if (!arg("expect-business-email")) problems.push("--expect-business-email is required");
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  /* reported below */
}
if (dbName !== E2E_DB) problems.push(`DATABASE_URL must point at the dedicated database ${E2E_DB}`);
if (problems.length > 0) {
  console.log("PAYPAL E2E STAGE 1: NOT STARTED. No request was made.");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(3);
}

console.log("PAYPAL SANDBOX E2E - STAGE 1 (create one 20.00 USD AUTHORIZE order, then stop)");
console.log(`  requests      exactly THREE: POST ${SANDBOX_BASE_URL}/v1/oauth2/token, POST /v2/checkout/orders, GET /v2/checkout/orders/{id}; the guard refuses any other BEFORE it is sent`);
console.log(`  database      ${E2E_DB} (dedicated); deal: new, honest seller simulator + rule-based buyer, no model call`);
console.log("  will NOT      start buyer checkout, approve, authorize, capture, void or refund; the spike orders are not referenced; no production, no V2");
console.log(`  client id     fingerprint ${fp} matches the expected one`);
if (!flag("approve-stage1-three-requests")) {
  console.log("\nNOT APPROVED: no request was made. Re-run with --approve-stage1-three-requests.");
  process.exit(4);
}
if ((await prisma.deal.count({ where: { paypalOrderId: { not: null } } })) > 0) {
  console.log("\nREFUSED: this database already holds a deal with a PayPal order; Stage 1 creates exactly one order and will not run twice.");
  process.exit(5);
}

// ---- local setup (database only) -----------------------------------------------------------------------------------------------------------------------------
const app = getEnv();
const keys = loadSigningKeys(process.env);
const policy = { publicKeyB64: keys.publicKeyB64, maxRounds: 4 };
const user = await prisma.user.upsert({ where: { email: app.PRINCIPAL_EMAIL }, update: {}, create: { email: app.PRINCIPAL_EMAIL } }); // the same principal the dashboard login uses
const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", requireHumanAbove: "50", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
const mandate = await approveMandate(prisma, { principalId: user.id, principalEmail: user.email, draft, confirmDigest: previewMandate(user.id, draft).digest, keys });
const crit = (id: string, validator: string, params: Record<string, unknown>, required: boolean, weight: number) => ({ id, text: `${id} check`, type: "deterministic" as const, validator, params, required, weight });
const brief: TaskBrief = {
  description: "Clean the customer CSV (synthetic data)",
  criteria: [crit("schema", "csv_schema_matches", { columns: ["id", "email", "joined"] }, true, 40), crit("dupes", "no_duplicate_rows", {}, true, 30), crit("dates", "date_format_valid", { column: "joined", format: "YYYY-MM-DD" }, false, 30)],
  deadline: "2029-01-01T00:00:00.000Z",
  targetPrice: "20.00",
};
const seller = createSellerServer({ mode: "honest", floor: "18.00" });
await new Promise<void>((r) => seller.listen(0, "127.0.0.1", () => r()));
const sellerUrl = `http://127.0.0.1:${(seller.address() as AddressInfo).port}`;

// ---- the real gateway, wrapped only to COPY sanitized evidence (it changes nothing the engine sees) -----------------------------------------------------------
interface Tap {
  op: string;
  outcome: string;
  httpStatus: number | null;
  debugId: string | null;
  order?: Record<string, unknown>;
}
const taps: Tap[] = [];
function sanitizeOrder(body: unknown): Record<string, unknown> | undefined {
  const o = body as { id?: string; status?: string; intent?: string; create_time?: string; links?: { rel: string }[]; purchase_units?: { reference_id?: string; custom_id?: string; amount?: unknown; payee?: { email_address?: string; merchant_id?: string } }[] } | null;
  if (!o || typeof o !== "object") return undefined;
  const pu = o.purchase_units?.[0];
  return { id: o.id, status: o.status, intent: o.intent, create_time: o.create_time, linkRels: (o.links ?? []).map((l) => l.rel), reference_id: pu?.reference_id, custom_id: pu?.custom_id, amount: pu?.amount, payee: pu?.payee ? { email_address: pu.payee.email_address, merchant_id: pu.payee.merchant_id } : undefined };
}
class TapGateway implements PayPalGateway {
  constructor(private readonly inner: PayPalGateway) {}
  private tap(op: string, r: GwResult) {
    taps.push({ op, outcome: r.kind, httpStatus: "status" in r ? (r.status ?? null) : null, debugId: ("debugId" in r ? r.debugId : undefined) ?? null, order: r.kind === "ok" && /ORDER/.test(op) ? sanitizeOrder(r.body) : undefined });
    return r;
  }
  async write(type: WriteType, a: { requestId: string; path: string; body?: unknown; timeoutMs?: number }) {
    return this.tap(`write:${type}`, await this.inner.write(type, a));
  }
  async getOrder(id: string) {
    return this.tap("read:ORDER", await this.inner.getOrder(id));
  }
  async getAuthorization(id: string) {
    return this.tap("read:AUTHORIZATION", await this.inner.getAuthorization(id));
  }
  async getCapture(id: string) {
    return this.tap("read:CAPTURE", await this.inner.getCapture(id));
  }
}
const gateway = new TapGateway(new SandboxWriteLock(createSandboxSdkGateway({ clientId: pp!.PAYPAL_CLIENT_ID, clientSecret: pp!.PAYPAL_CLIENT_SECRET }), true));
const realPort = createSettlementPort({ db: prisma, gateway, deps: policy, config: defaultEngineConfig(app.APP_URL), now: () => new Date() });
const port: SettlementPort = {
  ...realPort,
  // Stage 1 stops before the buyer's approval: the engine's automatic follow-up read of the order is answered locally, so no second GET exists
  refreshApproval: async (dealId) => ({ status: "WAITING", reason: "STAGE1_STOPS_BEFORE_BUYER_APPROVAL", state: (await prisma.deal.findUniqueOrThrow({ where: { id: dealId }, select: { state: true } })).state }),
};
const orchestrator = new Orchestrator({ db: prisma, port, policy, negotiation: { buyer: new BuyerAgent(new RuleBasedBuyerBrain()), seller: new HttpSellerClient(sellerUrl), maxRounds: 4 } });

// independent recorder of every non-loopback TCP connect (evidence that nothing bypassed the guard)
const connects: string[] = [];
const origConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function (...a: any[]) {
  const o = a[0] && typeof a[0] === "object" ? a[0] : {};
  const host = String(o.host ?? o.hostname ?? "");
  if (host && !/^(127\.0\.0\.1|localhost|::1)$/.test(host)) connects.push(`${host}:${o.port ?? ""}`);
  return origConnect.apply(this, a as never);
};

// ---- THE GUARD, THEN THE ONE OPERATION -------------------------------------------------------------------------------------------------------------------------------
const PP_HOST = new URL(SANDBOX_BASE_URL).hostname;
const guard = installOutboundGuard([
  { name: "1-oauth-token", method: "POST", host: PP_HOST, path: /^\/v1\/oauth2\/token$/, max: 1 },
  { name: "2-create-order", method: "POST", host: PP_HOST, path: /^\/v2\/checkout\/orders$/, max: 1 },
  { name: "3-read-order", method: "GET", host: PP_HOST, path: /^\/v2\/checkout\/orders\/[A-Za-z0-9_-]{5,64}$/, max: 1 },
]);
const startedAt = new Date();
let thrown: string | undefined;
let opened: Awaited<ReturnType<Orchestrator["openDeal"]>> | undefined;
try {
  opened = await orchestrator.openDeal({ principalId: user.id, mandateId: mandate.id, sellerId: "seller-sim", brief });
} catch (e) {
  thrown = (e as Error).name;
}
guard.uninstall();
(net.Socket.prototype as any).connect = origConnect;

// ---- evidence (sanitized) ------------------------------------------------------------------------------------------------------------------------------------------------
const dealId = opened?.dealId;
const deal = dealId ? await prisma.deal.findUnique({ where: { id: dealId } }) : null;
const ops = dealId ? await prisma.payPalOperation.findMany({ where: { dealId }, orderBy: { createdAt: "asc" } }) : [];
const events = dealId ? await prisma.dealEvent.findMany({ where: { dealId }, orderBy: { seq: "asc" } }) : [];
const createTap = taps.find((t) => t.op === "write:CREATE_ORDER");
const readTap = taps.find((t) => t.op === "read:ORDER");
const order = (readTap?.order ?? createTap?.order) as { id?: string; status?: string; intent?: string; reference_id?: string; custom_id?: string; amount?: { currency_code?: string; value?: string }; payee?: { email_address?: string; merchant_id?: string } } | undefined;
const payeeEmail = order?.payee?.email_address;
const expectedBusiness = arg("expect-business-email")!;
const allowed = guard.log.filter((e) => e.allowed && e.rule !== "loopback");
const evidence = {
  stage: "1 of the PayPal Sandbox E2E: create the order only",
  ranAt: startedAt.toISOString(),
  environment: { paypalMode: "sandbox (process-level, this run only)", writes: "authorized (process-level, this run only; .env.local untouched)", baseUrl: SANDBOX_BASE_URL, database: E2E_DB, clientIdFingerprint: fp, v2: "disabled", production: "unavailable" },
  outboundRequests: {
    permitted: 3,
    allowedAndSent: allowed.map((e) => ({ rule: e.rule, method: e.method, host: e.host, path: e.path.replace(/\/orders\/[A-Za-z0-9_-]+$/, "/orders/{orderId}") })),
    refusedByGuard: guard.blocked(),
    nonLoopbackTcpConnects: connects,
  },
  paypal: { operations: taps.map((t) => ({ op: t.op, outcome: t.outcome, httpStatus: t.httpStatus, debugId: t.debugId })) },
  order: order ? { id: order.id, status: order.status, intent: order.intent, amount: order.amount?.value, currency: order.amount?.currency_code, referenceId: order.reference_id, customId: order.custom_id, boundToDeal: !!dealId && order.reference_id === dealId && order.custom_id === dealId } : null,
  payeeVerification: { expectedBusinessAccount: expectedBusiness, payeeEmailReturnedByPayPal: payeeEmail ?? null, merchantId: order?.payee?.merchant_id ?? null, matches: payeeEmail === undefined ? "payee not returned by PayPal (cannot verify)" : payeeEmail.toLowerCase() === expectedBusiness.toLowerCase() },
  buyerAccount: { expected: arg("expect-buyer-email") ?? "(not given)", verified: false, note: "the buyer account is only used when the buyer logs in on PayPal's page (next stage)" },
  deal: deal ? { id: deal.id, state: deal.state, lockedPrice: deal.price?.toString(), paypalOrderIdPersisted: deal.paypalOrderId === order?.id, paypalAuthId: deal.paypalAuthId, approvalLinkRecorded: !!deal.approvalUrl } : null,
  localOperations: ops.map((o) => ({ type: o.type, seq: o.seq, status: o.status, requestId: o.requestId, httpStatus: o.responseStatus, resourceStatus: o.resourceStatus, debugId: o.debugId })),
  ledgerEventTypes: events.map((e) => e.type),
  negotiation: opened?.negotiation,
  engineAdvance: opened?.advance ? { state: opened.advance.state, status: opened.advance.status, reason: opened.advance.reason, steps: opened.advance.steps } : null,
  threw: thrown ?? null,
  notDone: ["buyer checkout", "approval", "authorization", "capture", "void", "refund", "any read of the four spike orders"],
};
mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-e2e-stage1-${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify(evidence, null, 2) + "\n");

console.log("\nRESULT");
console.log(`  requests sent       ${allowed.length} of 3 permitted (${allowed.map((e) => e.rule).join(", ") || "none"}); refused by guard: ${guard.blocked().length}; non-loopback TCP connects: ${connects.length}`);
console.log(`  PayPal operations   ${taps.map((t) => `${t.op}=${t.outcome}${t.httpStatus ? `/${t.httpStatus}` : ""} debug ${t.debugId ?? "-"}`).join(" | ") || "none"}`);
console.log(`  order               ${order?.id ?? "none"}  status ${order?.status ?? "-"}  intent ${order?.intent ?? "-"}  ${order?.amount?.value ?? "-"} ${order?.amount?.currency_code ?? ""}`);
console.log(`  bound to deal       ${evidence.order?.boundToDeal ?? false}   payee ${payeeEmail ?? "(not returned)"}   matches expected business account: ${evidence.payeeVerification.matches}`);
console.log(`  local deal          ${deal?.state ?? "none"}  locked price ${deal?.price?.toString() ?? "-"}  order persisted: ${evidence.deal?.paypalOrderIdPersisted ?? false}`);
console.log(`Evidence written to ${out} (sanitized: no token, no credential, no approval link).`);
await new Promise<void>((r) => seller.close(() => r()));
await prisma.$disconnect();
const ok = deal?.state === "AWAITING_BUYER_APPROVAL" && allowed.length === 3 && !!order?.id && guard.blocked().length === 0;
process.exit(ok ? 0 : 1);
