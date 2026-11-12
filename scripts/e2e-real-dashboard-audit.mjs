/**
 * READ-ONLY browser audit of the REAL dashboard (http://localhost:3000, the running Sandbox-mode app on mandate_e2e) at a desktop, a tablet and a mobile viewport.
 *
 *   node scripts/e2e-real-dashboard-audit.mjs --out docs/qa/final-playwright-e2e/real
 *
 * SAFETY: this script never clicks Accept, "Check settlement now", "Request review", "Submit decision", checkout, order or delivery controls. In addition, EVERY browser request that is not a
 * GET (except sign-in and sign-out) is aborted by a network route before it leaves the browser and is recorded; the run fails if any such attempt exists. The only buttons it presses are
 * sign-in, sign-out, Refresh, the deal-list selector and the "Show all" activity toggle (a pure UI expand). Empty and failure states are shown with clearly labelled STUBBED GET responses.
 * No PayPal request is possible: the app itself refuses every non-loopback request.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const OUT = arg("out", "docs/qa/final-playwright-e2e/real");
const BASE = "http://localhost:3000";
const CHROME = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).replace(/^\uFEFF/, "").trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }),
);
const DEAL = "cmw9owm800004vfoshymk7yir";
const report = { ranAt: new Date().toISOString(), target: BASE, readOnly: true, viewports: {}, checks: [], blockedMutationAttempts: [], screenshots: [], notes: [] };
const check = (id, ok, detail = "") => {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail && !ok ? "  " + detail : ""}`);
};
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const VPS = [
  { name: "desktop", size: { width: 1366, height: 900 }, mobile: false },
  { name: "tablet", size: { width: 768, height: 1024 }, mobile: true },
  { name: "mobile", size: { width: 390, height: 844 }, mobile: true },
];
let n = 0;

async function session(vp) {
  const ctx = await browser.newContext({ viewport: vp.size, isMobile: vp.mobile, hasTouch: vp.mobile, locale: "en-US" });
  const page = await ctx.newPage();
  const log = { console: [], pageErrors: [], failed: [], http: [] };
  // HARD SAFETY NET: no browser request that could change state is allowed out (sign-in and sign-out excepted)
  await ctx.route("**/*", (route) => {
    const r = route.request();
    const u = new URL(r.url());
    if (u.origin === BASE && u.pathname.startsWith("/api/") && r.method() !== "GET" && !/^\/api\/auth\/(login|logout)$/.test(u.pathname)) {
      report.blockedMutationAttempts.push(`${r.method()} ${u.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  page.on("console", (m) => m.type() === "error" && log.console.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => log.pageErrors.push(String(e).slice(0, 200)));
  page.on("requestfailed", (r) => log.failed.push(`${r.method()} ${r.url().replace(BASE, "")} ${r.failure()?.errorText}`));
  page.on("response", (r) => r.status() >= 400 && log.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`));
  return { ctx, page, log, vp };
}
const shot = async (s, name, full = true) => {
  const f = `${String(++n).padStart(2, "0")}-${s.vp.name}-${name}.png`;
  await s.page.screenshot({ path: join(OUT, f), fullPage: full });
  report.screenshots.push(f);
};
const text = (s) => s.page.evaluate(() => document.body.innerText);
async function layout(s, where) {
  const o = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth }));
  check(`${s.vp.name}/${where}: no horizontal page scroll`, o.sw <= s.vp.size.width + 1, `scrollWidth ${o.sw} > ${s.vp.size.width}`);
}
async function a11y(s, where) {
  const unlabeled = await s.page.evaluate(() => [...document.querySelectorAll("input, select, textarea")].filter((e) => e.type !== "hidden" && !(e.id && document.querySelector(`label[for="${e.id}"]`)) && !e.closest("label") && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby")).map((e) => e.outerHTML.slice(0, 80)));
  const unnamed = await s.page.evaluate(() => [...document.querySelectorAll("button, a[href]")].filter((e) => !(e.innerText || "").trim() && !e.getAttribute("aria-label")).length);
  const headings = await s.page.evaluate(() => [...document.querySelectorAll("h1,h2,h3")].length);
  const landmarks = await s.page.evaluate(() => ({ main: !!document.querySelector("main"), lang: document.documentElement.lang, title: document.title }));
  check(`${s.vp.name}/${where}: every form control has a label`, unlabeled.length === 0, unlabeled.join(" | "));
  check(`${s.vp.name}/${where}: every button and link has an accessible name`, unnamed === 0, `${unnamed} unnamed`);
  check(`${s.vp.name}/${where}: page has a title, a language and headings`, !!landmarks.title && !!landmarks.lang && headings > 0, JSON.stringify(landmarks));
  const tiny = await s.page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 28 || r.width < 28); }).length);
  if (tiny) report.notes.push(`${s.vp.name}/${where}: ${tiny} button(s) smaller than 28px`);
}

