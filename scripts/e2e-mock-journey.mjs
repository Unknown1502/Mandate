/**
 * Full browser journey in MOCK payment mode against a DISPOSABLE database (real Chrome through playwright-core). It starts its OWN processes (seller simulators and MANDATE app
 * instances on ports 3100 / 411x), creates a throwaway database named mandate_qa_e2e_<digits>, drives the real dashboard, and drops the database at the end.
 *
 *   node scripts/e2e-mock-journey.mjs --out docs/qa/final-playwright-e2e/mock
 *
 * It NEVER touches the real Sandbox deal: it does not use port 3000, never connects to mandate_e2e, never sets PAYPAL_MODE=sandbox or PAYPAL_SANDBOX_WRITES, and makes no PayPal or model
 * request (the Buyer Agent is the rule-based brain; the seller is the local simulator; PAYPAL_MODE=mock is explicit). Credentials come from .env.local and are never printed.
 * Every scenario records what the UI TRUTHFULLY shows (mock vs sandbox, rule-based vs live AI) and screenshots each major transition.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const OUT = arg("out", "docs/qa/final-playwright-e2e/mock");
const CHROME = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
const APP_PORT = 3100;
const BASE = `http://localhost:${APP_PORT}`;
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).replace(/^\uFEFF/, "").trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }),
);
const dbu = new URL(env.DATABASE_URL);
const DB_USER = decodeURIComponent(dbu.username);
const DB_PW = decodeURIComponent(dbu.password);
const DB_NAME = `mandate_qa_e2e_${Date.now()}`;
if (!/^mandate_qa_e2e_\d+$/.test(DB_NAME)) throw new Error("bad disposable database name");
const psql = (db, sql) => execFileSync("docker", ["exec", "-e", "PGPASSWORD", "mandate-pg", "psql", "-U", DB_USER, "-d", db, "-At", "-c", sql], { env: { ...process.env, PGPASSWORD: DB_PW }, encoding: "utf8" }).trim();

const report = { ranAt: new Date().toISOString(), database: DB_NAME, mode: "PAYPAL_MODE=mock (explicit)", buyer: "rule-based brain (no model call)", scenarios: {}, checks: [], findings: [], screenshots: [] };
const check = (id, ok, detail = "") => {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail && !ok ? "  " + detail : ""}`);
};
const note = (text) => (report.findings.push(text), console.log(`NOTE  ${text}`));

// ---- processes --------------------------------------------------------------------------------------------------------------------------------------------------------
const children = [];
const minimalEnv = (extra) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, ...extra });
function start(cmd, args, extra, tag) {
  const c = spawn(cmd, args, { env: minimalEnv(extra), stdio: "ignore", windowsHide: true });
  children.push({ tag, pid: c.pid });
  return { tag, pid: c.pid };
}
const kill = (p) => {
  try {
    execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
async function waitFor(url, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const startSeller = (mode, floor, port) => start(process.execPath, ["node_modules/tsx/dist/cli.mjs", "seller-service/main.ts"], { SELLER_PORT: String(port), SELLER_MODE: mode, SELLER_FLOOR: floor }, `seller-${mode}`);
const startApp = (sellerUrl) =>
  start(process.execPath, ["--env-file=.env.local", "node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)], {
    DATABASE_URL: dbUrl(),
    APP_URL: BASE,
    PAYPAL_MODE: "mock", // explicit; PAYPAL_SANDBOX_WRITES is deliberately never passed
    SELLER_URL: sellerUrl,
    DEMO_CHALLENGE_WINDOW_SECONDS: "3600",
    NEXT_TELEMETRY_DISABLED: "1",
    LLM_PROVIDER: "",
    LLM_MODEL_AGENTS: "",
    GROQ_API_KEY: "",
    GEMINI_API_KEY: "",
  }, "app");
function dbUrl() {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
}

// ---- API helper (loopback only, to the disposable app) ---------------------------------------------------------------------------------------------------------------
let session = { cookie: "", csrf: "" };
async function apiLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: env.PRINCIPAL_EMAIL, secret: env.PRINCIPAL_LOGIN_SECRET }) });
  session = { cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "), csrf: (await r.json().catch(() => ({}))).csrfToken ?? "" };
}
const apiGet = async (p) => (await fetch(BASE + p, { headers: { cookie: session.cookie, origin: BASE } })).json();

// ---- browser helpers -------------------------------------------------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const DESKTOP = { name: "desktop", size: { width: 1366, height: 900 }, mobile: false };
const MOBILE = { name: "mobile", size: { width: 390, height: 844 }, mobile: true };
let shotN = 0;
async function newPage(vp) {
  const ctx = await browser.newContext({ viewport: vp.size, isMobile: vp.mobile, hasTouch: vp.mobile, locale: "en-US" });
  const page = await ctx.newPage();
  const log = { console: [], failed: [], http: [], pageErrors: [] };
  page.on("console", (m) => m.type() === "error" && log.console.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => log.pageErrors.push(String(e).slice(0, 200)));
  page.on("requestfailed", (r) => log.failed.push(`${r.method()} ${r.url().replace(BASE, "")} ${r.failure()?.errorText}`));
  page.on("response", (r) => r.status() >= 400 && log.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`));
  return { ctx, page, log, vp };
}
// Optional accessibility scan of every screenshotted state: `--axe <path to axe.min.js>` (axe-core is installed OUTSIDE the project; nothing is added to package.json).
const AXE_PATH = arg("axe", "");
const axeSrc = AXE_PATH ? readFileSync(AXE_PATH, "utf8") : "";
report.axe = [];
async function shot(s, name, full = true) {
  const file = `${String(++shotN).padStart(2, "0")}-${s.vp.name}-${name}.png`;
  await s.page.screenshot({ path: join(OUT, file), fullPage: full });
  report.screenshots.push(file);
  if (axeSrc) {
    try {
      await s.page.evaluate(axeSrc);
      const r = await s.page.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
      report.axe.push({ shot: file, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target.join(" ") })) });
    } catch (e) {
      report.axe.push({ shot: file, error: String(e).slice(0, 160) });
    }
  }
}
const text = (s) => s.page.evaluate(() => document.body.innerText);
async function login(s, secret = env.PRINCIPAL_LOGIN_SECRET) {
  await s.page.goto(BASE, { waitUntil: "networkidle" });
  await s.page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
  await s.page.getByLabel("Login secret").fill(secret);
  await s.page.getByRole("button", { name: "Sign in" }).click();
}
/** the UI must never present a mock payment as real, nor a rule-based answer as AI */
async function truth(s, where, { expectCaptured = false } = {}) {
  const t = await text(s);
  check(`truth/${where}: PayPal is labelled MOCK, never Sandbox/live`, /MOCK \(in memory\)/.test(t) && !/Sandbox \(writes/.test(t) && !/Captured \(PayPal Sandbox\)/.test(t));
  check(`truth/${where}: Buyer Agent is Rule-based, nothing claims Live AI`, /Rule-based \(no AI\)/.test(t) && !/Live AI/.test(t));
  if (expectCaptured) check(`truth/${where}: a capture is labelled MOCK (simulated)`, /Captured \(MOCK/.test(t));
  check(`truth/${where}: V2 shown as Disabled`, /Disabled/.test(t));
}
async function layout(s, where) {
  const o = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth }));
  check(`layout/${s.vp.name}/${where}: no horizontal page scroll`, o.sw <= s.vp.size.width + 1, `scrollWidth ${o.sw} > ${s.vp.size.width}`);
}
async function step(name, fn, s) {
  try {
    await fn();
    return true;
  } catch (e) {
    check(`STEP FAILED: ${name}`, false, String(e).split("\n")[0].slice(0, 220));
    if (s) await shot(s, `ERR-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30)}`).catch(() => {});
    return false;
  }
}
const W = (s, re, ms = 30000) => s.page.getByText(re).first().waitFor({ timeout: ms });
const dealsApi = async () => (await apiGet("/api/deals")).deals ?? [];
const detail = async (id) => apiGet(`/api/deals/${id}`);
const opsOf = (d) => (d.paypalOperations ?? []).map((o) => `${o.type}:${o.status}`).join(",");

