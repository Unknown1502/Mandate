/**
 * PayPal SANDBOX end-to-end test, STAGE 2 ONLY: the BUYER approves the existing order on PayPal's own checkout page; this script then reads the order once to verify it.
 * It never calls the server-side authorization, capture, void or refund, creates no order, never advances the deal, and writes nothing to the database.
 *
 * Every mode needs: --expect-order-id <PayPal order id> --stage1-evidence <docs/qa/paypal-e2e-stage1-*.json> (no order id is built into this script; the evidence, the database
 * deal and the recorded approval link must all name the same order), and DATABASE_URL pointing at mandate_e2e.
 *
 *   npx tsx scripts/paypal-e2e-stage2.ts ... --validate-offline
 *       Runs every precondition and cross-check and prints PASS/FAIL. Sends nothing (a guard refuses every non-loopback request), opens nothing, writes nothing.
 *
 *   npx tsx scripts/paypal-e2e-stage2.ts --env-file .env.local --open-checkout
 *       Opens the order's recorded PayPal Sandbox approval page in a clean INCOGNITO Chrome window so the human can sign in as the dedicated Sandbox buyer. This process sends
 *       ZERO requests (every non-loopback request is refused by a guard); the browser talks to PayPal, the human approves.
 *
 *   PAYPAL_MODE=sandbox npx tsx scripts/paypal-e2e-stage2.ts --env-file .env.local --expect-client-id-fingerprint <8 hex> --expect-buyer-email <alias> \
 *       --expect-business-email <alias> --verify-approval --approve-stage2-read
 *       After the human says the approval is done: EXACTLY TWO requests, enforced by an allow-list guard that refuses anything else before it is sent:
 *         1. POST /v1/oauth2/token   (the SDK's own token request)      2. GET /v2/checkout/orders/{the expected order id}   (one read, no retry)
 *       The gateway is wrapped in the closed write lock, so even a bug could not send a write.
 *
 * Both modes refuse to run (exit 3, nothing sent) unless: the database is mandate_e2e, it holds exactly the expected deal and order, the deal is still AWAITING_BUYER_APPROVAL with
 * no authorization id, and PAYPAL_SANDBOX_WRITES is NOT set to "authorized" (the write lock must be closed for Stage 2). Evidence is sanitized: no token, no credential, no approval link.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/db/client";
import { parsePayPalEnv, SANDBOX_BASE_URL } from "../src/lib/env";
import { SandboxWriteLock } from "../src/lib/runtime";
import { createSandboxSdkGateway } from "../src/paypal/sdk-gateway";
import { installOutboundGuard } from "./lib/outbound-guard";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
// no order id is built into this script: the operator names the order, and it must also match the Stage 1 evidence and the local deal (checked below)
const EXPECTED_ORDER = arg("expect-order-id") ?? "";
const EVIDENCE_PATH = arg("stage1-evidence");
const E2E_DB = "mandate_e2e";
const PP_HOST = new URL(SANDBOX_BASE_URL).hostname;

const envFile = arg("env-file");
if (envFile) process.loadEnvFile(envFile); // never overrides variables already set in the process

const open = flag("open-checkout");
const verify = flag("verify-approval");
const validateOnly = flag("validate-offline");
const problems: string[] = [];
if ([open, verify, validateOnly].filter(Boolean).length !== 1) problems.push("choose exactly one mode: --validate-offline, --open-checkout or --verify-approval");
if (!/^[A-Z0-9]{10,24}$/.test(EXPECTED_ORDER)) problems.push("--expect-order-id is required (the PayPal order id from the Stage 1 evidence)");
if (!EVIDENCE_PATH) problems.push("--stage1-evidence <file> is required (the sanitized Stage 1 evidence for this order)");
if (process.env.PAYPAL_SANDBOX_WRITES === "authorized") problems.push("PAYPAL_SANDBOX_WRITES is 'authorized': the write lock must be CLOSED for Stage 2");
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, ""));
} catch {
  /* reported below */
}
if (dbName !== E2E_DB) problems.push(`DATABASE_URL must point at the dedicated database ${E2E_DB} (set it for this run; the persistent env file points elsewhere)`);
let pp: ReturnType<typeof parsePayPalEnv> | undefined;
if (verify) {
  if (process.env.PAYPAL_MODE !== "sandbox") problems.push("PAYPAL_MODE must be set to sandbox for this run");
  try {
    pp = parsePayPalEnv(process.env);
    const fp = createHash("sha256").update(pp.PAYPAL_CLIENT_ID).digest("hex").slice(0, 8);
    if (fp !== arg("expect-client-id-fingerprint")) problems.push("--expect-client-id-fingerprint is required and must match the configured Client ID");
  } catch {
    problems.push("PayPal Sandbox configuration invalid");
  }
  if (!arg("expect-buyer-email") || !arg("expect-business-email")) problems.push("--expect-buyer-email and --expect-business-email are required");
  if (!flag("approve-stage2-read")) problems.push("NOT APPROVED: add --approve-stage2-read to send the two verification requests");
}
if (problems.length > 0) {
  console.log("PAYPAL E2E STAGE 2: NOT STARTED. No request was made.");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(3);
}

