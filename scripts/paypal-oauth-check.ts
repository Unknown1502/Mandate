/**
 * PayPal Sandbox OAuth-ONLY connectivity check. It sends ONE request (client-credentials token) and nothing else.
 *
 *   npx tsx scripts/paypal-oauth-check.ts [--env-file <path>] [--approve-oauth-request]
 *
 * It does NOT create an order, authorize, capture, void, refund or read any order. It never prints, stores or returns the access token or either credential. It does not read or
 * change PAYPAL_SANDBOX_WRITES, never touches the database, and has no connection to the four original spike orders. The deal/payment engine is not imported.
 *
 *  - Not configured (missing/placeholder credentials, PAYPAL_ENV not sandbox, base URL not exactly the Sandbox host): exit 3, no request.
 *  - Configured but --approve-oauth-request absent: prints the plan and exits 4, no request.
 *  - With --approve-oauth-request: exactly one request (no retry, 15 s timeout), a printed summary (status, debug id, token type, lifetime, application id, scope count), and an
 *    evidence file docs/qa/paypal-oauth-check-<timestamp>.json that contains no token and no credential. Exit 0 if PayPal issued a token, 1 otherwise.
 * The owner approves each run individually; an earlier approval does not carry over.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePayPalEnv, SANDBOX_BASE_URL } from "../src/lib/env";
import { checkSandboxOAuth } from "../src/paypal/sdk-gateway";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);

const envFile = arg("env-file");
if (envFile) {
  if (/onedrive/i.test(envFile)) console.log("WARNING: the env file is inside OneDrive (cloud-synced). Keep credentials outside synced folders.");
  process.loadEnvFile(envFile);
}

let creds: { clientId: string; clientSecret: string };
try {
  const e = parsePayPalEnv(process.env); // throws unless PAYPAL_ENV=sandbox, the base URL is exactly the Sandbox host and both credentials are set and not placeholders
  creds = { clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET };
} catch (err) {
  console.log("PAYPAL OAUTH CHECK: NOT CONFIGURED. No request was made.");
  console.log(String((err as Error).message).split("\n").slice(0, 8).join("\n")); // variable names and reasons only; the parser never echoes values
  process.exit(3);
}

console.log("PAYPAL SANDBOX OAUTH-ONLY CHECK");
console.log(`  endpoint      POST ${SANDBOX_BASE_URL}/v1/oauth2/token (grant_type=client_credentials)`);
console.log("  requests      exactly ONE, no retry, 15 s timeout");
console.log("  will NOT      create an order, authorize, capture, void or refund anything, or read any order");
console.log("  secrecy       the access token and both credentials are never printed, stored or returned");
console.log("  writes lock   PAYPAL_SANDBOX_WRITES is not read or changed by this script");

if (!flag("approve-oauth-request")) {
  console.log("\nNOT APPROVED: no request was made. Re-run with --approve-oauth-request to send this single token request.");
  process.exit(4);
}

const startedAt = Date.now();
const summary = await checkSandboxOAuth(creds, undefined);
const latencyMs = Date.now() - startedAt;

console.log("\nREAL PayPal requests made: 1");
console.log(`  result        ${summary.ok ? "TOKEN ISSUED" : `FAILED (${summary.failure}${summary.oauthError ? `: ${summary.oauthError}` : ""})`}`);
console.log(`  http status   ${summary.httpStatus ?? "none (no response)"}`);
console.log(`  debug id      ${summary.debugId ?? "-"}`);
if (summary.ok) {
  console.log(`  token type    ${summary.tokenType ?? "?"}, valid for ${summary.expiresInSeconds ?? "?"} s`);
  console.log(`  application   ${summary.appId ?? "(not reported)"}   <- compare with the app shown in your Sandbox dashboard`);
  console.log(`  scopes        ${summary.scopes?.length ?? 0} granted`);
}
console.log(`  latency       ${latencyMs} ms`);

mkdirSync(join(process.cwd(), "docs", "qa"), { recursive: true });
const out = join("docs", "qa", `paypal-oauth-check-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
writeFileSync(join(process.cwd(), out), JSON.stringify({ ranAt: new Date(startedAt).toISOString(), kind: "oauth-only", environment: "sandbox", requests: 1, latencyMs, summary, note: "no token, no credential, no order; PAYPAL_SANDBOX_WRITES untouched" }, null, 2) + "\n");
console.log(`Evidence written to ${out} (no token, no credential).`);
process.exit(summary.ok ? 0 : 1);
