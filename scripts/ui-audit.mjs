/**
 * Browser UI audit (real Chrome through playwright-core; no browser download).
 *   node scripts/ui-audit.mjs --out docs/qa/ui-audit/<name> [--chrome <path>] [--base http://localhost:3000]
 *
 * Runs the buyer journey in a real browser against an already running app + seller simulator (mock PayPal, rule-based buyer, a throwaway database), at a desktop and a
 * mobile viewport; saves screenshots; records console errors, page errors, failed requests and HTTP errors; checks overflow, form labels, and that no mock payment or
 * rule-based answer is presented as real. Credentials are read from .env.local and never printed. No PayPal or model call is made by this script (the app is in mock mode
 * and has no model configured). Two states that cannot occur without a live provider (a failed/successful Gemini call) are checked with STUBBED API responses and labelled so.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "docs/qa/ui-audit/run");
const base = arg("base", "http://localhost:3000");
const chromePath = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
mkdirSync(out, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).replace(/^\uFEFF/, "").trim(), l.slice(i + 1).trim()];
  }),
);

/** empty the THROWAWAY audit database (its name must be mandate_qa_ui_<digits>) so every viewport starts from a clean state */
function resetAuditDb() {
  const name = arg("db", readFileSync("attack-lab/ui-audit-db.txt", "utf8").trim());
  if (!/^mandate_qa_ui_\d+$/.test(name)) throw new Error("refusing to reset a database that is not a disposable audit database");
  const u = new URL(env.DATABASE_URL);
  execFileSync("docker", ["exec", "-e", "PGPASSWORD", "mandate-pg", "psql", "-U", decodeURIComponent(u.username), "-d", name, "-c", 'TRUNCATE TABLE "User" CASCADE'], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, stdio: "ignore" });
}

const report = { ranAt: new Date().toISOString(), base, browser: null, viewports: {}, findings: [], checks: [] };
const check = (id, ok, detail = "") => {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail && !ok ? "  " + detail : ""}`);
};
const finding = (severity, where, text) => {
  report.findings.push({ severity, where, text });
  console.log(`FINDING [${severity}] ${where}: ${text}`);
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
report.browser = browser.version();

async function newPage(vp, tag) {
  const ctx = await browser.newContext({ viewport: vp.size, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 1, locale: "en-US" });
  const page = await ctx.newPage();
  const log = { console: [], pageErrors: [], failed: [], http: [] };
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) log.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => log.pageErrors.push(String(e).slice(0, 300)));
  page.on("requestfailed", (r) => log.failed.push(`${r.method()} ${r.url().replace(base, "")} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) log.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`); });
  return { ctx, page, log, tag };
}
const shot = async (page, vp, name, full = true) => page.screenshot({ path: join(out, `${vp.name}-${name}.png`), fullPage: full });
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function layoutChecks(page, vp, where) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`${vp.name}/${where}: no horizontal page scroll`, o.sw <= vp.size.width + 1, `scrollWidth ${o.sw} > viewport ${vp.size.width}`);
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll("input, select, textarea")].filter((el) => {
      if (el.type === "hidden") return false;
      const id = el.id;
      const labelled = (id && document.querySelector(`label[for="${id}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      return !labelled;
    }).map((el) => el.outerHTML.slice(0, 90)),
  );
  check(`${vp.name}/${where}: every form control has a label`, unlabeled.length === 0, unlabeled.join(" | "));
  const noName = await page.evaluate(() => [...document.querySelectorAll("button, a[href]")].filter((el) => !(el.innerText || "").trim() && !el.getAttribute("aria-label")).length);
  check(`${vp.name}/${where}: every button and link has a name`, noName === 0, `${noName} unnamed`);
  const tiny = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 28 || r.width < 28); }).length);
  if (tiny) finding("low", `${vp.name}/${where}`, `${tiny} button(s) smaller than 28px`);
}

async function journey(vp) {
  resetAuditDb();
  const { ctx, page, log } = await newPage(vp);
  let lastStep = "start";
  const step = (s) => {
    lastStep = s;
    console.log(`--- ${vp.name}: ${s}`);
  };
  try {
    await journeyBody(vp, page, step, log);
  } catch (e) {
    await shot(page, vp, `ERR-${lastStep.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}`).catch(() => {});
    throw e;
  } finally {
    report.viewports[vp.name] = { console: log.console, pageErrors: log.pageErrors, failedRequests: log.failed, httpErrors: log.http };
    await ctx.close();
  }
}

