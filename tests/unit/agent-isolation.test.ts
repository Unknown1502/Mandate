/**
 * Agent isolation. (1) STATIC: the agent and seller-service source trees cannot import the database, settlement,
 * PayPal, signing, session or environment code. (2) PROCESS: the Seller Agent really runs as a separate OS process
 * that cannot see our secrets. These tests check structure and process boundaries; they do not prove an LLM behaves.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sellerResponseSchema } from "@/agents/contracts";
import { HttpSellerClient } from "@/agents/seller-client";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
}
const resolveRel = (file: string, spec: string) => relative(ROOT, resolve(dirname(file), spec)).replace(/\\/g, "/");

const agentFiles = walk(join(ROOT, "src", "agents"));
const sellerFiles = walk(join(ROOT, "seller-service"));

describe("static isolation", () => {
  it("found the files we expect to police", () => {
    expect(agentFiles.map((f) => relative(ROOT, f).replace(/\\/g, "/")).sort()).toEqual(
      ["src/agents/buyer.ts", "src/agents/contracts.ts", "src/agents/llm.ts", "src/agents/sanitize.ts", "src/agents/seller-client.ts"].sort(),
    );
    expect(sellerFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("src/agents imports only zod, node:crypto, its own files, and the pure redact helper", () => {
    for (const f of agentFiles) {
      for (const spec of importsOf(f)) {
        if (spec.startsWith(".")) {
          const target = resolveRel(f, spec);
          expect(target.startsWith("src/agents/") || target === "src/lib/redact", `${relative(ROOT, f)} imports ${spec}`).toBe(true);
        } else {
          // the vendor SDK (Google Gemini) may be imported by the provider module ONLY
          const allowed = relative(ROOT, f).replace(/\\/g, "/") === "src/agents/llm.ts" ? ["zod", "node:crypto", "@google/genai", "groq-sdk"] : ["zod", "node:crypto"];
          expect(allowed, `${relative(ROOT, f)} imports ${spec}`).toContain(spec);
        }
      }
    }
  });

  it("seller-service imports only node:http/net, decimal.js, its own files and the wire contracts", () => {
    for (const f of sellerFiles) {
      for (const spec of importsOf(f)) {
        if (spec.startsWith(".")) {
          const target = resolveRel(f, spec);
          expect(target.startsWith("seller-service/") || target === "src/agents/contracts", `${relative(ROOT, f)} imports ${spec}`).toBe(true);
        } else {
          expect(["node:http", "node:net", "decimal.js"], `${relative(ROOT, f)} imports ${spec}`).toContain(spec);
        }
      }
    }
  });

  it("no agent code can reach PayPal, the database, settlement, signing, sessions or env parsing", () => {
    const forbidden = /(@prisma\/client|\/db\/|settlement|paypal|signing|session|\/auth|\/env|mandates|deals|ledger|budget)/i;
    for (const f of [...agentFiles, ...sellerFiles]) {
      for (const spec of importsOf(f)) {
        if (!spec.startsWith(".") && spec !== "@prisma/client") continue;
        expect(forbidden.test(spec) && spec !== "../lib/redact", `${relative(ROOT, f)} imports ${spec}`).toBe(false);
      }
    }
  });

  it("agents do not read process.env, and only the LLM provider and seller client perform network calls", () => {
    for (const f of agentFiles) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(/process\.env/);
    const withFetch = agentFiles.filter((f) => /\bfetch\s*\(|this\.fetchImpl\s*\(/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    // the model provider reaches the network through the vendor SDK (imported only by src/agents/llm.ts, checked above), so no raw fetch remains there
    expect(withFetch.sort()).toEqual(["src/agents/seller-client.ts"]);
    for (const f of sellerFiles) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(/\bfetch\s*\(/);
  });

  it("the orchestrator holds the mandate and database but never imports PayPal or the settlement engine", () => {
    const specs = importsOf(join(ROOT, "src", "domain", "negotiation.ts"));
    expect(specs.filter((s) => /settlement|paypal|gateway/i.test(s))).toEqual([]);
  });

  it("the seller client only talks to an allow-listed host", () => {
    expect(() => new HttpSellerClient("http://127.0.0.1:1")).not.toThrow();
    expect(() => new HttpSellerClient("http://evil.example")).toThrow(/allow-list/);
    expect(() => new HttpSellerClient("file:///etc/passwd")).toThrow();
    expect(() => new HttpSellerClient("http://evil.example", { allowedHosts: ["evil.example"] })).not.toThrow();
  });
});

describe("process isolation (real child process)", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill();
    child = undefined;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.DATABASE_URL;
  });

  function startSeller(mode: string): Promise<{ url: string; pid: number }> {
    // Deliberately MINIMAL environment: only what Node needs to run. No DATABASE_URL, no PayPal, no signing keys.
    const env: Record<string, string> = { SELLER_PORT: "0", SELLER_MODE: mode, SELLER_FLOOR: "22.00" };
    for (const k of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k]) env[k] = process.env[k]!;
    child = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "seller-service", "main.ts")], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("seller did not start")), 20_000);
      child!.stdout!.on("data", (b: Buffer) => {
        const m = /SELLER_LISTENING (\d+)/.exec(b.toString());
        if (m) {
          clearTimeout(t);
          res({ url: `http://127.0.0.1:${m[1]}`, pid: child!.pid! });
        }
      });
      child!.on("exit", (c) => rej(new Error(`seller exited early (${c})`)));
    });
  }

  it("runs as a different OS process and cannot see any of the parent's secrets", async () => {
    process.env.PAYPAL_CLIENT_SECRET = "parent-only-secret";
    process.env.DATABASE_URL = "postgresql://parent-only";
    const { url, pid } = await startSeller("honest");
    const who = (await (await fetch(`${url}/whoami`)).json()) as { pid: number; sensitiveEnvNames: string[]; mode: string };
    // The tsx launcher may sit between us and the real node process (Windows), so the seller's own pid can differ from the spawned pid.
    expect(pid).not.toBe(process.pid);
    expect(who.pid).not.toBe(process.pid);
    expect(Number.isInteger(who.pid)).toBe(true);
    expect(Object.keys(process.env).some((k) => /PAYPAL|DATABASE/.test(k))).toBe(true); // the parent DOES have them
    expect(who.sensitiveEnvNames).toEqual([]); // the seller does not
    expect(who.mode).toBe("honest");
  }, 30_000);

  it("negotiates over HTTP with a valid, contract-conforming reply (honest) and a violating one (tamper)", async () => {
    const req = {
      round: 1,
      spec: { taskType: "data_cleaning", description: "Clean it", criteria: [{ id: "schema", text: "ok", type: "deterministic", required: true, weight: 100 }], currency: "USD", deadline: "2029-01-01T00:00:00.000Z" },
      buyer: { kind: "propose", price: "20.00" },
    } as const;
    const honest = await startSeller("honest");
    const a = await new HttpSellerClient(honest.url).negotiate(req as never);
    expect(a.ok && sellerResponseSchema.safeParse(a.body).success).toBe(true);
    child?.kill();
    const tamper = await startSeller("tamper");
    const b = await new HttpSellerClient(tamper.url).negotiate(req as never);
    expect(b.ok).toBe(true);
    expect(b.ok && sellerResponseSchema.safeParse(b.body).success).toBe(false);
  }, 45_000);

  it("rejects malformed, oversized and extra-field requests", async () => {
    const { url } = await startSeller("honest");
    const post = (body: string) => fetch(`${url}/negotiate`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ round: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ round: 1, mandate: { budget: "100" }, spec: {}, buyer: {} }))).status).toBe(400);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  }, 30_000);
});