for (const vp of VPS) {
  // the app's login limiter allows 5 attempts per minute per client (by design); each viewport signs in 4 times, so the viewports are paced a minute apart
  if (vp !== VPS[0]) await new Promise((r) => setTimeout(r, 65000));
  const s = await session(vp);
  const V = (report.viewports[vp.name] = {});
  try {
    // --- login screen, wrong secret, sign in
    await s.page.goto(BASE, { waitUntil: "networkidle" });
    await s.page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor();
    await shot(s, "login");
    await layout(s, "login");
    await a11y(s, "login");
    await s.page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
    await s.page.getByLabel("Login secret").fill("definitely-wrong-secret");
    await s.page.getByRole("button", { name: "Sign in" }).click();
    await s.page.getByRole("alert").filter({ hasText: "Wrong email or password" }).waitFor();
    check(`${vp.name}: wrong credentials show an error and stay on the login screen`, await s.page.getByRole("heading", { name: "Sign in as the buyer" }).isVisible());
    await s.page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
    await s.page.getByRole("button", { name: "Sign in" }).click();
    await s.page.getByText("Buyer mandate").first().waitFor();
    // --- the live deal
    if (!(await s.page.getByText("Negotiation transcript").isVisible().catch(() => false))) await s.page.getByText(/\$20\.00/).first().click();
    await s.page.getByText("Negotiation transcript").waitFor({ timeout: 20000 });
    await s.page.waitForTimeout(1500);
    await shot(s, "real-deal-verified-authorized");
    const t = await text(s);
    V.chips = { sandbox: /Sandbox \(writes LOCKED/.test(t), rulebased: /Rule-based \(no AI\)/.test(t), v2: /Disabled/.test(t) };
    check(`${vp.name}/payment-state: PayPal chip says Sandbox with writes LOCKED (never mock, never 'authorized writes')`, V.chips.sandbox && !/MOCK \(in memory\)/.test(t) && !/Sandbox \(writes authorized/.test(t));
    check(`${vp.name}/payment-state: lifecycle says authorized = a hold, capture NOT permitted yet`, /Authorized; delivery is being verified\. Capture is not permitted yet/.test(t));
    check(`${vp.name}/payment-state: order and authorization shown, Authorization CREATED, nothing captured`, /4YJ97804H20584006/.test(t) && /Authorization\s*\n?\s*CREATED/.test(t.replace(/\n+/g, "\n")) && /Captured\s*\n?\s*-/.test(t.replace(/\n+/g, "\n")));
    check(`${vp.name}/payment-state: no payment success is displayed for this deal ('Paid', 'Captured (PayPal Sandbox)')`, !/Paid \(captured\)/.test(t) && !/Captured \(PayPal Sandbox\)/.test(t));
    check(`${vp.name}/payment-state: operations table lists exactly CREATE_ORDER and AUTHORIZE`, /CREATE_ORDER\s+CONFIRMED/.test(t) && /AUTHORIZE\s+CONFIRMED/.test(t) && !/\bCAPTURE\s+(CONFIRMED|SENT|PLANNED)/.test(t) && !/\bVOID\s+(CONFIRMED|SENT|PLANNED)/.test(t));
    check(`${vp.name}/delivery evidence: CSV preview, three PASS checks, 'no model' statement`, /cleaned\.csv/.test(t) && (t.match(/PASS/g) ?? []).length >= 3 && /AI assessment in this verification: none/.test(t));
    check(`${vp.name}/buyer decision: acceptance is pending (Accept offered, not taken)`, /You can accept now, or wait for the challenge window to end/.test(t) && (await s.page.getByRole("button", { name: "Accept delivery" }).isVisible()));
    check(`${vp.name}/negotiation: transcript present, rule-based buyer, local simulator, 'no AI model was called'`, /Round 1 · Buyer Agent · rule-based \(no AI\)/.test(t) && /Seller · local simulator/.test(t) && /No AI model was called for this deal/.test(t));
    check(`${vp.name}/truth: nothing claims Live AI; V2 shown Disabled; the footer says Sandbox only`, !/Live AI/.test(t) && V.chips.v2 && /Sandbox only/.test(t));
    await layout(s, "real-deal");
    await a11y(s, "real-deal");
    // --- navigation and UI-only interactions (no state change)
    const showAll = s.page.getByRole("button", { name: /Show all/ });
    if (await showAll.count()) {
      await showAll.click();
      await s.page.waitForTimeout(500);
      await shot(s, "activity-expanded");
      check(`${vp.name}/navigation: the audit history expands (UI only)`, /PAYPAL_WRITE/.test(await text(s)));
    }
    await s.page.getByRole("button", { name: "Refresh" }).click();
    await s.page.waitForTimeout(1200);
    check(`${vp.name}/navigation: Refresh reloads the deal (GET only) and keeps it selected`, /Negotiation transcript/.test(await text(s)));
    // keyboard: focusable controls and a visible focus order start
    await s.page.keyboard.press("Tab");
    const focused = await s.page.evaluate(() => document.activeElement?.tagName);
    check(`${vp.name}/accessibility: keyboard Tab reaches a focusable control`, ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(focused), String(focused));
    // forms (labels only; nothing is submitted)
    await s.page.getByRole("button", { name: "New mandate" }).click();
    for (const l of ["Total budget (USD)", "Max per deal (USD)", "Ask me above (USD)", "Valid for (days)"]) check(`${vp.name}/forms: mandate field "${l}" is labelled`, (await s.page.getByLabel(l).count()) === 1);
    await shot(s, "mandate-form-open-not-submitted", false);
    await s.page.getByRole("button", { name: "New mandate" }).click().catch(() => {});
    for (const l of ["Task", "Target price (USD)"]) check(`${vp.name}/forms: deal field "${l}" is labelled`, (await s.page.getByLabel(l).count()) >= 1);
    // --- STUBBED empty and failure states (GET responses replaced in the browser only; the real data is untouched)
    const stub = await ctx2(vp);
    await stub.page.route("**/api/deals", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { deals: [] } }) : r.abort()));
    await stub.page.route("**/api/mandates", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { mandates: [] } }) : r.abort()));
    await stub.page.goto(BASE, { waitUntil: "networkidle" });
    await stub.page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
    await stub.page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
    await stub.page.getByRole("button", { name: "Sign in" }).click();
    await stub.page.getByText("Buyer mandate").first().waitFor();
    const et = await text(stub);
    check(`${vp.name}/empty state (STUBBED responses): 'No mandate yet' and 'No deals yet' are shown`, /No mandate yet/.test(et) && /No deals yet/.test(et));
    await shot(stub, "STUBBED-empty-state");
    await stub.ctx.close();
    const fail = await ctx2(vp);
    await fail.page.route(`**/api/deals/${DEAL}`, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 500, json: { error: "INTERNAL" } }) : r.abort()));
    await fail.page.goto(BASE, { waitUntil: "networkidle" });
    await fail.page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
    await fail.page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
    await fail.page.getByRole("button", { name: "Sign in" }).click();
    await fail.page.getByText("Buyer mandate").first().waitFor();
    await fail.page.getByText(/\$20\.00/).first().click().catch(() => {});
    await fail.page.waitForTimeout(2500);
    const ft = await text(fail);
    check(`${vp.name}/failure state (STUBBED 500): a deal-load failure is shown as an error, not as a success or a payment`, /(INTERNAL|could not|failed|error|Not found)/i.test(ft) && !/Paid \(captured\)/.test(ft));
    await shot(fail, "STUBBED-failure-state");
    await fail.ctx.close();
    // --- sign out (the only other allowed mutation)
    await s.page.getByRole("button", { name: "Sign out" }).click();
    await s.page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor({ timeout: 10000 });
    check(`${vp.name}: sign out returns to the login screen`, true);
  } catch (e) {
    check(`${vp.name}: audit step failed`, false, String(e).split("\n")[0].slice(0, 220));
    await shot(s, "ERR").catch(() => {});
  }
  V.browser = s.log;
  await s.ctx.close();
}
async function ctx2(vp) {
  return session(vp);
}