async function journeyBody(vp, page, step, log) {

  step("login screen");
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor();
  await shot(page, vp, "01-login");
  await layoutChecks(page, vp, "login");

  step("wrong password shows an error");
  await page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
  await page.getByLabel("Login secret").fill("definitely-wrong-secret");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").filter({ hasText: "Wrong email or password" }).waitFor();
  await shot(page, vp, "02-login-error", false);
  check(`${vp.name}: wrong credentials show an error and stay on the login screen`, await page.getByRole("heading", { name: "Sign in as the buyer" }).isVisible());

  step("sign in -> empty dashboard");
  await page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Buyer mandate").first().waitFor();
  await page.getByText("No mandate yet").waitFor();
  await shot(page, vp, "03-dashboard-empty");
  let t = await bodyText(page);
  check(`${vp.name}: empty states are shown (no mandate, no deals, no deal selected)`, /No mandate yet/.test(t) && /No deals yet/.test(t) && /Create a mandate, then open a deal/.test(t));
  check(`${vp.name}: PayPal chip says MOCK`, /MOCK \(in memory\)/.test(t));
  check(`${vp.name}: Buyer Agent chip says Rule-based and nothing claims Live AI`, /Rule-based \(no AI\)/.test(t) && !/Live AI/.test(t));
  check(`${vp.name}: Seller chip says Local simulator`, /Local simulator/.test(t));
  check(`${vp.name}: V2 shown as Disabled`, /Disabled/.test(t));
  await layoutChecks(page, vp, "dashboard-empty");

  step("mandate creation");
  await page.getByRole("button", { name: "New mandate" }).click();
  await shot(page, vp, "04-mandate-form");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByText("Digest to confirm:").waitFor();
  await shot(page, vp, "05-mandate-preview");
  await page.getByRole("button", { name: "Confirm and sign" }).click();
  await page.getByText("Seal verified").first().waitFor();
  await shot(page, vp, "06-mandate-created");
  t = await bodyText(page);
  check(`${vp.name}: mandate appears with a verified seal`, /Seal verified/.test(t) && /\$100\.00 budget/.test(t));

  async function openDeal() {
    await page.getByRole("button", { name: /Open deal/ }).click();
    await page.getByText("Negotiation transcript").waitFor();
    await page.getByText("Waiting for buyer PayPal approval").first().waitFor();
  }

  step("deal 1: negotiation + PayPal (mock)");
  await openDeal();
  await shot(page, vp, "07-negotiation-paypal-pending");
  t = await bodyText(page);
  check(`${vp.name}: transcript shows rule-based buyer and local-simulator seller`, /Buyer Agent · rule-based \(no AI\)/.test(t) && /Seller · local simulator/.test(t));
  check(`${vp.name}: "no AI model was called" note is shown`, /No AI model was called for this deal/.test(t));
  check(`${vp.name}: PayPal card is labelled MOCK and shows no capture`, /MOCK PayPal \(in-memory simulation/.test(t) && /Captured\s*\n?\s*-/.test(t.replace(/\n+/g, "\n")));
  check(`${vp.name}: no "Paid" success is shown before any capture`, !/Paid \(captured\)/.test(t));
  await layoutChecks(page, vp, "negotiation");

  await page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
  await page.getByText("Authorized, waiting for delivery").first().waitFor();
  await shot(page, vp, "08-authorized-awaiting-delivery");

  step("deal 1: hidden-instruction delivery -> needs human");
  await page.getByRole("button", { name: "Delivery with a hidden instruction" }).click();
  await page.getByText("Needs your decision").first().waitFor();
  await shot(page, vp, "09-flagged-delivery-needs-human");
  t = await bodyText(page);
  check(`${vp.name}: flagged delivery shows scanner flags and asks for a human decision`, /Flags raised by the scanner/.test(t) && /needs a human decision/i.test(t));
  check(`${vp.name}: flagged delivery shows no capture and no "Paid"`, !/Paid \(captured\)/.test(t) && !/Settlement decision: full capture/.test(t));
  check(`${vp.name}: no reject button exists (policy: no unrestricted reject)`, (await page.getByRole("button", { name: /^reject$/i }).count()) === 0);
  await layoutChecks(page, vp, "flagged");

  step("deal 2: duplicates delivery -> required check fails");
  await page.getByRole("button", { name: /Open deal/ }).click();
  await page.getByText("Waiting for buyer PayPal approval").first().waitFor();
  await page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
  await page.getByText("Authorized, waiting for delivery").first().waitFor();
  await page.getByRole("button", { name: "Delivery with duplicate rows" }).click();
  await page.getByText(/required failed/i).first().waitFor();
  await shot(page, vp, "10-duplicates-failed");
  t = await bodyText(page);
  check(`${vp.name}: duplicate-row delivery shows a failed verification and is not paid`, /required failed/i.test(t) && !/Paid \(captured\)/.test(t));

  step("deal 3: clean delivery -> verification -> accept -> capture (mock)");
  await page.getByRole("button", { name: /Open deal/ }).click();
  await page.getByText("Waiting for buyer PayPal approval").first().waitFor();
  await page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
  await page.getByText("Authorized, waiting for delivery").first().waitFor();
  await page.getByRole("button", { name: "Clean delivery" }).click();
  await page.getByText("Verified, challenge window").first().waitFor();
  await shot(page, vp, "11-clean-verified-decision");
  t = await bodyText(page);
  check(`${vp.name}: clean delivery verified, still not paid while the challenge window is open`, /all required passed/i.test(t) && !/Paid \(captured\)/.test(t));
  await layoutChecks(page, vp, "decision");
  await page.getByRole("button", { name: "Accept delivery" }).click();
  await page.getByText("Paid (captured)").first().waitFor();
  await shot(page, vp, "12-settled-captured");
  t = await bodyText(page);
  check(`${vp.name}: settlement shows full capture, and the PayPal card still says MOCK`, /Settlement decision: full capture/.test(t) && /MOCK PayPal/.test(t));
  // the ledger now reads in plain language; the original event names stay available behind "Show technical details" (traceability kept)
  check(`${vp.name}: audit history is listed in plain language`, /Activity & audit history/.test(t) && /Payment capture completed/.test(t) && !/STATE_TRANSITION/.test(t));
  await page.getByRole("button", { name: "Show technical details" }).click();
  check(`${vp.name}: technical details reveal the original event names`, /STATE_TRANSITION/.test(await bodyText(page)));
  await layoutChecks(page, vp, "settled");

  step("deals list + navigation back to deal 1");
  await page.getByRole("button", { name: /Needs your decision/ }).first().click();
  await page.getByText("Needs your decision").first().waitFor();
  await page.getByText("Flags raised by the scanner").first().waitFor();
  check(`${vp.name}: selecting another deal switches the detail view`, /Flags raised by the scanner/.test(await bodyText(page)));

  step("sign out");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor();
  check(`${vp.name}: sign out returns to the login screen`, true);

}

// ---- stubbed-state checks (no provider exists to produce these): API responses are replaced and the results are labelled STUBBED ------------------------------------
async function stubbed(vp) {
  const { ctx, page, log } = await newPage(vp);
  const sess = { email: env.PRINCIPAL_EMAIL, csrfToken: "x" };
  const status = { principal: env.PRINCIPAL_EMAIL, paypal: "mock", sandboxWritesAuthorized: false, buyerBrain: "llm", llmVendor: "gemini", llmModel: "gemini-3.5-flash-lite", llmConfig: "configured", llmConfigNote: null, sellerConfigured: true, challengeWindowSeconds: 15, v2: "disabled" };
  const mandate = { id: "m1", currency: "USD", budgetTotal: "100", perDealMax: "60", requireHumanAbove: "50", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00Z", approvedBy: "x", approvedAt: "2026-01-01T00:00:00Z", digest: "a".repeat(64), keyVersion: "v1", sealVerified: true };
  const deal = { id: "d1", mandateId: "m1", state: "BLOCKED", sellerId: "seller-sim", price: null, termsHash: null, terms: null, paypalOrderId: null, paypalAuthStatus: null, approvalUrl: null, capturedAmount: null, deadline: null, needsHumanReason: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const detail = (extra) => ({ deal, events: [], negotiation: [], modelRuns: [], delivery: null, verification: null, settlement: null, paypalOperations: [], ...extra });
  let mode = "failed";
  await page.route("**/api/auth/session", (r) => r.fulfill({ json: sess }));
  await page.route("**/api/status", (r) => r.fulfill({ json: status }));
  await page.route("**/api/mandates", (r) => r.fulfill({ json: { mandates: [mandate] } }));
  await page.route("**/api/deals", (r) => r.fulfill({ json: { deals: [deal] } }));
  await page.route("**/api/deals/d1", (r) =>
    r.fulfill({
      json: detail(
        mode === "failed"
          ? { modelRuns: [{ role: "buyer", model: "gemini-3.5-flash-lite", latencyMs: 812, promptHash: "b".repeat(64), output: { failed: true, error: "LLM_ERROR", detail: "GEMINI_HTTP_429 (rate limit or quota)" } }], events: [{ seq: 5, type: "BUYER_OUTPUT_REJECTED", actor: "buyer-agent", payload: { round: 1, error: "LLM_ERROR:GEMINI_HTTP_429 (rate limit or quota)" }, createdAt: "2026-01-01T00:00:00Z" }] }
          : { deal: { ...deal, state: "AWAITING_BUYER_APPROVAL", price: "20.00" }, negotiation: [{ round: 1, sender: "buyer", kind: "propose", payload: { price: "20.00", message: "Opening offer." }, createdAt: "2026-01-01T00:00:00Z" }, { round: 1, sender: "seller", kind: "accept", payload: {}, createdAt: "2026-01-01T00:00:01Z" }], modelRuns: [{ role: "buyer", model: "gemini-3.5-flash-lite", latencyMs: 640, promptHash: "c".repeat(64), output: { kind: "propose", price: "20.00" } }] },
      ),
    }),
  );
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByText("Negotiation transcript").waitFor({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Blocked/ }).first().click().catch(() => {});
  await page.getByText("Negotiation transcript").waitFor();
  await shot(page, vp, "13-STUBBED-gemini-failure");
  let t = await bodyText(page);
  check(`${vp.name} [STUBBED API]: configured Gemini shows "Live AI · gemini · model" in the chip`, /Live AI · gemini · gemini-3\.5-flash-lite/.test(t));
  check(`${vp.name} [STUBBED API]: a Gemini failure is shown as a failure with its reason and "no fallback"`, /The AI provider failed – no fallback was used/.test(t) && /GEMINI_HTTP_429/.test(t) && /1 failed/.test(t));
  check(`${vp.name} [STUBBED API]: a failed call never labels the buyer as AI or rule-based success`, !/Buyer Agent · gemini/.test(t));
  mode = "ok";
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByText(/Buyer Agent · gemini · gemini-3\.5-flash-lite/).first().waitFor();
  await shot(page, vp, "14-STUBBED-gemini-success");
  t = await bodyText(page);
  check(`${vp.name} [STUBBED API]: a recorded successful call labels that deal's buyer messages with the provider and model`, /Buyer Agent · gemini · gemini-3\.5-flash-lite/.test(t) && /1 succeeded, 0 failed/.test(t));
  report.viewports[`${vp.name}-stubbed`] = { console: log.console, pageErrors: log.pageErrors, failedRequests: log.failed, httpErrors: log.http };
  await ctx.close();

  // incomplete configuration
  const c2 = await newPage(vp);
  await c2.page.route("**/api/auth/session", (r) => r.fulfill({ json: sess }));
  await c2.page.route("**/api/status", (r) => r.fulfill({ json: { ...status, buyerBrain: "rule-based", llmVendor: null, llmModel: null, llmConfig: "incomplete", llmConfigNote: "Model not used – missing: GEMINI_API_KEY" } }));
  await c2.page.route("**/api/mandates", (r) => r.fulfill({ json: { mandates: [] } }));
  await c2.page.route("**/api/deals", (r) => r.fulfill({ json: { deals: [] } }));
  await c2.page.goto(base, { waitUntil: "networkidle" });
  await c2.page.getByText("Buyer mandate").first().waitFor();
  await shot(c2.page, vp, "15-STUBBED-gemini-incomplete-config", false);
  t = await bodyText(c2.page);
  check(`${vp.name} [STUBBED API]: incomplete Gemini configuration is shown as "Rule-based (AI NOT configured)", never as AI`, /Rule-based \(AI NOT configured\)/.test(t) && !/Live AI/.test(t));
  await c2.ctx.close();
}

const VIEWPORTS = [
  { name: "desktop", size: { width: 1366, height: 900 }, mobile: false },
  { name: "mobile", size: { width: 390, height: 844 }, mobile: true },
];
for (const vp of VIEWPORTS) {
  try {
    await journey(vp);
  } catch (e) {
    check(`${vp.name}: journey completed`, false, String(e).split("\n")[0].slice(0, 300));
    finding("high", vp.name, `journey aborted: ${String(e).split("\n")[0].slice(0, 200)}`);
  }
}
try {
  await stubbed(VIEWPORTS[0]);
} catch (e) {
  check("stubbed-state checks completed", false, String(e).split("\n")[0].slice(0, 300));
}

for (const [k, v] of Object.entries(report.viewports)) {
  const real = [...v.console, ...v.pageErrors].filter((x) => !/Failed to load resource: the server responded with a status of 401/.test(x));
  check(`${k}: no browser console errors or page errors`, real.length === 0, real.slice(0, 4).join(" | "));
  check(`${k}: no failed network requests`, v.failedRequests.length === 0, v.failedRequests.slice(0, 4).join(" | "));
  const unexpected = v.httpErrors.filter((x) => !/^401 GET \/api\/auth\/session/.test(x) && !/^401 POST \/api\/auth\/login/.test(x));
  check(`${k}: no unexpected HTTP error responses`, unexpected.length === 0, unexpected.slice(0, 6).join(" | "));
}
report.summary = { passed: report.checks.filter((c) => c.ok).length, failed: report.checks.filter((c) => !c.ok).length, findings: report.findings.length };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\nUI audit: ${report.summary.passed} checks passed, ${report.summary.failed} failed, ${report.summary.findings} findings. Screenshots and report.json in ${out}`);
await browser.close();
process.exitCode = report.summary.failed ? 1 : 0;
