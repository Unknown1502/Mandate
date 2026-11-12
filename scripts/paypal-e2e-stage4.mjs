/**
 * PayPal Sandbox E2E, STAGE 4 ONLY: one CLEAN delivery from the honest seller simulator and the deterministic verification of it. Nothing else.
 *
 *   node scripts/paypal-e2e-stage4.mjs --env-file .env.local --deal <dealId> --expect-order-id <id> --expect-authorization-id <id> \
 *        --stage3-evidence <docs/qa/paypal-e2e-stage3-*.json> --approve-stage4-delivery
 * (the app's deal view does not expose the authorization id, so it is cross-checked against the Stage 3 evidence; the database is checked separately, read-only)
 *
 * It talks ONLY to the locally running MANDATE app on 127.0.0.1 (the same routes the dashboard buttons use): login, read status/deal, ONE POST /api/deals/{id}/delivery
 * {"quality":"good"}, read the deal again. It never calls accept, advance, review, challenge, decision or mock-approval, makes no request to PayPal or anywhere else, and refuses
 * to run unless the app reports Sandbox mode with the write lock CLOSED and the deal is exactly where Stage 3 left it (AWAITING_DELIVERY, this order, this authorization, no settlement).
 * Evidence: docs/qa/paypal-e2e-stage4-<time>.json (sanitized: no credential, no session cookie, no CSRF token).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const BASE = "http://127.0.0.1:3000"; // loopback only; no other host is ever contacted
if (arg("env-file")) process.loadEnvFile(arg("env-file"));
const DEAL = arg("deal");
const ORDER = arg("expect-order-id");
const AUTH = arg("expect-authorization-id");
const EV3 = arg("stage3-evidence");

const problems = [];
if (!DEAL || !ORDER || !AUTH || !EV3) problems.push("--deal, --expect-order-id, --expect-authorization-id and --stage3-evidence are required");
if (!process.env.PRINCIPAL_EMAIL || !process.env.PRINCIPAL_LOGIN_SECRET || !process.env.APP_URL) problems.push("principal credentials / APP_URL are not available");
if (problems.length) {
  console.log("PAYPAL E2E STAGE 4: NOT STARTED. Nothing was sent.");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(3);
}
const origin = process.env.APP_URL;
let cookie = "";
let csrf = "";
async function call(method, path, body) {
  const headers = { origin, cookie };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] = csrf;
  }
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, setCookie: res.headers.getSetCookie?.() ?? [], body: await res.json().catch(() => ({})) };
}

// login (the same single-principal login the dashboard uses)
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: process.env.PRINCIPAL_EMAIL, secret: process.env.PRINCIPAL_LOGIN_SECRET }) });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
csrf = (await login.json().catch(() => ({}))).csrfToken ?? "";
if (!login.ok || !cookie || !csrf) {
  console.log("PAYPAL E2E STAGE 4: NOT STARTED. Login to the local app failed. Nothing else was sent.");
  process.exit(3);
}

// ---- preconditions, all read-only ------------------------------------------------------------------------------------------------------------------------------
const status = (await call("GET", "/api/status")).body;
const before = (await call("GET", `/api/deals/${DEAL}`)).body;
const d = before.deal ?? {};
const pre = [
  ["the app is in PayPal Sandbox mode on the SDK gateway", status.paypal === "sandbox-live" && status.paypalGateway === "sandbox-sdk"],
  ["the Sandbox write lock is CLOSED", status.sandboxWritesAuthorized === false],
  ["V2 is disabled", status.v2 === "disabled"],
  ["a seller simulator is configured", status.sellerConfigured === true],
  ["the deal is AWAITING_DELIVERY", d.state === "AWAITING_DELIVERY"],
  ["the deal holds the expected order", d.paypalOrderId === ORDER],
  ["Stage 3 evidence: this authorization, CREATED, 20.00 USD, persisted on the deal, no capture on the order", (() => { try { const e = JSON.parse(readFileSync(EV3, "utf8")); return e.authorization?.id === AUTH && e.authorization?.status === "CREATED" && e.authorization?.amount === "20.00" && e.verification?.persistedOnDeal === true && e.verification?.noCaptureExists === true && e.localDeal?.id === DEAL; } catch { return false; } })()],
  ["the app's deal view reports the authorization as CREATED", d.paypalAuthStatus === "CREATED"],
  ["no delivery and no settlement exist yet", !before.delivery && !before.settlement],
  ["only CREATE_ORDER and AUTHORIZE operations exist (no capture, void or refund)", (before.paypalOperations ?? []).map((o) => o.type).join(",") === "CREATE_ORDER,AUTHORIZE"],
];
console.log("PAYPAL SANDBOX E2E - STAGE 4 (one clean delivery and its deterministic verification, nothing else)");
for (const [name, ok] of pre) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
if (!pre.every(([, ok]) => ok)) {
  console.log("REFUSED: a precondition failed. No delivery was requested.");
  process.exit(5);
}
if (!flag("approve-stage4-delivery")) {
  console.log("\nNOT APPROVED: nothing was requested. Re-run with --approve-stage4-delivery.");
  process.exit(4);
}

// ---- the ONE mutation: the clean delivery from the honest simulator ------------------------------------------------------------------------------------
const startedAt = new Date();
const delivery = await call("POST", `/api/deals/${DEAL}/delivery`, { quality: "good" });
const after = (await call("GET", `/api/deals/${DEAL}`)).body;
const a = after.deal ?? {};
const ver = after.verification ?? null;
const res = ver?.result ?? {};
const checks = (res.results ?? res.criteria ?? []).map((r) => ({ criterionId: r.criterionId ?? r.id, status: r.status, source: r.source ?? null, required: r.required ?? undefined }));
const events = after.events ?? [];
const evidence = {
  stage: "4 of the PayPal Sandbox E2E: clean delivery and deterministic verification only",
  ranAt: startedAt.toISOString(),
  app: { paypal: status.paypal, gateway: status.paypalGateway, sandboxWritesAuthorized: status.sandboxWritesAuthorized, v2: status.v2, buyerBrain: status.buyerBrain, challengeWindowSeconds: status.challengeWindowSeconds },
  requestsToTheApp: ["POST /api/auth/login", "GET /api/status", "GET /api/deals/{id} (x2)", "POST /api/deals/{id}/delivery {quality: good} (x1)"],
  notCalled: ["accept", "advance", "review", "challenge", "decision", "mock-approval", "any PayPal endpoint (the app's outbound guard also refuses every non-loopback request)"],
  deliveryRoute: { httpStatus: delivery.status, delivery: delivery.body.delivery ?? null, advance: delivery.body.advance ?? null },
  delivery: after.delivery ? { id: after.delivery.id, sizeBytes: after.delivery.size ?? null, artifactSha256: after.delivery.sha256 ?? null, mediaType: after.delivery.mediaType ?? null, previewHeader: String(after.delivery.preview ?? "").split("\n")[0], flags: after.delivery.flags ?? null } : null,
  verification: ver ? { overall: ver.overall, flags: res.flags ?? [], criteria: checks, deterministicOnly: ver.deterministicOnly ?? true, usedModel: ver.usedModel ?? false } : null,
  settlementDecision: after.settlement ?? null,
  buyerAcceptance: { decision: "PENDING", acceptedByBuyer: false },
  paypal: { orderId: a.paypalOrderId, authorizationId: a.paypalAuthId, authorizationStatusLastReadFromPayPal: a.paypalAuthStatus, authorizationExpiresAt: a.authExpiresAt ?? null, capturedAmount: a.capturedAmount ?? null, operations: (after.paypalOperations ?? []).map((o) => ({ type: o.type, status: o.status, resourceStatus: o.resourceStatus ?? null })) },
  localDeal: { id: a.id, state: a.state, lockedPrice: a.price },
  ledgerEventTypes: events.map((e) => e.type),
};
mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-e2e-stage4-${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify(evidence, null, 2) + "\n");
console.log(`\nRESULT\n  delivery route      HTTP ${delivery.status}, delivery ${delivery.body.delivery?.status ?? "?"}${delivery.body.delivery?.reason ? ` (${delivery.body.delivery.reason})` : ""}`);
console.log(`  deal state          ${a.state}`);
console.log(`  verification        ${ver?.overall ?? "none"}; ${checks.map((c) => `${c.criterionId}=${c.status}`).join(", ") || "no criteria"}; flags ${(res.flags ?? []).length}`);
console.log(`  settlement decision ${after.settlement ? JSON.stringify(after.settlement.decision ?? after.settlement) : "none yet"}`);
console.log("  buyer acceptance    PENDING (no accept request was made)");
console.log(`  authorization       ${a.paypalAuthId} last read from PayPal as ${a.paypalAuthStatus}; captured: ${a.capturedAmount ?? "none"}; operations ${evidence.paypal.operations.map((o) => o.type).join(",")}`);
console.log(`Evidence written to ${out}`);
process.exit(delivery.status === 200 ? 0 : 1);
