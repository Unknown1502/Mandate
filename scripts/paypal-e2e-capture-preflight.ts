/**
 * PayPal Sandbox E2E, CAPTURE PREFLIGHT (read-only, offline). It applies the settlement engine's OWN pure functions to the real deal's stored records and the Stage 3 evidence and
 * prints the exact capture request plan. It sends NOTHING: an empty outbound guard refuses every non-loopback request, there is no gateway, and it writes no database row.
 *
 *   DATABASE_URL=<.../mandate_e2e> PAYPAL_MODE=sandbox npx tsx scripts/paypal-e2e-capture-preflight.ts --env-file .env.local --deal <id> --stage3-evidence <file>
 *
 * It answers: is the stored authorization unexpired, does the DETERMINISTIC settlement decision (decideSettlement over the locked terms and the recorded verification) permit a capture
 * of exactly the locked price, does any capture or settlement already exist, and are the idempotency keys and the duplicate-capture protections in place. It cannot answer what PayPal
 * would say now: that is what the first reads of the capture stage are for (the engine refuses to capture unless a fresh read shows CREATED, 20.00 USD, unexpired).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/db/client";
import { authorizeLoadedDeal } from "../src/domain/authorization";
import { D, fmt } from "../src/domain/money";
import { decideSettlement, verificationSchema, type CriterionResult } from "../src/domain/settlement";
import { loadSigningKeys } from "../src/domain/signing";
import { captureBody } from "../src/paypal/payloads";
import { defaultEngineConfig, validateAuthorization } from "../src/settlement/engine";
import { installOutboundGuard } from "./lib/outbound-guard";

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
if (arg("env-file")) process.loadEnvFile(arg("env-file")!);
const guard = installOutboundGuard([]); // nothing may leave this process
const DEAL = arg("deal");
const EV3 = arg("stage3-evidence");
if (!DEAL || !EV3 || !/mandate_e2e$/.test(new URL(process.env.DATABASE_URL ?? "postgresql://x/none").pathname)) {
  console.log("CAPTURE PREFLIGHT: NOT STARTED. --deal and --stage3-evidence are required and DATABASE_URL must point at mandate_e2e.");
  process.exit(3);
}

const now = new Date();
const deal = await prisma.deal.findUnique({ where: { id: DEAL }, include: { mandate: true, settlement: true, reservations: true, attestation: true } });
if (!deal) throw new Error("deal not found");
const ops = await prisma.payPalOperation.findMany({ where: { dealId: deal.id }, orderBy: { createdAt: "asc" } });
const ev3 = JSON.parse(readFileSync(EV3, "utf8"));
const keys = loadSigningKeys(process.env);
const config = defaultEngineConfig(process.env.APP_URL ?? "http://localhost:3000");

// the engine's own derivation, exactly as settleDeal does it (no mandate-expiry re-check at settlement)
const authz = authorizeLoadedDeal(deal, { publicKeyB64: keys.publicKeyB64, now });
const ver = verificationSchema.safeParse(deal.verificationJson);
const checks: { id: string; ok: boolean; detail: string }[] = [];
const add = (id: string, ok: boolean, detail = "") => checks.push({ id, ok, detail });

add("the full authorization of the deal re-derives from the stored records (mandate seal, terms hash, counterparty, attestation)", authz.ok, authz.ok ? "ok" : authz.reason);
const required = authz.ok ? authz.auth.terms.terms.criteria.filter((c) => c.required) : [];
const requiredMet = ver.success && required.length > 0 && required.every((c) => ver.data.results.some((r) => r.criterionId === c.id && r.status === "met"));
add("the recorded verification is intact: ALL required criteria are met and no flag was raised", ver.success && requiredMet && ver.data.flags.length === 0, ver.success ? `${required.length} required criteria, all met: ${requiredMet}; flags ${ver.data.flags.length}` : "verification record unreadable");

// the Stage 3 provider read of the authorization resource (the freshest PayPal evidence we hold; the capture stage re-reads it)
const authResource = { id: ev3.authorization.id, status: ev3.authorization.status, amount: { currency_code: ev3.authorization.currency, value: ev3.authorization.amount }, expiration_time: ev3.authorization.expiresAt };
const v = validateAuthorization(authResource as never, { authId: deal.paypalAuthId, fallbackExpiry: deal.authExpiresAt }, now, config.authExpiryMarginMs);
add("the stored authorization id equals the Stage 3 provider-read id and the deal records it as CREATED", deal.paypalAuthId === ev3.authorization.id && deal.paypalAuthStatus === "CREATED", `${deal.paypalAuthId} / ${deal.paypalAuthStatus}`);
add(`the authorization has NOT expired (expires ${ev3.authorization.expiresAt}; the engine requires ${Math.round(config.authExpiryMarginMs / 60000)} minutes of margin)`, v.ok, v.ok ? `valid for ${Math.round((Date.parse(ev3.authorization.expiresAt) - now.getTime()) / 86400000)} more days` : v.reason);
add("the authorization amount equals the locked price (20.00 USD)", v.ok && v.amount.eq(new D(deal.price!.toString())), v.ok ? fmt(v.amount) : v.reason);

let decision: ReturnType<typeof decideSettlement> | undefined;
if (authz.ok && ver.success) {
  const results: CriterionResult[] = ver.data.results;
  decision = decideSettlement({
    price: new D(deal.price!.toString()),
    authorizedAmount: v.ok ? v.amount : new D(0),
    criteria: authz.auth.terms.terms.criteria,
    results,
    flags: ver.data.flags,
    injectionPolicy: authz.auth.mandate.doc.injectionPolicy,
    authorizationOk: v.ok,
    partialAllowed: authz.auth.mandate.doc.allowPartialSettlement === true && config.partialCaptureVerified,
  });
}
add("the DETERMINISTIC settlement decision permits capture: FULL_CAPTURE of exactly 20.00", decision?.decision === "FULL_CAPTURE" && decision.amount.toFixed(2) === "20.00", decision ? `${decision.decision} ${decision.amount.toFixed(2)} earned ${decision.earned} reasons ${decision.reasons.join(",") || "-"}` : "not computed");
add("the buyer's challenge window has ended (so the engine will not wait); no acceptance is required by the engine", !!deal.challengeWindowEndsAt && deal.challengeWindowEndsAt < now, `ended ${deal.challengeWindowEndsAt?.toISOString()}`);
add("no capture exists: no capture/void operation, no settlement record, nothing captured on the deal, none on the order at the Stage 3 read", !ops.some((o) => o.type === "CAPTURE" || o.type === "VOID") && !deal.settlement && deal.capturedAmount === null && ev3.verification.noCaptureExists === true, ops.map((o) => `${o.type}:${o.status}`).join(","));
add("the deal is in the state the capture stage starts from (VERIFYING)", deal.state === "VERIFYING", deal.state);

// idempotency and duplicate protection (database-level facts, read from the live schema)
const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('PayPalOperation','Settlement')`;
const has = (re: RegExp) => idx.some((i) => re.test(i.indexdef));
add("DB: request ids are unique (a second operation cannot reuse a PayPal-Request-Id)", has(/UNIQUE.*"requestId"/), "unique index on PayPalOperation.requestId");
add("DB: one operation per (deal, type, seq)", has(/UNIQUE.*"dealId", type, seq|UNIQUE.*"dealId".*"type".*"seq"/i), "unique (dealId, type, seq)");
add("DB: at most ONE live CAPTURE/VOID per deal (partial unique index)", idx.some((i) => /WHERE/i.test(i.indexdef) && /CAPTURE|VOID/i.test(i.indexdef)), idx.filter((i) => /WHERE/i.test(i.indexdef)).map((i) => i.indexname).join(","));
add("DB: at most ONE settlement record per deal (unique dealId)", has(/UNIQUE.*"Settlement"|UNIQUE.*"dealId"/) && idx.some((i) => /Settlement/.test(i.indexname) && /UNIQUE/i.test(i.indexdef)), idx.filter((i) => /Settlement/.test(i.indexname)).map((i) => i.indexname).join(","));

const requestId = `${deal.id}-CAPTURE-1`;
const body = decision ? captureBody({ amount: fmt(decision.amount), finalCapture: true, invoiceId: `${deal.id}-settle-1` }) : null;
const plan = [
  { n: 1, method: "POST", path: "/v1/oauth2/token", effect: "SDK token request; no state change" },
  { n: 2, method: "GET", path: `/v2/payments/authorizations/${deal.paypalAuthId}`, effect: "settlement-decision read: the engine decides only if CREATED, 20.00 USD, unexpired (else NEEDS_HUMAN / no capture)" },
  { n: 3, method: "GET", path: `/v2/payments/authorizations/${deal.paypalAuthId}`, effect: "fresh pre-capture check (the engine's pre-send guard); a capture exceeding the authorization or the price is refused before sending" },
  { n: 4, method: "POST", path: `/v2/payments/authorizations/${deal.paypalAuthId}/capture`, effect: "THE WRITE: capture 20.00 USD, final_capture true", headers: { "PayPal-Request-Id": requestId, Prefer: "return=representation" }, body },
  { n: 5, method: "GET", path: "/v2/payments/captures/{captureId}", effect: "capture read-back: must be COMPLETED (a PENDING or DECLINED capture is not success)" },
  { n: 6, method: "GET", path: `/v2/payments/authorizations/${deal.paypalAuthId}`, effect: "authorization reconciliation: status moves to CAPTURED; the deal then becomes CAPTURED" },
];

console.log("CAPTURE PREFLIGHT (offline, read-only; 0 requests sent, guard refused " + guard.blocked().length + ")");
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.id}${c.detail ? `  [${c.detail}]` : ""}`);
console.log("\nPROPOSED CAPTURE REQUEST PLAN (not sent):");
for (const p of plan) console.log(`  ${p.n}. ${p.method} ${p.path}   ${p.effect}`);
console.log(`  idempotency: PayPal-Request-Id ${requestId}; invoice_id ${deal.id}-settle-1 (both derived from the deal id and a sequence number: stable across retries of the same operation)`);

mkdirSync(join(process.cwd(), "docs", "qa", "final-playwright-e2e"), { recursive: true });
writeFileSync(join(process.cwd(), "docs", "qa", "final-playwright-e2e", "capture-preflight.json"), JSON.stringify({ ranAt: now.toISOString(), requestsSent: 0, outboundGuardRefused: guard.blocked().length, deal: { id: deal.id, state: deal.state, order: deal.paypalOrderId, authorization: deal.paypalAuthId, lockedPrice: deal.price?.toString() }, checks, decision: decision ? { decision: decision.decision, amount: decision.amount.toFixed(2), earned: decision.earned, reasons: decision.reasons } : null, plan, indexes: idx.map((i) => i.indexname), notProvable: ["what PayPal reports right now (requests 2 and 3 re-verify it before any capture)", "that PayPal will accept the capture (request 5 confirms COMPLETED)"] }, null, 2) + "\n");
await prisma.$disconnect();
process.exit(checks.every((c) => c.ok) ? 0 : 1);