// ---- the local deal must be exactly what Stage 1 left (database READ only) -------------------------------------------------------------------------------------
const deals = await prisma.deal.findMany();
const deal = deals.length === 1 ? deals[0]! : undefined;
const dealProblems: string[] = [];
if (!deal) dealProblems.push(`${E2E_DB} must hold exactly one deal (found ${deals.length})`);
else {
  if (deal.paypalOrderId !== EXPECTED_ORDER) dealProblems.push("the deal's order is not the expected order id");
  if (deal.state !== "AWAITING_BUYER_APPROVAL") dealProblems.push(`the deal is ${deal.state}, expected AWAITING_BUYER_APPROVAL`);
  if (deal.paypalAuthId) dealProblems.push("the deal already has an authorization id: Stage 2 must not run");
  if (!deal.price || deal.price.toString() !== "20") dealProblems.push("the locked price is not 20.00");
  // the Stage 1 evidence must name THIS order, THIS deal and the same amount/intent, and PayPal's read-back must have shown the order bound to the deal
  try {
    const ev = JSON.parse(readFileSync(EVIDENCE_PATH!, "utf8")) as { order?: { id?: string; intent?: string; amount?: string; currency?: string; boundToDeal?: boolean }; deal?: { id?: string }; payeeVerification?: { matches?: unknown } };
    if (ev.order?.id !== EXPECTED_ORDER) dealProblems.push("the Stage 1 evidence names a different order");
    if (ev.deal?.id !== deal.id) dealProblems.push("the Stage 1 evidence names a different deal");
    if (ev.order?.intent !== "AUTHORIZE" || ev.order?.amount !== "20.00" || ev.order?.currency !== "USD") dealProblems.push("the Stage 1 evidence is not a 20.00 USD AUTHORIZE order");
    if (ev.order?.boundToDeal !== true) dealProblems.push("the Stage 1 evidence does not show the order bound to the deal");
    if (ev.payeeVerification?.matches !== true) dealProblems.push("the Stage 1 evidence does not show a verified payee");
  } catch {
    dealProblems.push("the Stage 1 evidence file could not be read");
  }
}
if (dealProblems.length > 0 || !deal) {
  console.log("PAYPAL E2E STAGE 2: NOT STARTED. No request was made.");
  for (const p of dealProblems) console.log(`  - ${p}`);
  await prisma.$disconnect();
  process.exit(3);
}

/** the recorded approval link must be exactly the Sandbox checkout page for THIS order */
const approvalLinkIsForThisOrder = (() => {
  try {
    const u = new URL(deal.approvalUrl ?? "");
    return u.protocol === "https:" && u.hostname === "www.sandbox.paypal.com" && u.pathname === "/checkoutnow" && u.searchParams.get("token") === EXPECTED_ORDER && [...u.searchParams.keys()].length === 1;
  } catch {
    return false;
  }
})();

