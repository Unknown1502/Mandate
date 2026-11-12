/** Stage 4 script: refusal without arguments (nothing sent) and source guarantees (loopback only; delivery is the one mutation; no accept/advance/review/challenge/PayPal). */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const code = readFileSync(join(ROOT, "scripts", "paypal-e2e-stage4.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("scripts/paypal-e2e-stage4.mjs", () => {
  it("without its required arguments it refuses to start (exit 3) before any request", () => {
    const r = spawnSync(process.execPath, ["scripts/paypal-e2e-stage4.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/NOT STARTED. Nothing was sent/);
  });
  it("talks only to the local app on loopback and makes exactly one mutation: the clean delivery", () => {
    expect(code).toMatch(/const BASE = "http:\/\/127\.0\.0\.1:3000"/);
    expect(code).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect([...code.matchAll(/call\("(POST|PUT|PATCH|DELETE)"/g)]).toHaveLength(1);
    expect(code).toMatch(/call\("POST", `\/api\/deals\/\$\{DEAL\}\/delivery`, \{ quality: "good" \}\)/);
  });
  it("never calls accept, advance, review, challenge, decision, mock-approval or any PayPal endpoint, and needs the approval flag", () => {
    expect(code).not.toMatch(/\/accept|\/advance|\/review|\/challenge|\/decision|\/mock-approval|paypal\.com|checkout\/orders|payments\//);
    expect(code).toMatch(/flag\("approve-stage4-delivery"\)/);
    expect(code).toMatch(/status\.sandboxWritesAuthorized === false/);
  });
});