async function openDeal(s, { expectOutcome }) {
  await s.page.getByRole("button", { name: /Open deal/ }).click();
  await W(s, expectOutcome, 40000);
  s.lastText = await text(s); // read the page immediately: the notice clears shortly afterwards
  await s.page.waitForTimeout(2500); // the deal detail (PayPal card, transcript) renders a moment after the notice
  s.settledText = await text(s);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function main() {
  psql("postgres", `CREATE DATABASE ${DB_NAME}`);
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl() }, stdio: "ignore" });
  note(`disposable database ${DB_NAME} created and migrated`);

  // =============================================== S1: honest seller - the whole payment journey in MOCK mode =============================================================
  let seller = startSeller("honest", "18.00", 4110);
  let app = startApp("http://127.0.0.1:4110");
  check("S1: seller simulator and mock-mode app are up", (await waitFor("http://127.0.0.1:4110/whoami")) && (await waitFor(`${BASE}/api/health`)));
  const S1 = {};
  report.scenarios.S1_honest = S1;
  let s = await newPage(DESKTOP);

  await step("login screen, wrong secret, login", async () => {
    await s.page.goto(BASE, { waitUntil: "networkidle" });
    await s.page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor();
    await shot(s, "login");
    await s.page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
    await s.page.getByLabel("Login secret").fill("definitely-wrong-secret");
    await s.page.getByRole("button", { name: "Sign in" }).click();
    await s.page.getByRole("alert").filter({ hasText: "Wrong email or password" }).waitFor();
    check("S1: wrong credentials show an error and stay on the login screen", await s.page.getByRole("heading", { name: "Sign in as the buyer" }).isVisible());
    await shot(s, "login-error", false);
    await s.page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
    await s.page.getByRole("button", { name: "Sign in" }).click();
    await s.page.getByText("Buyer mandate").first().waitFor();
    await W(s, /No mandate yet/);
    const t = await text(s);
    check("S1: empty states shown (no mandate, no deals)", /No mandate yet/.test(t) && /No deals yet/.test(t));
    await shot(s, "dashboard-empty");
    await truth(s, "empty-dashboard");
    await layout(s, "empty-dashboard");
  }, s);
  await apiLogin();

  await step("mandate form validation, then create a mandate", async () => {
    await s.page.getByRole("button", { name: "New mandate" }).click();
    await s.page.getByLabel("Total budget (USD)").fill("abc");
    await s.page.getByRole("button", { name: "Preview" }).click();
    const err = await s.page.getByRole("alert").first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    check("S1: an invalid budget is rejected with a visible error (no mandate is created)", err);
    await shot(s, "mandate-validation-error", false);
    await s.page.getByLabel("Total budget (USD)").fill("500");
    await s.page.getByLabel("Max per deal (USD)").fill("60");
    await s.page.getByLabel("Ask me above (USD)").fill("50");
    await s.page.getByRole("button", { name: "Preview" }).click();
    await s.page.getByText("Digest to confirm:").waitFor();
    await shot(s, "mandate-preview");
    await s.page.getByRole("button", { name: "Confirm and sign" }).click();
    await s.page.getByText("Seal verified").first().waitFor();
    await shot(s, "mandate-created");
    check("S1: the mandate is sealed and verified", /500\.00 budget/.test(await text(s)));
  }, s);

  await step("new-deal form validation", async () => {
    await s.page.getByLabel("Target price (USD)").fill("abc");
    await s.page.getByRole("button", { name: /Open deal/ }).click();
    await s.page.waitForTimeout(1500);
    const t = await text(s);
    check("S1: an invalid target price is refused and no deal is created", (await dealsApi()).length === 0 && /(invalid|BAD_REQUEST|price|amount)/i.test(t));
    await shot(s, "deal-validation-error", false);
    await s.page.getByLabel("Target price (USD)").fill("20.00");
  }, s);

  await step("deal 1: negotiation (honest seller), mock PayPal order, mock buyer checkout", async () => {
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    const t = await text(s);
    check("S1: negotiation locked the price inside the limits ($20.00, one round)", /terms locked at \$20\.00/.test(t));
    check("S1: transcript shows rule-based buyer and local simulator; 'no AI model was called'", /Rule-based \(no AI\)/.test(t) && /Seller · local simulator/.test(t) && /No AI model was called/.test(t));
    check("S1: PayPal order exists and nothing is authorized or captured yet", /Buyer approval required: the order exists but is NOT authorized and no funds are held \(MOCK/.test(t) && !/Paid \(captured\)/.test(t));
    await shot(s, "deal1-negotiated-order-pending");
    await truth(s, "deal1-order-pending");
    const b = s.page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ });
    await b.dblclick(); // duplicate-action protection: a double click must authorize once
    await W(s, /Authorized, waiting for delivery/);
    await shot(s, "deal1-mock-authorized");
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    check("S1: double-clicking the mock checkout produced exactly ONE authorization", opsOf(dv) === "CREATE_ORDER:CONFIRMED,AUTHORIZE:CONFIRMED", opsOf(dv));
    check("S1: the authorized state is described as a hold, not captured, not escrow (MOCK)", /Authorized: a hold on the buyer's funds at PayPal, not captured and not escrow\. Awaiting delivery \(MOCK/.test(await text(s)));
    S1.deal1 = d.id;
  }, s);

  await step("error and timeout handling on the delivery action", async () => {
    // network failure
    await s.page.route("**/api/deals/*/delivery", (r) => r.abort());
    await s.page.getByRole("button", { name: "Clean delivery" }).click();
    await W(s, /Could not reach the server/, 10000);
    check("S1: a network failure shows 'Could not reach the server' and changes nothing", (await detail(S1.deal1)).deal.state === "AWAITING_DELIVERY");
    await shot(s, "error-network-failure", false);
    await s.page.unroute("**/api/deals/*/delivery");
    // server error
    await s.page.route("**/api/deals/*/delivery", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "INTERNAL" }) }));
    await s.page.getByRole("button", { name: "Clean delivery" }).click();
    await W(s, /INTERNAL/, 10000);
    check("S1: a server error is shown as an error, not as success, and changes nothing", (await detail(S1.deal1)).deal.state === "AWAITING_DELIVERY");
    await shot(s, "error-server-500", false);
    await s.page.unroute("**/api/deals/*/delivery");
    // slow response: the buttons are disabled while the request is in flight (loading state)
    await s.page.route("**/api/deals/*/delivery", async (r) => { await new Promise((x) => setTimeout(x, 3000)); await r.abort(); });
    await s.page.getByRole("button", { name: "Clean delivery" }).click();
    await s.page.waitForTimeout(600);
    const disabled = await s.page.getByRole("button", { name: "Clean delivery" }).isDisabled();
    check("S1: while a request is in flight the action buttons are disabled (loading state, no double submit)", disabled);
    await shot(s, "loading-state-in-flight", false);
    await W(s, /Could not reach the server/, 10000);
    await s.page.unroute("**/api/deals/*/delivery");
  }, s);

  await step("deal 1: clean delivery, deterministic verification, buyer acceptance, mock capture", async () => {
    await s.page.getByRole("button", { name: "Clean delivery" }).click();
    await W(s, /Verified, challenge window/);
    await W(s, /all required passed/i);
    await shot(s, "deal1-clean-verified");
    let t = await text(s);
    check("S1: clean delivery passes all deterministic checks, no model is used", /PASS/.test(t) && /AI assessment in this verification: none/.test(t));
    check("S1: buyer acceptance is pending and nothing is captured yet", /You can accept now/.test(t) && !/Paid \(captured\)/.test(t) && /Authorized; delivery is being verified\. Capture is not permitted yet \(MOCK/.test(t));
    // score-improvement checks: the workflow strip, the challenge window, the "why protected" facts, the plain ledger and the keyboard path. All read-only.
    const stages = await s.page.$$eval("[data-testid=workflow] li[data-stage]", (els) => els.map((e) => `${e.getAttribute("data-stage")}=${e.getAttribute("data-status")}`).join(","));
    check("UX: workflow strip shows stages 1-4 done and settlement still IN PROGRESS (never done early)", stages === "authority=done,negotiation=done,agreement=done,delivery=done,settlement=current", stages);
    const win = await s.page.$("[data-testid=challenge-window]");
    const winText = win ? await win.innerText() : "";
    check("UX: challenge window is open, shows start, end with a zone name and time left, and does not promise an exact-second action", !!win && (await win.getAttribute("data-phase")) === "open" && /about .* left/.test(winText) && /Started:/.test(winText) && /Ends:/.test(winText) && /[A-Z]{3,5}|GMT/.test(winText) && /not at the exact second/.test(winText), winText.slice(0, 200));
    const prot = await s.page.$eval("[data-testid=protection-facts]", (e) => e.innerText).catch(() => "");
    check("UX: 'Why this deal is protected' is computed from this deal (price within limit, seal, locked hash, deterministic criteria)", /\$20\.00\) is within your per-deal limit \(\$60\.00\)/.test(prot) && /signature verified/.test(prot) && /locked under a hash/.test(prot) && /3 locked criteria \(2 required\) by deterministic code/.test(prot), prot.slice(0, 300));
    const ledgerPlain = await s.page.$eval("[data-testid=ledger]", (e) => e.innerText);
    check("UX: the ledger reads in plain language by default and shows no raw event names", /Payment authorized/.test(ledgerPlain) && /Delivery requirements passed; challenge window opened/.test(ledgerPlain) && !/STATE_TRANSITION|ORCHESTRATION_STEP/.test(ledgerPlain), ledgerPlain.slice(0, 200));
    await s.page.getByRole("button", { name: "Show technical details" }).click();
    check("UX: 'Show technical details' reveals the original event names (audit traceability kept)", /STATE_TRANSITION/.test(await s.page.$eval("[data-testid=ledger]", (e) => e.innerText)));
    await s.page.getByRole("button", { name: "Hide technical details" }).click();
    // keyboard: Tab from the top of the page must reach the scrollable CSV preview, and the focused element must have a visible outline
    await s.page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement instanceof HTMLElement) && document.activeElement.blur(); });
    let kbd = { reached: false, outline: "", steps: 0 };
    for (let i = 0; i < 250 && !kbd.reached; i++) {
      await s.page.keyboard.press("Tab");
      kbd.steps = i + 1;
      const f = await s.page.evaluate(() => { const e = document.activeElement; if (!e) return null; const cs = getComputedStyle(e); return { label: e.getAttribute("aria-label") || "", style: cs.outlineStyle, width: cs.outlineWidth }; });
      if (f && /^Delivered file preview/.test(f.label)) kbd = { reached: true, outline: `${f.style} ${f.width}`, steps: i + 1 };
    }
    check("UX: the scrollable CSV preview can be reached with the keyboard and shows a visible focus outline", kbd.reached && !/^none/.test(kbd.outline), JSON.stringify(kbd));
    // acceptance (double click = one capture)
    await W(s, /Accept delivery/, 15000);
    await s.page.getByRole("button", { name: "Accept delivery" }).dblclick();
    await W(s, /Paid \(captured\)/, 40000);
    await shot(s, "deal1-accepted-captured-mock");
    const dv = await detail(S1.deal1);
    check("S1: accepting (double click) produced exactly ONE capture of the locked price", opsOf(dv) === "CREATE_ORDER:CONFIRMED,AUTHORIZE:CONFIRMED,CAPTURE:CONFIRMED" && Number(dv.deal.capturedAmount) === 20, `${opsOf(dv)} captured ${dv.deal.capturedAmount}`);
    await truth(s, "deal1-captured", { expectCaptured: true });
    await layout(s, "deal1-captured");
    const stagesAfter = await s.page.$$eval("[data-testid=workflow] li[data-stage]", (els) => els.map((e) => e.getAttribute("data-status")).join(","));
    check("UX: after the capture all five stages are done", stagesAfter === "done,done,done,done,done", stagesAfter);
    check("UX: the window panel says it closed early because the buyer accepted", /closed early because you accepted/.test(await s.page.$eval("[data-testid=challenge-window]", (e) => e.innerText).catch(() => "")));
    // a repeated settlement check cannot capture again
    await s.page.getByRole("button", { name: "Check settlement now" }).click().catch(() => {});
    await s.page.waitForTimeout(1200);
    check("S1: a repeated 'Check settlement' after the capture does not capture again", opsOf(await detail(S1.deal1)).split("CAPTURE").length === 2);
  }, s);

  await step("deal 4: the buyer challenges one passed criterion; the engine re-verifies against the locked terms", async () => {
    await s.page.getByLabel("Target price (USD)").fill("20.00");
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    await s.page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
    await W(s, /Authorized, waiting for delivery/);
    await s.page.getByRole("button", { name: "Clean delivery" }).click();
    await W(s, /Verified, challenge window/);
    const d = (await dealsApi())[0];
    await s.page.getByLabel("Criterion").selectOption({ label: "dupes" });
    await s.page.getByLabel("Reason for the review request").fill("I want the duplicate check re-verified before paying.");
    await shot(s, "deal4-challenge-form", false);
    await s.page.getByRole("button", { name: "Request review" }).click();
    await s.page.waitForTimeout(3000);
    const dv = await detail(d.id);
    const types = (dv.events ?? []).map((e) => e.type);
    const challenged = (dv.events ?? []).some((e) => e.type === "STATE_TRANSITION" && e.payload && e.payload.challenged === "dupes");
    const verifications = types.filter((x) => x === "VERIFICATION_RECORDED").length;
    note("challenge outcome: deal state " + dv.deal.state + "; challenge recorded in the ledger: " + challenged + "; verification records: " + verifications + " (the engine clears the challenge window after a re-verification and then settles by itself: documented in tests/db/review-policy.db.test.ts, but the UI text does not say so)");
    await shot(s, "deal4-after-challenge");
    check("S1/deal4: the challenge was recorded (who/why/criterion) and the delivery was re-verified against the ORIGINAL locked terms (a second verification record exists; no new terms, no amount supplied)", challenged && verifications >= 2, `challenged=${challenged} verifications=${verifications}`);
    const captures = (dv.paypalOperations ?? []).filter((o) => o.type === "CAPTURE").length;
    check("S1/deal4: at most ONE capture, only for the locked price, only after the engine re-verified", captures <= 1 && (captures === 0 || Number(dv.deal.capturedAmount) === 20), "captures=" + captures + " amount=" + dv.deal.capturedAmount);
    await truth(s, "deal4-after-challenge", { expectCaptured: dv.deal.state === "CAPTURED" });
  }, s);

  await step("deal 2: duplicate-row delivery fails a required check and the authorization is voided", async () => {
    await s.page.getByLabel("Target price (USD)").fill("20.00");
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    await s.page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
    await W(s, /Authorized, waiting for delivery/);
    await s.page.getByRole("button", { name: "Delivery with duplicate rows" }).click();
    await W(s, /Voided \(not paid\)/, 40000);
    await shot(s, "deal2-duplicates-voided");
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    check("S2: a required-check failure voids the authorization; nothing is captured", dv.deal.state === "VOIDED" && !opsOf(dv).includes("CAPTURE") && opsOf(dv).includes("VOID:CONFIRMED"), opsOf(dv));
    check("S2: the UI says voided / not paid, MOCK", /Voided: the authorization was released and nothing was captured \(MOCK/.test(await text(s)));
    await truth(s, "deal2-voided");
  }, s);

  await step("deal 3: hidden-instruction delivery is flagged and waits for a human; no unrestricted reject", async () => {
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    await s.page.getByRole("button", { name: /Simulate buyer checkout \(MOCK\)/ }).click();
    await W(s, /Authorized, waiting for delivery/);
    await s.page.getByRole("button", { name: "Delivery with a hidden instruction" }).click();
    await W(s, /Needs your decision/, 40000);
    await shot(s, "deal3-injection-needs-human");
    const t = await text(s);
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    check("S3: a hidden instruction is flagged by the deterministic scanner and the deal stops for a human", /Flags raised by the scanner/.test(t) && dv.deal.state === "NEEDS_HUMAN");
    check("S3: no capture and no void happened by itself; there is no unrestricted reject button", !opsOf(dv).includes("CAPTURE") && !opsOf(dv).includes("VOID") && (await s.page.getByRole("button", { name: /^reject$/i }).count()) === 0, opsOf(dv));
    S1.deal3 = d.id;
  }, s);

  await step("logout", async () => {
    await s.page.getByRole("button", { name: "Sign out" }).click();
    await s.page.getByRole("heading", { name: "Sign in as the buyer" }).waitFor({ timeout: 10000 });
    check("S1: sign out returns to the login screen", true);
    await shot(s, "signed-out", false);
    const r = await fetch(`${BASE}/api/deals`, { headers: { cookie: "", origin: BASE } });
    check("S1: after logout the API refuses an unauthenticated request (401)", r.status === 401);
  }, s);
  S1.browser = s.log;
  await s.ctx.close();

  // mobile pass on the finished data
  const m = await newPage(MOBILE);
  await step("mobile viewport: login, deals, no overflow", async () => {
    await login(m);
    await m.page.getByText("Buyer mandate").first().waitFor();
    await m.page.getByText(/\$20\.00/).first().click();
    await W(m, /Negotiation transcript/);
    await shot(m, "dashboard-deals");
    await layout(m, "dashboard-deals");
    const unlabeled = await m.page.evaluate(() => [...document.querySelectorAll("input, select, textarea")].filter((e) => e.type !== "hidden" && !(e.id && document.querySelector(`label[for="${e.id}"]`)) && !e.closest("label") && !e.getAttribute("aria-label")).length);
    const unnamed = await m.page.evaluate(() => [...document.querySelectorAll("button, a[href]")].filter((e) => !(e.innerText || "").trim() && !e.getAttribute("aria-label")).length);
    check("mobile: every form control has a label and every button a name", unlabeled === 0 && unnamed === 0, `${unlabeled} unlabeled, ${unnamed} unnamed`);
    await truth(m, "mobile");
  }, m);
  S1.mobileBrowser = m.log;
  await m.ctx.close();
  kill(app);
  kill(seller);

  // =============================================== S2: haggler - counteroffer and concession ====================================================================================
  seller = startSeller("haggler", "22.00", 4111);
  app = startApp("http://127.0.0.1:4111");
  await waitFor("http://127.0.0.1:4111/whoami");
  await waitFor(`${BASE}/api/health`);
  s = await newPage(DESKTOP);
  const S2 = (report.scenarios.S2_haggler = {});
  await step("S2 haggler: opening, seller counteroffer, buyer concession, agreement", async () => {
    await login(s);
    await s.page.getByText("Buyer mandate").first().waitFor();
    await s.page.getByLabel("Target price (USD)").fill("20.00");
    const before = (await dealsApi()).length;
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    const t = await text(s);
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    const rounds = dv.negotiation.map((x) => `${x.sender}:${x.kind}:${x.payload.price ?? "-"}`);
    S2.transcript = rounds;
    check("S2: opening offer at or below the target, then a seller counteroffer, a buyer concession and agreement (2 rounds)", rounds.length === 4 && rounds[0] === "buyer:propose:20.00" && rounds[1].startsWith("seller:counter") && rounds[2].startsWith("buyer:counter") && rounds[3] === "seller:accept:-", rounds.join(" | "));
    check("S2: the simulator labels itself on every message", /Simulated seller \(not a real merchant\)/.test(t));
    check("S2: agreement is inside the authorized limits (target <= price <= ceiling 50.00)", Number(dv.deal.price) >= 20 && Number(dv.deal.price) <= 50, dv.deal.price);
    check("S2: a new deal was created for it", (await dealsApi()).length === before + 1);
    await shot(s, "haggler-counteroffer-concession-agreement");
    await truth(s, "haggler");
  }, s);
  S2.browser = s.log;
  await s.ctx.close();
  kill(app);
  kill(seller);

  // =============================================== S3: greedy seller above the ceiling - safe stop ============================================================================
  seller = startSeller("greedy", "200.00", 4112);
  app = startApp("http://127.0.0.1:4112");
  await waitFor("http://127.0.0.1:4112/whoami");
  await waitFor(`${BASE}/api/health`);
  s = await newPage(DESKTOP);
  const S3 = (report.scenarios.S3_seller_refuses_range = {});
  await step("S3 seller stays above the authorized range: no deal, never above the ceiling, no payment", async () => {
    await login(s);
    await s.page.getByText("Buyer mandate").first().waitFor();
    await openDeal(s, { expectOutcome: /Negotiation ended without a deal/ });
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    const prices = dv.negotiation.filter((x) => x.sender === "buyer").map((x) => Number(x.payload.price));
    S3.buyerOffers = prices;
    S3.state = dv.deal.state;
    check("S3: the negotiation ended without a deal and the deal is BLOCKED", dv.deal.state === "BLOCKED", dv.deal.state);
    check("S3: the buyer never offered above the ceiling (50.00) and never above the mandate per-deal cap", prices.every((p) => p <= 50), prices.join(","));
    check("S3: no PayPal order or operation exists for a failed negotiation", (dv.paypalOperations ?? []).length === 0 && !dv.deal.paypalOrderId);
    // the deals list also shows earlier mock deals, so the payment claim is checked on THIS deal's PayPal card
    check("S3: the UI says it ended without a deal, and this deal's PayPal card shows no order and no payment", /ended without a deal/.test(s.lastText) && /Ended without a payment/.test(s.settledText) && /No PayPal operation has been attempted for this deal/.test(s.settledText));
    await shot(s, "seller-refuses-no-agreement-blocked");
    await truth(s, "greedy");
  }, s);
  S3.browser = s.log;
  await s.ctx.close();
  kill(app);
  kill(seller);

  // =============================================== S4: tamper seller - protocol violation ===================================================================================
  seller = startSeller("tamper", "18.00", 4113);
  app = startApp("http://127.0.0.1:4113");
  await waitFor("http://127.0.0.1:4113/whoami");
  await waitFor(`${BASE}/api/health`);
  s = await newPage(DESKTOP);
  const S4 = (report.scenarios.S4_seller_tamper = {});
  await step("S4 a seller that smuggles criteria/amount fields is a protocol violation: blocked, no price accepted", async () => {
    await login(s);
    await s.page.getByText("Buyer mandate").first().waitFor();
    await openDeal(s, { expectOutcome: /Negotiation ended without a deal/ });
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    S4.state = dv.deal.state;
    const reason = (dv.events ?? []).map((e) => e.type).filter((x) => /SELLER_PROTOCOL_VIOLATION/.test(x));
    check("S4: the out-of-contract seller reply blocks the deal (SELLER_PROTOCOL_VIOLATION) and no payment exists", dv.deal.state === "BLOCKED" && reason.length > 0 && (dv.paypalOperations ?? []).length === 0, `${dv.deal.state} ${reason.join(",")}`);
    await shot(s, "seller-tamper-protocol-violation");
  }, s);
  S4.browser = s.log;
  await s.ctx.close();
  kill(app);
  kill(seller);

  // =============================================== S5: adversarial seller - injection text in messages ==============================================================================
  seller = startSeller("adversarial", "18.00", 4114);
  app = startApp("http://127.0.0.1:4114");
  await waitFor("http://127.0.0.1:4114/whoami");
  await waitFor(`${BASE}/api/health`);
  s = await newPage(DESKTOP);
  const S5 = (report.scenarios.S5_seller_injection = {});
  await step("S5 seller messages that try to command the buyer are shown as untrusted text and change nothing", async () => {
    await login(s);
    await s.page.getByText("Buyer mandate").first().waitFor();
    await openDeal(s, { expectOutcome: "Negotiation transcript" });
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    const t = await text(s);
    S5.transcript = dv.negotiation.map((x) => `${x.sender}:${x.kind}:${x.payload.price ?? "-"}`);
    const buyerLeaks = dv.negotiation.filter((x) => x.sender === "buyer").some((x) => /50\.00|budget|ceiling|PAYPAL|secret/i.test(JSON.stringify(x.payload.message ?? "")));
    check("S5: the buyer disclosed nothing and accepted no injected price (price within limits)", !buyerLeaks && (dv.deal.price === null || Number(dv.deal.price) <= 50), dv.deal.price ?? "no deal");
    check("S5: the seller's injection text is displayed only as seller text (untrusted), never as an instruction that changed state", /Round 1 · Seller/.test(t));
    await shot(s, "seller-injection-untrusted-text");
    await truth(s, "adversarial");
  }, s);
  S5.browser = s.log;
  await s.ctx.close();
  kill(app);
  kill(seller);

  // =============================================== S6: seller unavailable ==================================================================================================
  app = startApp("http://127.0.0.1:4999"); // nothing listens there
  await waitFor(`${BASE}/api/health`);
  s = await newPage(DESKTOP);
  const S6 = (report.scenarios.S6_seller_down = {});
  await step("S6 seller unavailable: a clear error, the deal is blocked, nothing is paid", async () => {
    await login(s);
    await s.page.getByText("Buyer mandate").first().waitFor();
    await openDeal(s, { expectOutcome: /Negotiation ended without a deal/ });
    const d = (await dealsApi())[0];
    const dv = await detail(d.id);
    S6.state = dv.deal.state;
    check("S6: with the seller unreachable the deal is BLOCKED (SELLER_ERROR) and no PayPal operation exists", dv.deal.state === "BLOCKED" && (dv.paypalOperations ?? []).length === 0);
    check("S6: the UI explains the failure, and this deal's PayPal card shows no order and no payment", /ended without a deal/.test(s.lastText) && /BLOCKED|SELLER_ERROR|blocked/i.test(s.lastText) && /Ended without a payment/.test(s.settledText) && /No PayPal operation has been attempted for this deal/.test(s.settledText));
    await shot(s, "seller-unreachable-blocked");
  }, s);
  S6.browser = s.log;
  await s.ctx.close();
  kill(app);
}