if (validateOnly) {
  const guard = installOutboundGuard([]); // nothing may leave this process
  const checks: [string, boolean][] = [
    ["the order id matches the Stage 1 evidence (order, deal, 20.00 USD AUTHORIZE, bound to the deal, payee verified)", true],
    [`the local deal ${deal.id} holds exactly this order and is AWAITING_BUYER_APPROVAL with no authorization id`, true],
    ["the recorded approval link is exactly the Sandbox checkout page for this order", approvalLinkIsForThisOrder],
    ["the database holds only this one deal (no other order is reachable from this run)", deals.length === 1],
    ["the write lock is closed (PAYPAL_SANDBOX_WRITES is not authorized)", process.env.PAYPAL_SANDBOX_WRITES !== "authorized"],
  ];
  console.log("PAYPAL E2E STAGE 2: OFFLINE VALIDATION (no request, nothing opened, no database write)");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`  requests sent by this process: ${guard.log.length} (guard refused ${guard.blocked().length})`);
  await prisma.$disconnect();
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

if (open) {
  const guard = installOutboundGuard([]); // this process may send nothing
  const link = deal.approvalUrl ?? "";
  if (!approvalLinkIsForThisOrder) {
    console.log("REFUSED: the recorded approval link is not the Sandbox checkout page for the expected order. Nothing was opened.");
    await prisma.$disconnect();
    process.exit(5);
  }
  const chrome = arg("chrome") ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(chrome)) {
    console.log("Chrome was not found at the expected path; nothing was opened. Pass --chrome <path>.");
    await prisma.$disconnect();
    process.exit(5);
  }
  spawn(chrome, ["--incognito", "--new-window", link], { detached: true, stdio: "ignore" }).unref(); // the BROWSER requests PayPal; this process does not
  console.log("PAYPAL SANDBOX CHECKOUT OPENED (clean incognito window)");
  console.log(`  page          https://www.sandbox.paypal.com/checkoutnow?token=${EXPECTED_ORDER}`);
  console.log(`  sign in as    the dedicated Sandbox BUYER account ${arg("expect-buyer-email") ?? "(alias not given)"}, then approve (click the pay / continue button)`);
  console.log("  this process  sent 0 requests (guard refused count: " + guard.blocked().length + "); it did not authorize, capture, void, refund or create anything");
  console.log("  afterwards    the browser may show an error page at localhost:3000/paypal/return: expected and harmless (no app is running); tell the assistant the approval is done");
  await prisma.$disconnect();
  process.exit(0);
}

