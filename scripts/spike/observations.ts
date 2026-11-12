import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CallRecord } from "../../src/paypal/client";

export const OBS_PATH = "docs/sandbox-observations.md";

const HEADER = `# Sandbox Observations

Facts captured from REAL calls to \`https://api-m.sandbox.paypal.com\` by the Phase 1 spike harness
(\`scripts/spike/run.ts\`). Entries below the "Raw call log" heading are appended automatically by code and
sanitized (tokens, client secrets, payer/payee personal data are replaced with \`[REDACTED]\`).
Interpretation lives in the sections above the log and is written separately; anything not exercised is
marked **UNVERIFIED**. Nothing here is a mock.

## Raw call log

`;

let ctx = { testId: "S00", label: "unlabelled" };
export function setContext(testId: string, label: string): void {
  ctx = { testId, label };
}

function count(): number {
  return (readFileSync(OBS_PATH, "utf8").match(/^### OBS-/gm) ?? []).length;
}

const fence = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

export function recordCall(r: CallRecord): void {
  if (!existsSync(OBS_PATH)) {
    mkdirSync(dirname(OBS_PATH), { recursive: true });
    writeFileSync(OBS_PATH, HEADER);
  }
  const n = String(count() + 1).padStart(3, "0");
  const lines = [
    `### OBS-${n} · ${ctx.testId} · ${ctx.label}`,
    `- Time (UTC): ${r.at}`,
    `- Endpoint: \`${r.method} ${r.path}\``,
    `- Request headers (sanitized): ${JSON.stringify(r.requestHeaders)}`,
    `- PayPal-Request-Id: ${r.requestId ?? "n/a"}`,
    r.requestBody !== undefined ? `- Request body (sanitized):\n${fence(r.requestBody)}` : `- Request body: none`,
    `- Outcome: ${r.outcome.toUpperCase()}${r.error ? ` (${r.error})` : ""}`,
    `- HTTP status: ${r.status ?? "none (no response received)"}`,
    `- PayPal debug id: ${r.debugId ?? "n/a"}`,
    `- Duration: ${r.durationMs} ms`,
    r.responseBody !== null && r.responseBody !== undefined
      ? `- Response body (sanitized):\n${fence(r.responseBody)}`
      : `- Response body: empty`,
    "",
    "",
  ];
  appendFileSync(OBS_PATH, lines.join("\n"));
}