const noisy = [];
for (const [k, v] of Object.entries(report.viewports)) {
  const b = v.browser ?? {};
  const http = (b.http ?? []).filter((x) => !/^401 GET \/api\/auth\/session/.test(x) && !/^401 POST \/api\/auth\/login/.test(x) && !/^500 GET \/api\/deals\/cmw9/.test(x));
  const failedReq = (b.failed ?? []).filter((x) => !/net::ERR_FAILED/.test(x));
  const consoleErr = (b.console ?? []).filter((x) => !/Failed to load resource/.test(x));
  if (http.length || failedReq.length || consoleErr.length || (b.pageErrors ?? []).length) noisy.push({ viewport: k, http, failedReq, consoleErr, pageErrors: b.pageErrors });
}
report.browserNoise = noisy;
check("browser: no unexpected console errors, page errors, failed requests or HTTP errors on any viewport (sign-in 401 probes and the STUBBED 500 excluded)", noisy.length === 0, JSON.stringify(noisy).slice(0, 300));
check("SAFETY: the audit attempted NO state-changing request (every non-GET except sign-in/out would have been aborted and listed here)", report.blockedMutationAttempts.length === 0, report.blockedMutationAttempts.join(", "));
await browser.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
const failed = report.checks.filter((c) => !c.ok);
console.log(`\nREAL DASHBOARD AUDIT (read-only): ${report.checks.length - failed.length} passed, ${failed.length} failed, ${report.screenshots.length} screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
