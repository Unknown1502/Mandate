/**
 * PayPal SANDBOX end-to-end test, STAGE 3 ONLY: the server-side AUTHORIZATION of the order the buyer already approved. One authorization, then stop.
 *
 *   PAYPAL_MODE=sandbox PAYPAL_SANDBOX_WRITES=authorized DATABASE_URL=<.../mandate_e2e> npx tsx scripts/paypal-e2e-stage3.ts --env-file .env.local \
 *     --expect-order-id <id> --stage1-evidence <file> --stage2-evidence <file> --expect-client-id-fingerprint <8 hex> --expect-buyer-email <alias> \
 *     --expect-business-email <alias> --approve-stage3-authorize
 *
 * It runs the settlement engine's own approval step (port.refreshApproval) for the one deal, and nothing else. Exactly FIVE outbound requests are permitted, in this order,
 * enforced by an allow-list guard that refuses anything else (or the right request at the wrong time) BEFORE it is sent; no retry can leave the process:
 *   1. POST /v1/oauth2/token                                 the SDK's own token request (made lazily by the first call below)
 *   2. GET  /v2/checkout/orders/{id}                         the engine's mandatory FRESH read: must show APPROVED and be bound to this deal at 20.00 USD, else it refuses to authorize
 *   3. POST /v2/checkout/orders/{id}/authorize               THE WRITE: PayPal-Request-Id <dealId>-AUTHORIZE-1, empty body, Prefer return=representation (a hold of 20.00 USD, not a capture)
 *   4. GET  /v2/checkout/orders/{id}                         read-back: finds the authorization id on the order
 *   5. GET  /v2/payments/authorizations/{authorizationId}    reads the authorization resource: must be CREATED, 20.00 USD, with a usable expiry
 * Never sent: capture, void, refund, reauthorize, a new order. If the authorize POST's outcome is unknown, the engine returns UNRESOLVED and the guard stops any second POST.
 *
 * It refuses to start (exit 3, nothing sent) unless the operator set PAYPAL_MODE=sandbox and PAYPAL_SANDBOX_WRITES=authorized for this run, the database is mandate_e2e with exactly one
 * deal that holds the expected order in AWAITING_BUYER_APPROVAL with no authorization and no authorize/capture/void operation, and the Stage 1 and Stage 2 evidence both describe this
 * very order and deal (Stage 2: buyer = expected, status APPROVED, no authorization or capture on the order). Without the approval flag it prints the plan and exits 4.
 * Evidence is sanitized: no token, no credential, no approval link.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/db/client";
import { loadSigningKeys } from "../src/domain/signing";
import { getEnv, parsePayPalEnv, SANDBOX_BASE_URL } from "../src/lib/env";
import { SandboxWriteLock } from "../src/lib/runtime";
import type { GwResult, PayPalGateway, WriteType } from "../src/paypal/gateway";
import { createSandboxSdkGateway } from "../src/paypal/sdk-gateway";
import { defaultEngineConfig } from "../src/settlement/engine";
import { createSettlementPort } from "../src/settlement/port";
import { installOutboundGuard } from "./lib/outbound-guard";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const E2E_DB = "mandate_e2e";
const ORDER = arg("expect-order-id") ?? "";
const PP_HOST = new URL(SANDBOX_BASE_URL).hostname;
const validateOnly = flag("validate-offline");

const envFile = arg("env-file");
if (envFile) process.loadEnvFile(envFile); // never overrides variables already set in the process

// ---- preconditions (no network, no database write) ------------------------------------------------------------------------------------------------------------
const problems: string[] = [];
if (process.env.PAYPAL_MODE !== "sandbox") problems.push("PAYPAL_MODE must be set to sandbox in the process environment");
if (!validateOnly && process.env.PAYPAL_SANDBOX_WRITES !== "authorized") problems.push("PAYPAL_SANDBOX_WRITES=authorized must be set by the operator for this run (the write lock is not open)");
let pp: ReturnType<typeof parsePayPalEnv> | undefined;
try {
  pp = parsePayPalEnv(process.env);
} catch {
  problems.push("PayPal Sandbox configuration invalid");
}
const fp = pp ? createHash("sha256").update(pp.PAYPAL_CLIENT_ID).digest("hex").slice(0, 8) : undefined;
if (!arg("expect-client-id-fingerprint") || fp !== arg("expect-client-id-fingerprint")) problems.push("--expect-client-id-fingerprint is required and must match the configured Client ID");
if (!/^[A-Z0-9]{10,24}$/.test(ORDER)) problems.push("--expect-order-id is required (the approved PayPal order id)");
if (!arg("stage1-evidence") || !arg("stage2-evidence")) problems.push("--stage1-evidence and --stage2-evidence are required");
if (!arg("expect-buyer-email") || !arg("expect-business-email")) problems.push("--expect-buyer-email and --expect-business-email are required");
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  /* reported below */
}
if (dbName !== E2E_DB) problems.push(`DATABASE_URL must point at the dedicated database ${E2E_DB}`);
if (problems.length > 0) {
  console.log("PAYPAL E2E STAGE 3: NOT STARTED. No request was made.");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(3);
}

