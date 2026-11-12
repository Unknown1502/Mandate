/**
 * PayPal SANDBOX end-to-end test, STAGE 5 ONLY: the ONE final capture of exactly 20.00 USD against the existing authorization, under the existing expired-challenge-window rule.
 *
 *   PAYPAL_MODE=sandbox PAYPAL_SANDBOX_WRITES=authorized DATABASE_URL=<.../mandate_e2e> npx tsx scripts/paypal-e2e-stage5.ts --env-file .env.local --deal <id> \
 *     --expect-order-id <id> --expect-authorization-id <id> --stage3-evidence <file> --stage4-evidence <file> --expect-client-id-fingerprint <8 hex> --approve-stage5-capture
 *
 * It runs the settlement engine's OWN path for the one deal (Orchestrator.advance from VERIFYING: re-derive the whole authorization, verification and decision, fresh reads, capture,
 * read-back, reconcile). It records NO acceptance and fabricates nothing: the basis is "verification passed and the buyer's challenge window ended unused".
 * Exactly SIX outbound requests are permitted, in this order, enforced by an allow-list guard that refuses anything else (or the right request at the wrong time) BEFORE it is sent:
 *   1. POST /v1/oauth2/token                                          the SDK's token request
 *   2. GET  /v2/payments/authorizations/{authorizationId}             the settlement-decision read (must be CREATED, 20.00 USD, unexpired)
 *   3. GET  /v2/payments/authorizations/{authorizationId}             the fresh pre-capture check
 *   4. POST /v2/payments/authorizations/{authorizationId}/capture     THE WRITE: 20.00 USD, final_capture true, PayPal-Request-Id <dealId>-CAPTURE-1, invoice_id <dealId>-settle-1
 *   5. GET  /v2/payments/captures/{captureId}                         read-back (must be COMPLETED)
 *   6. GET  /v2/payments/authorizations/{authorizationId}             reconciliation
 * No retry can leave the process: a second capture POST, any void/refund/reauthorize, any order request, any extra read is refused. If the capture's outcome is unknown, the engine stops
 * (UNRESOLVED) and this script reports it; it never re-sends.
 *
 * It refuses to start (exit 3 or 5, nothing sent) unless the operator set PAYPAL_MODE=sandbox and PAYPAL_SANDBOX_WRITES=authorized for this run, the credentials match the fingerprint,
 * the database is mandate_e2e with exactly one deal in VERIFYING that holds this order and authorization, its challenge window has ended, and nothing was ever captured, voided or settled.
 * Evidence is sanitized: no token, no credential, no approval link.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/db/client";
import { loadSigningKeys } from "../src/domain/signing";
import { getEnv, parsePayPalEnv, SANDBOX_BASE_URL } from "../src/lib/env";
import { SandboxWriteLock } from "../src/lib/runtime";
import { Orchestrator } from "../src/orchestration/service";
import type { GwResult, PayPalGateway, WriteType } from "../src/paypal/gateway";
import { createSandboxSdkGateway } from "../src/paypal/sdk-gateway";
import { defaultEngineConfig } from "../src/settlement/engine";
import { createSettlementPort } from "../src/settlement/port";
import { installOutboundGuard } from "./lib/outbound-guard";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const E2E_DB = "mandate_e2e";
const DEAL = arg("deal") ?? "";
const ORDER = arg("expect-order-id") ?? "";
const AUTH = arg("expect-authorization-id") ?? "";
const PP_HOST = new URL(SANDBOX_BASE_URL).hostname;
if (arg("env-file")) process.loadEnvFile(arg("env-file")!); // never overrides variables already set in the process

// ---- preconditions (no network, no database write) ------------------------------------------------------------------------------------------------------------
const problems: string[] = [];
if (process.env.PAYPAL_MODE !== "sandbox") problems.push("PAYPAL_MODE must be set to sandbox in the process environment");
if (process.env.PAYPAL_SANDBOX_WRITES !== "authorized") problems.push("PAYPAL_SANDBOX_WRITES=authorized must be set by the operator for this run (the write lock is not open)");
let pp: ReturnType<typeof parsePayPalEnv> | undefined;
try {
  pp = parsePayPalEnv(process.env);
} catch {
  problems.push("PayPal Sandbox configuration invalid");
}
const fp = pp ? createHash("sha256").update(pp.PAYPAL_CLIENT_ID).digest("hex").slice(0, 8) : undefined;
if (!arg("expect-client-id-fingerprint") || fp !== arg("expect-client-id-fingerprint")) problems.push("--expect-client-id-fingerprint is required and must match the configured Client ID");
if (!/^[A-Za-z0-9_-]{10,40}$/.test(DEAL) || !/^[A-Z0-9]{10,24}$/.test(ORDER) || !/^[A-Z0-9]{10,24}$/.test(AUTH)) problems.push("--deal, --expect-order-id and --expect-authorization-id are required");
if (!arg("stage3-evidence") || !arg("stage4-evidence")) problems.push("--stage3-evidence and --stage4-evidence are required");
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  /* reported below */
}
if (dbName !== E2E_DB) problems.push(`DATABASE_URL must point at the dedicated database ${E2E_DB}`);
if (problems.length > 0) {
  console.log("PAYPAL E2E STAGE 5: NOT STARTED. No request was made.");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(3);
}

