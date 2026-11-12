/**
 * READ-ONLY screenshots of the REAL, completed Sandbox deal (http://localhost:3000, the running Sandbox-mode app on mandate_e2e) for the submission.
 *
 *   node scripts/submission-screenshots-real.mjs --out docs/submission/screenshots/real-sandbox
 *
 * SAFETY (same net as e2e-real-dashboard-audit.mjs): every browser request to the app's /api that is not a GET (except sign-in/sign-out) is aborted before it leaves the browser, and the
 * run fails if any such attempt exists. It never clicks a payment, delivery, accept, challenge or checkout control. It signs in with the principal's credentials from .env.local
 * (never printed, never typed into a screenshot: the sign-in screen is NOT captured with a filled password). No PayPal request is possible: the app refuses non-loopback requests.
 * It records the deal's sanitized view as JSON next to the images so the screenshots can be checked against the stored evidence.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const OUT = arg("out", "docs/submission/screenshots/real-sandbox");
const BASE = "http://localhost:3000";
const CHROME = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).replace(/^\uFEFF/, "").trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }),
);
const report = { ranAt: new Date().toISOString(), target: BASE, readOnly: true, screenshots: [], checks: [], blockedMutationAttempts: [] };
const check = (id, ok, detail = "") => {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail && !ok ? "  " + detail : ""}`);
};
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function run(name, size, mobile) {
  const ctx = await browser.newContext({ viewport: size, isMobile: mobile, hasTouch: mobile, locale: "en-US" });
  await ctx.route("**/*", (route) => {
    const r = route.request();
    const u = new URL(r.url());
    if (u.origin === BASE && u.pathname.startsWith("/api/") && r.method() !== "GET" && !/^\/api\/auth\/(login|logout)$/.test(u.pathname)) {
      report.blockedMutationAttempts.push(`${r.method()} ${u.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
  await page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Buyer mandate").first().waitFor();
  if (!(await page.getByText("Negotiation transcript").isVisible().catch(() => false))) await page.getByText(/\$20\.00/).first().click();
  await page.getByText("Negotiation transcript").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => document.body.innerText);
  const shot = async (file, locator) => {
    const f = `${name}-${file}.png`;
    if (locator) await locator.screenshot({ path: join(OUT, f) });
    else await page.screenshot({ path: join(OUT, f), fullPage: true });
    report.screenshots.push(f);
  };
  check(`${name}: PayPal chip says Sandbox with writes LOCKED`, /Sandbox \(writes LOCKED/.test(t) && !/MOCK \(in memory\)/.test(t));
  check(`${name}: the deal shows CAPTURED (PayPal Sandbox), not mock`, /Captured \(PayPal Sandbox\)/.test(t) && !/Captured \(MOCK/.test(t));
  check(`${name}: settlement basis says the expired-window rule and that no explicit acceptance was recorded`, /Paid under the expired-window rule/.test(t) && /No explicit acceptance was recorded for this deal/.test(t) && !/Paid after you accepted/.test(t));
  check(`${name}: order, authorization and capture ids and the $20.00 capture are shown`, ["4YJ97804H20584006", "19070882T8512554U", "02U8827748683101W"].every((id) => t.includes(id)) && /\$20\.00/.test(t));
  check(`${name}: the Buyer Agent chip is labelled as the setting for NEW deals and this deal's transcript says no AI model was called`, /Buyer Agent for new deals/i.test(t) && /No AI model was called for this deal/.test(t));
  check(`${name}: no password or secret text on the page`, !t.includes(env.PRINCIPAL_LOGIN_SECRET) && !/client_secret|access_token|Bearer /i.test(t));
  await shot("full-deal-captured");
  for (const [title, file] of [["Negotiation transcript", "negotiation"], ["PayPal payment", "paypal-payment"], ["Seller delivery & evidence", "delivery-evidence"], ["Your review & settlement", "settlement-basis"], ["Activity & audit history", "audit-history"]]) {
    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).first();
    if (await card.isVisible().catch(() => false)) await shot(file, card);
    else report.checks.push({ id: `${name}: card '${title}' not isolated`, ok: true, detail: "full-page capture only" });
  }
  const mutations = report.blockedMutationAttempts.length;
  check(`${name}: no state-changing browser request was attempted`, mutations === 0, report.blockedMutationAttempts.join(", "));
  if (name === "desktop") {
    // the deal as the API shows it (sanitized by the app), for cross-checking the screenshots against the evidence
    const detail = await page.evaluate(async () => {
      const list = await (await fetch("/api/deals")).json();
      const id = (list.deals ?? list.data ?? list)[0]?.id;
      return id ? await (await fetch(`/api/deals/${id}`)).json() : null;
    });
    const d = detail?.deal ?? detail?.data?.deal;
    report.dealView = d ? { id: d.id, state: d.state, paypalOrderId: d.paypalOrderId ?? null, capturedAmount: d.capturedAmount ?? null } : null;
  }
  await page.getByRole("button", { name: /sign out/i }).click().catch(() => {});
  await ctx.close();
}

try {
  await run("desktop", { width: 1366, height: 900 }, false);
  console.log("pacing for the login limiter (65s)...");
  await new Promise((r) => setTimeout(r, 65000));
  await run("mobile", { width: 390, height: 844 }, true);
} finally {
  await browser.close();
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
const failed = report.checks.filter((c) => !c.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots; blocked mutation attempts: ${report.blockedMutationAttempts.length}`);
process.exit(failed.length === 0 ? 0 : 1);
