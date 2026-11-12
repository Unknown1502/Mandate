/**
 * Isolation probes. Each probe EXECUTES something and reports what it observed. They test import/process/environment boundaries.
 * They do NOT, and cannot, show that the seller process is an OS sandbox: it is not one (see the LIMITATION entry).
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BuyerAgent } from "../src/agents/buyer";
import { createDeal } from "../src/domain/deals";
import { runNegotiation } from "../src/domain/negotiation";
import { ScriptedBuyerBrain } from "../tests/helpers/scripted";
import { prisma, policyDeps, type Lab } from "./harness";
import { LAB_CRITERIA } from "./cases";
import { makeMandate, makePrincipal } from "../tests/db/fixtures";

export interface ProbeResult {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "NOT_PROVIDED";
  evidence: string;
}

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "reports" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
  });
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const importsOf = (f: string) => [...readFileSync(f, "utf8").matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]!).filter(Boolean);
const target = (f: string, s: string) => relative(ROOT, resolve(dirname(f), s)).replace(/\\/g, "/");

function scan(dirs: string[], forbidden: RegExp): { files: number; hits: string[] } {
  const files = dirs.flatMap((d) => walk(join(ROOT, d)));
  const hits: string[] = [];
  for (const f of files) for (const s of importsOf(f)) if (forbidden.test(s.startsWith(".") ? target(f, s) : s)) hits.push(`${relative(ROOT, f).replace(/\\/g, "/")} -> ${s}`);
  return { files: files.length, hits };
}

function startChildSeller(): Promise<{ url: string; stop(): void }> {
  const env: Record<string, string> = { SELLER_PORT: "0", SELLER_MODE: "honest" };
  for (const k of ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k]) env[k] = process.env[k]!;
  const child = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "seller-service", "main.ts")], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("seller did not start")), 20_000);
    child.stdout.on("data", (b: Buffer) => {
      const m = /SELLER_LISTENING (\d+)/.exec(b.toString());
      if (m) {
        clearTimeout(t);
        res({ url: `http://127.0.0.1:${m[1]}`, stop: () => void child.kill() });
      }
    });
    child.on("exit", (c) => rej(new Error(`seller exited early (${c})`)));
  });
}

export async function runProbes(lab: Lab): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const add = (id: string, title: string, status: ProbeResult["status"], evidence: string) => out.push({ id, title, status, evidence });

  // 1. a real child process cannot see the parent's secrets
  try {
    process.env.ATTACKLAB_PAYPAL_CLIENT_SECRET = "parent-only";
    process.env.ATTACKLAB_DATABASE_URL = "parent-only";
    const child = await startChildSeller();
    try {
      const who = (await (await fetch(`${child.url}/whoami`)).json()) as { pid: number; sensitiveEnvNames: string[] };
      const parentSees = Object.keys(process.env).filter((k) => /PAYPAL|DATABASE|SECRET|KEY/i.test(k)).length;
      add("ISO-1", "Seller runs as a separate OS process whose environment contains none of the parent's secret-named variables", who.sensitiveEnvNames.length === 0 && who.pid !== process.pid ? "PASS" : "FAIL", `seller pid ${who.pid} != lab pid ${process.pid}; seller sees ${who.sensitiveEnvNames.length} sensitive env names; the lab process sees ${parentSees}`);
    } finally {
      child.stop();
      delete process.env.ATTACKLAB_PAYPAL_CLIENT_SECRET;
      delete process.env.ATTACKLAB_DATABASE_URL;
    }
  } catch (e) {
    add("ISO-1", "Seller runs as a separate OS process whose environment contains none of the parent's secret-named variables", "FAIL", `probe error: ${(e as Error).message}`);
  }

  // 2. static import boundaries
  const agents = scan(["src/agents", "seller-service"], /prisma|\/db\/|paypal|settlement|signing|mandates|deals|ledger|budget|orchestration|verification/i);
  add("ISO-2", "Buyer/seller code imports no database, PayPal, settlement, signing, ledger, budget, orchestration or verification module", agents.hits.length === 0 ? "PASS" : "FAIL", `${agents.files} files scanned; ${agents.hits.length} forbidden imports${agents.hits.length ? `: ${agents.hits.slice(0, 3).join("; ")}` : ""}`);
  const money = scan(["src/orchestration", "src/verification"], /paypal|gateway|settlement\/engine|domain\/budget|signing/i);
  add("ISO-3", "Orchestration and verification code import no PayPal, gateway, settlement-engine, budget or signing module", money.hits.length === 0 ? "PASS" : "FAIL", `${money.files} files scanned; ${money.hits.length} forbidden imports${money.hits.length ? `: ${money.hits.slice(0, 3).join("; ")}` : ""}`);
  const labScan = scan(["attack-lab"], /paypal\/client|paypal\/gateway|paypal\/orders/i);
  add("ISO-4", "The Attack Lab itself imports no real PayPal client or REST gateway (it can only reach the in-memory mock)", labScan.hits.length === 0 ? "PASS" : "FAIL", `${labScan.files} files scanned; ${labScan.hits.length} forbidden imports`);

  // 3. the buyer cannot mutate its context
  try {
    const p = await makePrincipal();
    const m = await makeMandate(p);
    const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: policyDeps.publicKeyB64 });
    const attempts: string[] = [];
    const brain = new ScriptedBuyerBrain([
      (ctx: Record<string, unknown>) => {
        for (const f of [() => void ((ctx as { ceilingPrice: string }).ceilingPrice = "999.00"), () => void (ctx.history as unknown[]).push({}), () => void ((ctx.task as Record<string, unknown>).description = "x")]) {
          try {
            f();
            attempts.push("MUTATED");
          } catch {
            attempts.push("BLOCKED");
          }
        }
        return { kind: "walk_away", reason: "probe" };
      },
    ]);
    await runNegotiation({ db: prisma, buyer: new BuyerAgent(brain), seller: lab_seller(lab), policy: policyDeps, maxRounds: 4 }, { dealId: deal.id, principalId: p.id, brief: { description: "x", criteria: LAB_CRITERIA as never, deadline: new Date(Date.now() + 86_400_000 * 300).toISOString(), targetPrice: "20.00" } });
    add("ISO-5", "The buyer agent's context is deep-frozen: attempts to alter its ceiling, history or task throw", attempts.length === 3 && attempts.every((a) => a === "BLOCKED") ? "PASS" : "FAIL", `attempts: ${attempts.join(",")}`);
  } catch (e) {
    add("ISO-5", "The buyer agent's context is deep-frozen", "FAIL", `probe error: ${(e as Error).message}`);
  }

  // 4. loopback binding
  const addrs = Object.entries(lab.sellers).map(([k, v]) => `${k}=${v.address}`);
  add("ISO-6", "Simulated seller services listen on loopback only", Object.values(lab.sellers).every((s) => s.address === "127.0.0.1") ? "PASS" : "FAIL", addrs.join(", "));

  // 5. what is NOT provided
  add("ISO-LIMIT", "OS-level sandboxing of the seller process", "NOT_PROVIDED", "The seller is a separate process with a minimal environment and import boundaries. It shares the machine and the OS user with the rest of the system, can read any file that user can read, and is not in a container, jail, seccomp profile or VM. It is NOT a secure OS sandbox, and no probe here claims otherwise. In Gates 3-5 the seller supplies data only: no seller code is ever executed by the system.");
  return out;
}

function lab_seller(lab: Lab) {
  return lab.sellers.honest.client;
}