console.log("PAYPAL SANDBOX E2E - STAGE 5 (ONE capture of exactly 20.00 USD under the expired-challenge-window rule, then stop)");
console.log(`  deal ${DEAL}   order ${ORDER}   authorization ${AUTH}   host ${PP_HOST}`);
console.log("  requests      exactly SIX, in this order, no retry; the guard refuses anything else or any request out of order BEFORE it is sent:");
console.log("    1. POST /v1/oauth2/token                                       SDK token request (no state change)");
console.log(`    2. GET  /v2/payments/authorizations/${AUTH}   settlement-decision read: must be CREATED, 20.00 USD, unexpired`);
console.log(`    3. GET  /v2/payments/authorizations/${AUTH}   fresh pre-capture check`);
console.log(`    4. POST /v2/payments/authorizations/${AUTH}/capture   THE WRITE: capture 20.00 USD, final_capture true`);
console.log("    5. GET  /v2/payments/captures/{captureId}                       read-back: must be COMPLETED");
console.log(`    6. GET  /v2/payments/authorizations/${AUTH}   reconciliation`);
console.log("  basis         verification ALL_REQUIRED_PASSED + challenge window ended unused; NO acceptance event is recorded or fabricated");
console.log("  will NOT      capture twice, void, refund, reauthorize or create an order; spike orders not referenced; no production, no V2");
if (!flag("approve-stage5-capture")) {
  console.log("\nNOT APPROVED: no request was made. Re-run with --approve-stage5-capture.");
  process.exit(4);
}

// ---- the local deal and the evidence must describe exactly this state ------------------------------------------------------------------------------------------
const deals = await prisma.deal.findMany();
const deal = deals.length === 1 ? deals[0]! : undefined;
const bad: string[] = [];
if (!deal || deal.id !== DEAL) bad.push(`${E2E_DB} must hold exactly the expected deal (found ${deals.length})`);
else {
  const ops = await prisma.payPalOperation.findMany({ where: { dealId: deal.id } });
  const settlements = await prisma.settlement.count({ where: { dealId: deal.id } });
  if (deal.state !== "VERIFYING") bad.push(`the deal is ${deal.state}, expected VERIFYING`);
  if (deal.paypalOrderId !== ORDER) bad.push("the deal's order is not the expected order id");
  if (deal.paypalAuthId !== AUTH || deal.paypalAuthStatus !== "CREATED") bad.push("the deal's authorization is not the expected one in CREATED");
  if (!deal.price || deal.price.toString() !== "20") bad.push("the locked price is not 20.00");
  if (!deal.challengeWindowEndsAt || deal.challengeWindowEndsAt >= new Date()) bad.push("the challenge window has not ended");
  if (deal.capturedAmount !== null) bad.push("something is already recorded as captured");
  if (settlements > 0) bad.push("a settlement record already exists");
  if (ops.some((o) => o.type !== "CREATE_ORDER" && o.type !== "AUTHORIZE")) bad.push("a capture/void/other operation already exists");
  try {
    const e3 = JSON.parse(readFileSync(arg("stage3-evidence")!, "utf8"));
    const e4 = JSON.parse(readFileSync(arg("stage4-evidence")!, "utf8"));
    if (e3.authorization?.id !== AUTH || e3.authorization?.status !== "CREATED" || e3.authorization?.amount !== "20.00" || e3.verification?.persistedOnDeal !== true) bad.push("the Stage 3 evidence does not describe this authorization");
    if (e4.verification?.overall !== "ALL_REQUIRED_PASSED" || e4.localDeal?.id !== DEAL || (e4.buyerAcceptance?.acceptedByBuyer ?? false) !== false) bad.push("the Stage 4 evidence does not show the verified, unaccepted delivery");
  } catch {
    bad.push("an evidence file could not be read");
  }
}
if (bad.length > 0 || !deal) {
  console.log("\nREFUSED: preconditions on the local deal or the evidence failed. No request was made.");
  for (const b of bad) console.log(`  - ${b}`);
  await prisma.$disconnect();
  process.exit(5);
}
const eventsBefore = await prisma.dealEvent.count({ where: { dealId: deal.id } });
const acceptBefore = await prisma.dealEvent.count({ where: { dealId: deal.id, type: "HUMAN_REVIEW_DECISION" } });