try {
  await main();
} catch (e) {
  check("journey aborted by an unexpected error", false, String(e).split("\n")[0]);
} finally {
  for (const c of children) kill(c);
  await browser.close();
  try {
    psql("postgres", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    note(`disposable database ${DB_NAME} dropped`);
  } catch {
    note(`COULD NOT drop ${DB_NAME}; drop it manually`);
  }
  // browser noise summary (the pre-login session probe legitimately answers 401)
  const noisy = [];
  for (const [k, v] of Object.entries(report.scenarios)) for (const [bk, bl] of Object.entries(v).filter(([n]) => /browser/i.test(n))) {
    const http = (bl.http ?? []).filter((x) => !/^401 GET \/api\/auth\/session/.test(x) && !/^401 POST \/api\/auth\/login/.test(x) && !/^(500|4\d\d) POST \/api\/deals\/[^/]+\/delivery/.test(x) && !/^400 POST \/api\/(mandates\/preview|deals)$/.test(x));
    const consoleErr = (bl.console ?? []).filter((x) => !/Failed to load resource/.test(x));
    if (http.length || consoleErr.length || (bl.pageErrors ?? []).length || (bl.failed ?? []).filter((x) => !/delivery/.test(x)).length) noisy.push({ k, bk, http, consoleErr, pageErrors: bl.pageErrors, failed: bl.failed });
  }
  report.browserNoise = noisy;
  check("browser: no unexpected console errors, page errors, failed requests or HTTP errors across all scenarios (injected failures excluded)", noisy.length === 0, JSON.stringify(noisy).slice(0, 300));
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\nMOCK JOURNEY: ${report.checks.length - failed.length} passed, ${failed.length} failed, ${report.screenshots.length} screenshots in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}