// ---- verify: exactly two requests ---------------------------------------------------------------------------------------------------------------------------------------
const guard = installOutboundGuard([
  { name: "1-oauth-token", method: "POST", host: PP_HOST, path: /^\/v1\/oauth2\/token$/, max: 1 },
  { name: "2-read-order", method: "GET", host: PP_HOST, path: new RegExp(`^/v2/checkout/orders/${EXPECTED_ORDER}$`), max: 1 },
]);
const gateway = new SandboxWriteLock(createSandboxSdkGateway({ clientId: pp!.PAYPAL_CLIENT_ID, clientSecret: pp!.PAYPAL_CLIENT_SECRET }), false); // closed lock: a write could not leave
const startedAt = new Date();
const res = await gateway.getOrder(EXPECTED_ORDER);
guard.uninstall();
const o = (res.kind === "ok" ? res.body : null) as {
  id?: string;
  status?: string;
  intent?: string;
  create_time?: string;
  update_time?: string;
  payer?: { email_address?: string; payer_id?: string };
  purchase_units?: { reference_id?: string; custom_id?: string; amount?: { currency_code?: string; value?: string }; payee?: { email_address?: string; merchant_id?: string }; payments?: { authorizations?: unknown[]; captures?: unknown[] } }[];
} | null;
const pu = o?.purchase_units?.[0];
const expectedBuyer = arg("expect-buyer-email")!;
const expectedBusiness = arg("expect-business-email")!;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const after = await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
const allowed = guard.log.filter((e) => e.allowed && e.rule !== "loopback");
const evidence = {
  stage: "2 of the PayPal Sandbox E2E: buyer approval, verified by one read",
  ranAt: startedAt.toISOString(),
  environment: { paypalMode: "sandbox (process-level)", writesLock: "CLOSED (PAYPAL_SANDBOX_WRITES not set; gateway wrapped in the closed lock)", database: E2E_DB },
  outboundRequests: { permitted: 2, allowedAndSent: allowed.map((e) => ({ rule: e.rule, method: e.method, host: e.host, path: e.path.replace(EXPECTED_ORDER, "{orderId}") })), refusedByGuard: guard.blocked() },
  read: { outcome: res.kind, httpStatus: "status" in res ? res.status : null, debugId: "debugId" in res ? (res.debugId ?? null) : null },
  order: o ? { id: o.id, status: o.status, intent: o.intent, amount: pu?.amount?.value, currency: pu?.amount?.currency_code, createTime: o.create_time, updateTime: o.update_time, authorizationsOnOrder: pu?.payments?.authorizations?.length ?? 0, capturesOnOrder: pu?.payments?.captures?.length ?? 0 } : null,
  verification: {
    orderIdMatches: o?.id === EXPECTED_ORDER,
    statusIsApproved: o?.status === "APPROVED",
    intentIsAuthorize: o?.intent === "AUTHORIZE",
    amountIs20USD: pu?.amount?.value === "20.00" && pu?.amount?.currency_code === "USD",
    stillBoundToTheDeal: pu?.reference_id === deal.id && pu?.custom_id === deal.id,
    payeeIsExpectedBusiness: same(pu?.payee?.email_address, expectedBusiness),
    payerIsExpectedBuyer: same(o?.payer?.email_address, expectedBuyer),
    payer: o?.payer ? { email_address: o.payer.email_address, payer_id: o.payer.payer_id } : null,
    noAuthorizationOrCaptureExists: (pu?.payments?.authorizations?.length ?? 0) === 0 && (pu?.payments?.captures?.length ?? 0) === 0,
  },
  localDealUnchanged: { id: after.id, state: after.state, paypalOrderId: after.paypalOrderId, paypalAuthId: after.paypalAuthId, lockedPrice: after.price?.toString() },
  notDone: ["server-side authorization", "capture", "void", "refund", "another order", "any read of the four spike orders", "any database write"],
};
mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-e2e-stage2-${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify(evidence, null, 2) + "\n");
const v = evidence.verification;
console.log("RESULT (2 requests permitted: token + one order read)");
console.log(`  requests sent      ${allowed.length} (${allowed.map((e) => e.rule).join(", ")}); refused by guard ${guard.blocked().length}`);
console.log(`  read               ${res.kind}${"status" in res ? `/${res.status}` : ""} debug ${"debugId" in res ? (res.debugId ?? "-") : "-"}`);
console.log(`  order              ${o?.id ?? "-"}  status ${o?.status ?? "-"}  intent ${o?.intent ?? "-"}  ${pu?.amount?.value ?? "-"} ${pu?.amount?.currency_code ?? ""}`);
console.log(`  approved by buyer  status APPROVED: ${v.statusIsApproved}   payer matches expected buyer: ${v.payerIsExpectedBuyer}   payer ${o?.payer?.email_address ?? "(none)"}`);
console.log(`  still this deal    ${v.stillBoundToTheDeal}   payee ok: ${v.payeeIsExpectedBusiness}   no authorization/capture exists: ${v.noAuthorizationOrCaptureExists}`);
console.log(`  local deal         ${after.state}, authorization id ${after.paypalAuthId ?? "none"} (unchanged by this script)`);
console.log(`Evidence written to ${out}`);
await prisma.$disconnect();
process.exit(res.kind === "ok" && v.orderIdMatches ? 0 : 1);
