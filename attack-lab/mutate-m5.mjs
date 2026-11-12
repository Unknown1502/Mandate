/**
 * Targeted mutation check for milestone 5 (not the full mutation certification). Each mutant breaks ONE trust-boundary rule in production source, runs the tests that should notice,
 * and restores the file byte-for-byte (verified by hash). A mutant is KILLED when at least one test fails.
 *   node attack-lab/mutate-m5.mjs
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const DB = "node --env-file=.env.local ./node_modules/vitest/vitest.mjs run -c vitest.db.config.mts";
const UNIT = "npx vitest run";

const mutants = [
  { id: "M5-1 order-binding check disabled", file: "src/settlement/engine.ts", from: "  const pu = order.purchase_units?.[0];\n  if (!pu) return \"ORDER_HAS_NO_PURCHASE_UNIT\";", to: "  return null;\n  const pu = order.purchase_units?.[0];\n  if (!pu) return \"ORDER_HAS_NO_PURCHASE_UNIT\";", cmd: `${DB} tests/db/engine.db.test.ts tests/db/paypal-sdk-lifecycle.db.test.ts` },
  { id: "M5-2 timeouts classified as definitive rejections", file: "src/paypal/sdk-gateway.ts", from: "if (e instanceof AbortError) return { kind: \"unknown\", code: \"PAYPAL_TIMEOUT\"", to: "if (e instanceof AbortError) return { kind: \"rejected\", status: 0, code: \"PAYPAL_TIMEOUT\"", cmd: `${UNIT} tests/unit/sdk-gateway.test.ts` },
  { id: "M5-3 Sandbox write lock bypassed", file: "src/lib/runtime.ts", from: "if (!this.authorized) return { kind: \"rejected\"", to: "if (false) return { kind: \"rejected\"", cmd: `${DB} tests/db/paypal-sdk-lifecycle.db.test.ts` },
  { id: "M5-4 capture path accepted for any operation", file: "src/paypal/sdk-gateway.ts", from: "CAPTURE: new RegExp(`^/v2/payments/authorizations/(${ID})/capture$`),", to: "CAPTURE: /^.*$/,", cmd: `${UNIT} tests/unit/sdk-gateway.test.ts` },
  { id: "M5-5 checkout offered while Sandbox writes are locked", file: "src/paypal/checkout.ts", from: "if (!a.sandboxWritesAuthorized) return", to: "if (false) return", cmd: `${UNIT} tests/unit/paypal-checkout.test.ts` },
  { id: "M5-6 checkout offered in any deal state", file: "src/paypal/checkout.ts", from: "if (a.deal.state !== \"AWAITING_BUYER_APPROVAL\") return", to: "if (false) return", cmd: `${UNIT} tests/unit/paypal-checkout.test.ts` },
  { id: "M5-7 policy: opening above target allowed (Part B regression)", file: "src/domain/negotiation.ts", from: "if (intent.kind === \"propose\" && s.target && p.gt(openingMax(s.target, s.ceiling)))", to: "if (false)", cmd: `${DB} tests/db/negotiation-prompt-sim.db.test.ts` },
];

const results = [];
for (const m of mutants) {
  const original = readFileSync(m.file, "utf8");
  const before = sha(original);
  if (!original.includes(m.from)) throw new Error(`${m.id}: pattern not found in ${m.file}`);
  let killed = false;
  let detail = "";
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    try {
      execSync(m.cmd, { stdio: "pipe", timeout: 540_000, env: process.env });
    } catch (e) {
      killed = true;
      detail = String(e.stdout ?? "").split("\n").filter((l) => /FAIL|×/.test(l)).slice(0, 2).join(" | ").slice(0, 200);
    }
  } finally {
    writeFileSync(m.file, original);
  }
  const restored = sha(readFileSync(m.file, "utf8")) === before;
  results.push({ id: m.id, killed, restored, detail });
  console.log(`${killed ? "KILLED  " : "SURVIVED"} ${restored ? "restored" : "NOT RESTORED"}  ${m.id}${detail ? "  <- " + detail : ""}`);
}
writeFileSync("docs/qa/m5-mutation-targeted.json", JSON.stringify({ ranAt: new Date().toISOString(), scope: "targeted trust-boundary mutants for milestone 5 only (not the full certification)", results }, null, 2) + "\n");
process.exit(results.every((r) => r.killed && r.restored) ? 0 : 1);