// ---- the real gateway, wrapped only to COPY sanitized evidence -------------------------------------------------------------------------------------------------
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
  const rb = o.seller_receivable_breakdown;
  return {
    id: o.id,
    status: o.status,
    amount: o.amount,
    final_capture: o.final_capture,
    invoice_id: o.invoice_id,
    create_time: o.create_time,
    update_time: o.update_time,
    expiration_time: o.expiration_time,
    sellerReceivable: rb ? { gross: rb.gross_amount, paypalFee: rb.paypal_fee, net: rb.net_amount } : undefined,
    statusDetails: o.status_details ? { reason: o.status_details.reason } : undefined,
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
const policy = { publicKeyB64: keys.publicKeyB64, maxRounds: 4 };
const gateway = new TapGateway(new SandboxWriteLock(createSandboxSdkGateway({ clientId: pp!.PAYPAL_CLIENT_ID, clientSecret: pp!.PAYPAL_CLIENT_SECRET }), true));
const port = createSettlementPort({ db: prisma, gateway, deps: policy, config: defaultEngineConfig(app.APP_URL), now: () => new Date() });
const orchestrator = new Orchestrator({ db: prisma, port, policy });

// ---- THE GUARD, THEN THE ONE ENGINE RUN ---------------------------------------------------------------------------------------------------------------------------
const AUTH_PATH = new RegExp(`^/v2/payments/authorizations/${AUTH}$`);
const guard = installOutboundGuard([
  { name: "1-oauth-token", method: "POST", host: PP_HOST, path: /^\/v1\/oauth2\/token$/, max: 1 },
  { name: "2-authorization-read", method: "GET", host: PP_HOST, path: AUTH_PATH, max: 1, after: "1-oauth-token" },
  { name: "3-fresh-authorization-read", method: "GET", host: PP_HOST, path: AUTH_PATH, max: 1, after: "2-authorization-read" },
  { name: "4-capture", method: "POST", host: PP_HOST, path: new RegExp(`^/v2/payments/authorizations/${AUTH}/capture$`), max: 1, after: "3-fresh-authorization-read" },
  { name: "5-capture-read", method: "GET", host: PP_HOST, path: /^\/v2\/payments\/captures\/[A-Za-z0-9]{10,24}$/, max: 1, after: "4-capture" },
  { name: "6-authorization-reconcile", method: "GET", host: PP_HOST, path: AUTH_PATH, max: 1, after: "5-capture-read" },
]);
const startedAt = new Date();
let thrown: string | undefined;
let advance: Awaited<ReturnType<Orchestrator["advance"]>> | undefined;
try {
  advance = await orchestrator.advance(deal.id); // the engine's own settlement path from VERIFYING
} catch (e) {
  thrown = (e as Error).name;
}
guard.uninstall();

// ---- evidence (sanitized) ------------------------------------------------------------------------------------------------------------------------------------------------------
const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
const ops = await prisma.payPalOperation.findMany({ where: { dealId: deal.id }, orderBy: { createdAt: "asc" } });
const settlement = await prisma.settlement.findUnique({ where: { dealId: deal.id } });
const events = await prisma.dealEvent.findMany({ where: { dealId: deal.id }, orderBy: { seq: "asc" } });
const allowed = guard.log.filter((e) => e.allowed && e.rule !== "loopback");
const cap = taps.find((t) => t.op === "write:CAPTURE")?.body as { id?: string; status?: string } | undefined;
const capRead = taps.find((t) => t.op === "read:CAPTURE")?.body as { id?: string; status?: string; amount?: { value?: string; currency_code?: string }; final_capture?: boolean; invoice_id?: string; sellerReceivable?: unknown; create_time?: string } | undefined;
const authReads = taps.filter((t) => t.op === "read:AUTHORIZATION").map((t) => t.body as { status?: string; amount?: { value?: string; currency_code?: string }; expiration_time?: string } | undefined);
const authFinal = authReads[authReads.length - 1];
const evidence = {
  stage: "5 of the PayPal Sandbox E2E: the one final capture",
  ranAt: startedAt.toISOString(),
  basis: "deterministic verification ALL_REQUIRED_PASSED; buyer challenge window ended unused; settlement decision FULL_CAPTURE; no explicit buyer acceptance event exists and none was created",
  environment: { paypalMode: "sandbox (process-level, this run only)", writes: "authorized (process-level, this run only; .env.local untouched)", baseUrl: SANDBOX_BASE_URL, database: E2E_DB, clientIdFingerprint: fp, v2: "disabled" },
  outboundRequests: { permitted: 6, allowedAndSent: allowed.map((e) => ({ rule: e.rule, method: e.method, host: e.host, path: e.path.replace(AUTH, "{authorizationId}").replace(/\/captures\/[A-Za-z0-9]+$/, "/captures/{captureId}") })), refusedByGuard: guard.blocked() },
  paypal: { operations: taps.map((t) => ({ op: t.op, outcome: t.outcome, httpStatus: t.httpStatus, debugId: t.debugId })) },
  authorizationReads: authReads,
  capturePost: cap ?? null,
  capture: capRead ? { id: capRead.id, status: capRead.status, amount: capRead.amount?.value, currency: capRead.amount?.currency_code, finalCapture: capRead.final_capture, invoiceId: capRead.invoice_id, sellerReceivable: capRead.sellerReceivable, createdAt: capRead.create_time } : null,
  verification: {
    captureIdMatchesPost: !!cap?.id && cap.id === capRead?.id,
    captureCompleted: capRead?.status === "COMPLETED",
    amountIs20USD: capRead?.amount?.value === "20.00" && capRead?.amount?.currency_code === "USD",
    finalCaptureTrue: capRead?.final_capture === true,
    invoiceIdIsStable: capRead?.invoice_id === `${deal.id}-settle-1`,
    requestIdIsStable: ops.some((o) => o.type === "CAPTURE" && o.requestId === `${deal.id}-CAPTURE-1`),
    authorizationAfter: authFinal?.status ?? null,
    exactlyOneCaptureOperation: ops.filter((o) => o.type === "CAPTURE").length === 1,
    noVoidNoRefund: !ops.some((o) => o.type === "VOID"),
    noAcceptanceEventFabricated: (await prisma.dealEvent.count({ where: { dealId: deal.id, type: "HUMAN_REVIEW_DECISION" } })) === acceptBefore,
  },
  engineRun: advance ? { state: advance.state, status: advance.status, reason: advance.reason ?? null, steps: advance.steps } : null,
  settlementRecord: settlement ? { decision: settlement.decision, earned: settlement.earned, amount: settlement.amount.toString(), reasonCodes: settlement.reasonCodes } : null,
  localDeal: { id: after.id, state: after.state, capturedAmount: after.capturedAmount?.toString() ?? null, lockedPrice: after.price?.toString(), paypalAuthStatus: after.paypalAuthStatus },
  localOperations: ops.map((o) => ({ type: o.type, seq: o.seq, status: o.status, requestId: o.requestId, httpStatus: o.responseStatus, resourceStatus: o.resourceStatus, debugId: o.debugId })),
  ledgerEventsAdded: events.length - eventsBefore,
  ledgerEventTypes: events.map((e) => e.type),
  threw: thrown ?? null,
  notDone: ["a second capture", "void", "refund", "reauthorize", "another order", "any acceptance event", "any read of the four spike orders"],
};
mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-e2e-stage5-${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify(evidence, null, 2) + "\n");

const v = evidence.verification;
console.log("\nRESULT");
console.log(`  requests sent       ${allowed.length} of 6 permitted (${allowed.map((e) => e.rule).join(", ") || "none"}); refused by guard: ${guard.blocked().length}`);
console.log(`  PayPal operations   ${taps.map((t) => `${t.op}=${t.outcome}${t.httpStatus ? `/${t.httpStatus}` : ""} debug ${t.debugId ?? "-"}`).join(" | ") || "none"}`);
console.log(`  engine              ${advance ? `${advance.status}${advance.reason ? ` (${advance.reason})` : ""}, deal state ${advance.state}` : `threw ${thrown}`}`);
console.log(`  capture             ${capRead?.id ?? cap?.id ?? "none"}  status ${capRead?.status ?? cap?.status ?? "-"}  ${capRead?.amount?.value ?? "-"} ${capRead?.amount?.currency_code ?? ""}  final_capture ${capRead?.final_capture ?? "-"}  invoice ${capRead?.invoice_id ?? "-"}`);
console.log(`  authorization after ${authFinal?.status ?? "-"}   local: ${after.state}, captured ${after.capturedAmount?.toString() ?? "none"}`);
console.log(`  checks              completed ${v.captureCompleted}, 20.00 USD ${v.amountIs20USD}, final ${v.finalCaptureTrue}, one capture op ${v.exactlyOneCaptureOperation}, no acceptance fabricated ${v.noAcceptanceEventFabricated}`);
console.log(`Evidence written to ${out} (sanitized: no token, no credential, no approval link).`);
await prisma.$disconnect();
process.exit(after.state === "CAPTURED" && allowed.length === 6 && v.captureCompleted && v.amountIs20USD && guard.blocked().length === 0 ? 0 : 1);