console.log("PAYPAL SANDBOX E2E - STAGE 3 (server-side AUTHORIZATION of the approved order, then stop)");
console.log(`  order         ${ORDER}  (20.00 USD, intent AUTHORIZE)   host ${PP_HOST}`);
console.log("  requests      exactly FIVE, in this order, no retry; the guard refuses anything else or any request out of order BEFORE it is sent:");
console.log(`    1. POST /v1/oauth2/token                              SDK token request (no state change)`);
console.log(`    2. GET  /v2/checkout/orders/${ORDER}   fresh read; the engine authorizes ONLY if APPROVED, bound to this deal, 20.00 USD`);
console.log(`    3. POST /v2/checkout/orders/${ORDER}/authorize   the write: a 20.00 USD hold, order becomes COMPLETED, NOT a capture`);
console.log(`    4. GET  /v2/checkout/orders/${ORDER}   read-back (finds the authorization id)`);
console.log("    5. GET  /v2/payments/authorizations/{authorizationId}   must be CREATED, 20.00 USD, with a usable expiry");
console.log("  will NOT      capture, void, refund, reauthorize or create an order; spike orders not referenced; no production, no V2");
if (!validateOnly && !flag("approve-stage3-authorize")) {
  console.log("\nNOT APPROVED: no request was made. Re-run with --approve-stage3-authorize.");
  process.exit(4);
}

// ---- the local deal and both evidence files must describe exactly this order ---------------------------------------------------------------------------------
const deals = await prisma.deal.findMany();
const deal = deals.length === 1 ? deals[0]! : undefined;
const dealProblems: string[] = [];
if (!deal) dealProblems.push(`${E2E_DB} must hold exactly one deal (found ${deals.length})`);
else {
  if (deal.paypalOrderId !== ORDER) dealProblems.push("the deal's order is not the expected order id");
  if (deal.state !== "AWAITING_BUYER_APPROVAL") dealProblems.push(`the deal is ${deal.state}, expected AWAITING_BUYER_APPROVAL`);
  if (deal.paypalAuthId) dealProblems.push("the deal already has an authorization id");
  if (!deal.price || deal.price.toString() !== "20") dealProblems.push("the locked price is not 20.00");
  const ops = await prisma.payPalOperation.findMany({ where: { dealId: deal.id } });
  if (ops.some((o) => o.type !== "CREATE_ORDER")) dealProblems.push("the deal already has an authorize/capture/void operation");
  try {
    const e1 = JSON.parse(readFileSync(arg("stage1-evidence")!, "utf8"));
    const e2 = JSON.parse(readFileSync(arg("stage2-evidence")!, "utf8"));
    if (e1.order?.id !== ORDER || e1.deal?.id !== deal.id || e1.order?.boundToDeal !== true || e1.payeeVerification?.matches !== true) dealProblems.push("the Stage 1 evidence does not describe this order and deal");
    const v = e2.verification ?? {};
    if (e2.order?.id !== ORDER || e2.order?.status !== "APPROVED" || v.payerIsExpectedBuyer !== true || v.stillBoundToTheDeal !== true || v.payeeIsExpectedBusiness !== true || v.noAuthorizationOrCaptureExists !== true) dealProblems.push("the Stage 2 evidence does not show this order approved by the expected buyer with no authorization or capture");
    if (e2.verification?.payer?.email_address?.toLowerCase() !== arg("expect-buyer-email")!.toLowerCase()) dealProblems.push("the Stage 2 payer is not the expected buyer");
  } catch {
    dealProblems.push("an evidence file could not be read");
  }
}
if (dealProblems.length > 0 || !deal) {
  console.log("\nREFUSED: preconditions on the local deal or the evidence failed. No request was made.");
  for (const p of dealProblems) console.log(`  - ${p}`);
  await prisma.$disconnect();
  process.exit(5);
}

