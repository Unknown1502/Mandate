/**
 * ONE negotiation through the real dashboard with whatever Buyer Agent the server is configured with (a real model only if the server has one configured AND the owner authorized
 * the run; otherwise the rule-based brain and no model call). Synthetic mandate, MOCK PayPal (the app creates an in-memory mock order after the terms lock), V2 disabled.
 *   node scripts/live-run.mjs --out docs/qa/live-groq [--base http://localhost:3000] [--chrome <path>]
 * The app must already be running with LLM_PROVIDER/<key>/LLM_MODEL_AGENTS set and a throwaway database. The browser only clicks "New mandate" -> "Confirm and sign" ->
 * "Open deal" (that click makes the Buyer Agent's model calls, a handful at most: one per round, 4 rounds max). It stops after the negotiation: no checkout, no delivery.
 * Credentials come from .env.local and are never printed. This script itself calls no model and no PayPal; the app does, through the server.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "docs/qa/live-run");
const base = arg("base", "http://localhost:3000");
const chromePath = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).replace(/^\uFEFF/, "").trim(), l.slice(i + 1).trim()];
  }),
);

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("response", (r) => { if (r.status() >= 400 && !/\/api\/auth\/session/.test(r.url())) problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`); });
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });

await page.goto(base, { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(env.PRINCIPAL_EMAIL);
await page.getByLabel("Login secret").fill(env.PRINCIPAL_LOGIN_SECRET);
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByText("Buyer mandate").first().waitFor();
const chips = await page.evaluate(() => document.body.innerText);
const buyerChip = (chips.match(/Buyer Agent[^\n]*\n?[^\n]*/) ?? [""])[0];
await shot("01-dashboard-live-ai-chip");

await page.getByRole("button", { name: "New mandate" }).click();
await page.getByRole("button", { name: "Preview" }).click();
await page.getByText("Digest to confirm:").waitFor();
await page.getByRole("button", { name: "Confirm and sign" }).click();
await page.getByText("Seal verified").first().waitFor();

await page.getByRole("button", { name: /Open deal/ }).click(); // <- the Buyer Agent's real model calls happen here
const done = await Promise.race([
  page.getByText("Negotiation transcript").waitFor({ timeout: 120_000 }).then(() => "transcript"),
  page.getByText(/AI provider failed|BUYER_OUTPUT_INVALID|Negotiation blocked|blocked/i).first().waitFor({ timeout: 120_000 }).then(() => "blocked"),
]).catch(() => "timeout");
await page.waitForTimeout(1500);
await shot("02-negotiation-live");

const detail = await page.evaluate(async () => {
  const list = await (await fetch("/api/deals")).json();
  const d = list.deals?.[0];
  if (!d) return null;
  return await (await fetch(`/api/deals/${d.id}`)).json();
});
const text = await page.evaluate(() => document.body.innerText);
const runs = (detail?.modelRuns ?? []).map((r) => ({ role: r.role, model: r.model, ok: r.output?.failed !== true, latencyMs: r.latencyMs, error: r.output?.error ?? null }));
const result = {
  ranAt: new Date().toISOString(),
  outcome: done,
  dealState: detail?.deal?.state ?? detail?.state ?? null,
  buyerChipText: buyerChip.replace(/\s+/g, " ").slice(0, 160),
  transcript: (detail?.negotiation ?? []).map((m) => ({ round: m.round, sender: m.sender, kind: m.kind, price: m.payload?.price ?? null, message: m.payload?.message ?? null })),
  modelRuns: runs,
  pageClaimsLiveAi: /Live AI/.test(text),
  pageShowsRecordedModelCalls: /Real model calls recorded|model calls recorded/i.test(text),
  buyerBrainShown: (text.match(/Buyer Agent · [^\n]*/) ?? [null])[0],
  pageSaysNoAiCalled: /No AI model was called for this deal/.test(text),
  problems,
  note: "synthetic mandate; PayPal mock; no checkout or delivery performed; V2 disabled",
};
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
await browser.close();