if (validateOnly) {
  // offline validation: every precondition above and below passed; nothing is sent, nothing is written, no gateway is even created
  const g = installOutboundGuard([]);
  console.log("\nOFFLINE VALIDATION PASSED (no request, no database write, write lock not required and not opened)");
  console.log("  PASS  the deal holds exactly this order, is AWAITING_BUYER_APPROVAL, locked price 20.00, no authorization id, only the CREATE_ORDER operation");
  console.log("  PASS  Stage 1 evidence: this order and deal, bound to the deal, payee = expected Business account");
  console.log("  PASS  Stage 2 evidence: this order APPROVED by the expected buyer, still bound, payee ok, no authorization or capture on the order (as of that read)");
  console.log(`  requests sent by this process: ${g.log.length}`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---- the real gateway, wrapped only to COPY sanitized evidence ------------------------------------------------------------------------------------------------
interface Tap {
  op: string;
  outcome: string;
  httpStatus: number | null;
  debugId: string | null;
  body?: Record<string, unknown>;
}
const taps: Tap[] = [];
function sanitize(body: unknown): Record<string, unknown> | undefined {
  const o = body as Record<string, any> | null;
  if (!o || typeof o !== "object") return undefined;
  const pu = o.purchase_units?.[0];
  const auths = (pu?.payments?.authorizations ?? []).map((a: any) => ({ id: a.id, status: a.status, amount: a.amount, expiration_time: a.expiration_time }));
  const caps = pu?.payments?.captures ?? [];
  return {
    id: o.id,
    status: o.status,
    intent: o.intent,
    amount: o.amount ?? pu?.amount,
    expiration_time: o.expiration_time,
    create_time: o.create_time,
    referenceId: pu?.reference_id,
    customId: pu?.custom_id,
    payee: pu?.payee ? { email_address: pu.payee.email_address, merchant_id: pu.payee.merchant_id } : undefined,
    authorizationsOnOrder: pu ? auths : undefined,
    capturesOnOrder: pu ? caps.length : undefined,
    linkRels: (o.links ?? []).map((l: any) => l.rel),
  };
}
class TapGateway implements PayPalGateway {
  constructor(private readonly inner: PayPalGateway) {}
  private tap(op: string, r: GwResult) {
    taps.push({ op, outcome: r.kind, httpStatus: "status" in r ? (r.status ?? null) : null, debugId: ("debugId" in r ? r.debugId : undefined) ?? null, body: r.kind === "ok" ? sanitize(r.body) : undefined });
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
const app = getEnv();
const keys = loadSigningKeys(process.env);
const gateway = new TapGateway(new SandboxWriteLock(createSandboxSdkGateway({ clientId: pp!.PAYPAL_CLIENT_ID, clientSecret: pp!.PAYPAL_CLIENT_SECRET }), true));
const port = createSettlementPort({ db: prisma, gateway, deps: { publicKeyB64: keys.publicKeyB64, maxRounds: 4 }, config: defaultEngineConfig(app.APP_URL), now: () => new Date() });

// ---- THE GUARD, THEN THE ONE ENGINE STEP ---------------------------------------------------------------------------------------------------------------------------
const ORDER_PATH = new RegExp(`^/v2/checkout/orders/${ORDER}$`);
const guard = installOutboundGuard([
  { name: "1-oauth-token", method: "POST", host: PP_HOST, path: /^\/v1\/oauth2\/token$/, max: 1 },
  { name: "2-fresh-order-read", method: "GET", host: PP_HOST, path: ORDER_PATH, max: 1, after: "1-oauth-token" },
  { name: "3-authorize", method: "POST", host: PP_HOST, path: new RegExp(`^/v2/checkout/orders/${ORDER}/authorize$`), max: 1, after: "2-fresh-order-read" },
  { name: "4-readback-order", method: "GET", host: PP_HOST, path: ORDER_PATH, max: 1, after: "3-authorize" },
  { name: "5-read-authorization", method: "GET", host: PP_HOST, path: /^\/v2\/payments\/authorizations\/[A-Za-z0-9]{10,24}$/, max: 1, after: "4-readback-order" },
]);
const startedAt = new Date();
let thrown: string | undefined;
let result: { status: string; reason?: string; state: string } | undefined;
try {
  result = await port.refreshApproval(deal.id); // the engine's own step: fresh read, binding check, authorize, read-back, authorization check, state transition
} catch (e) {
  thrown = (e as Error).name;
}
guard.uninstall();

// ---- evidence (sanitized) --------------------------------------------------------------------------------------------------------------------------------------------------
const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
const ops = await prisma.payPalOperation.findMany({ where: { dealId: deal.id }, orderBy: { createdAt: "asc" } });
const events = await prisma.dealEvent.findMany({ where: { dealId: deal.id }, orderBy: { seq: "asc" } });
const allowed = guard.log.filter((e) => e.allowed && e.rule !== "loopback");
const reads = taps.filter((t) => t.op === "read:ORDER");
const authRead = taps.find((t) => t.op === "read:AUTHORIZATION")?.body as { id?: string; status?: string; amount?: { value?: string; currency_code?: string }; expiration_time?: string } | undefined;
const orderAfter = reads[reads.length - 1]?.body as { status?: string; authorizationsOnOrder?: { id?: string }[]; capturesOnOrder?: number } | undefined;
const freshRead = reads[0]?.body as { status?: string; referenceId?: string; customId?: string; amount?: { value?: string; currency_code?: string } } | undefined;
const evidence = {
  stage: "3 of the PayPal Sandbox E2E: server-side authorization of the approved order",
  ranAt: startedAt.toISOString(),
  environment: { paypalMode: "sandbox (process-level, this run only)", writes: "authorized (process-level, this run only; .env.local untouched)", baseUrl: SANDBOX_BASE_URL, database: E2E_DB, clientIdFingerprint: fp, v2: "disabled" },
  outboundRequests: { permitted: 5, allowedAndSent: allowed.map((e) => ({ rule: e.rule, method: e.method, host: e.host, path: e.path.replace(ORDER, "{orderId}").replace(/\/authorizations\/[A-Za-z0-9]+$/, "/authorizations/{authorizationId}") })), refusedByGuard: guard.blocked() },
  paypal: { operations: taps.map((t) => ({ op: t.op, outcome: t.outcome, httpStatus: t.httpStatus, debugId: t.debugId })) },
  freshReadBeforeAuthorize: freshRead ? { status: freshRead.status, boundToDeal: freshRead.referenceId === deal.id && freshRead.customId === deal.id, amount: freshRead.amount?.value, currency: freshRead.amount?.currency_code } : null,
  orderAfter: orderAfter ? { status: orderAfter.status, authorizationIdsOnOrder: (orderAfter.authorizationsOnOrder ?? []).map((a) => a.id), capturesOnOrder: orderAfter.capturesOnOrder } : null,
  authorization: authRead ? { id: authRead.id, status: authRead.status, amount: authRead.amount?.value, currency: authRead.amount?.currency_code, expiresAt: authRead.expiration_time } : null,
  verification: {
    authorizationIsCreated: authRead?.status === "CREATED",
    amountIs20USD: authRead?.amount?.value === "20.00" && authRead?.amount?.currency_code === "USD",
    authorizationIdMatchesOrder: !!authRead?.id && (orderAfter?.authorizationsOnOrder ?? []).some((a) => a.id === authRead.id),
    noCaptureExists: (orderAfter?.capturesOnOrder ?? 1) === 0,
    persistedOnDeal: !!after.paypalAuthId && after.paypalAuthId === authRead?.id,
  },
  engineResult: result ?? null,
  localDeal: { id: after.id, state: after.state, paypalOrderId: after.paypalOrderId, paypalAuthId: after.paypalAuthId, paypalAuthStatus: after.paypalAuthStatus, authExpiresAt: after.authExpiresAt?.toISOString() ?? null, lockedPrice: after.price?.toString() },
  localOperations: ops.map((o) => ({ type: o.type, seq: o.seq, status: o.status, requestId: o.requestId, httpStatus: o.responseStatus, resourceStatus: o.resourceStatus, debugId: o.debugId })),
  ledgerEventTypes: events.map((e) => e.type),
  threw: thrown ?? null,
  notDone: ["capture", "void", "refund", "reauthorize", "another order", "any read of the four spike orders"],
};
mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-e2e-stage3-${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify(evidence, null, 2) + "\n");

const v = evidence.verification;
console.log("\nRESULT");
console.log(`  requests sent       ${allowed.length} of 5 permitted (${allowed.map((e) => e.rule).join(", ") || "none"}); refused by guard: ${guard.blocked().length}`);
console.log(`  PayPal operations   ${taps.map((t) => `${t.op}=${t.outcome}${t.httpStatus ? `/${t.httpStatus}` : ""} debug ${t.debugId ?? "-"}`).join(" | ") || "none"}`);
console.log(`  engine              ${result ? `${result.status}${result.reason ? ` (${result.reason})` : ""}, deal state ${result.state}` : `threw ${thrown}`}`);
console.log(`  authorization       ${authRead?.id ?? "none"}  status ${authRead?.status ?? "-"}  ${authRead?.amount?.value ?? "-"} ${authRead?.amount?.currency_code ?? ""}  expires ${authRead?.expiration_time ?? "-"}`);
console.log(`  order after         ${orderAfter?.status ?? "-"}   captures on order: ${orderAfter?.capturesOnOrder ?? "-"}   persisted on the deal: ${v.persistedOnDeal}`);
console.log(`Evidence written to ${out} (sanitized: no token, no credential, no approval link).`);
await prisma.$disconnect();
process.exit(after.state === "AWAITING_DELIVERY" && allowed.length === 5 && v.authorizationIsCreated && v.amountIs20USD && v.persistedOnDeal && guard.blocked().length === 0 ? 0 : 1);
