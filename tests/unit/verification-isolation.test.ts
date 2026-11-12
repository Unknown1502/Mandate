/**
 * Static guarantees for Gate 4: the verification code cannot reach PayPal, the settlement engine's capture/void, the budget code,
 * or run anything from seller data. These check source structure; they say nothing about runtime behaviour on their own.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const importsOf = (f: string) => [...readFileSync(f, "utf8").matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const target = (f: string, spec: string) => relative(ROOT, resolve(dirname(f), spec)).replace(/\\/g, "/");

const files = walk(join(ROOT, "src", "verification"));

describe("verification code is structurally incapable of moving money", () => {
  it("covers the expected files", () => {
    expect(files.map(rel).sort()).toEqual(
      ["src/verification/ai.ts", "src/verification/confusables.ts", "src/verification/contracts.ts", "src/verification/csv.ts", "src/verification/delivery.ts", "src/verification/errors.ts", "src/verification/evidence.ts", "src/verification/language-v2.ts", "src/verification/language.ts", "src/verification/model-gate.ts", "src/verification/model-input.ts", "src/verification/model-runner.ts", "src/verification/pipeline-v2.ts", "src/verification/pipeline.ts", "src/verification/prescan.ts", "src/verification/scope.ts", "src/verification/validators.ts"].sort(),
    );
  });

  it("imports only an explicit allow-list: no PayPal, gateway, settlement engine, budget, mandate store or signing code (the V2 core reads the authorization only through the read-only authorization module)", () => {
    const ALLOWED_REL = new Set([
      "src/domain/canonical", "src/domain/deals", "src/domain/ledger", "src/domain/terms", "src/agents/llm", "src/agents/sanitize", "src/lib/redact",
      // P4: the read-only authorization re-derivation and the pure V2 term / policy modules
      "src/domain/authorization", "src/domain/terms-v2", "src/domain/language-policy",
    ]);
    // none of the verification files reaches the mandate store, the key / signing code, the budget code or the settlement engine directly
    for (const f of files) for (const spec of importsOf(f)) expect(target(f, spec), `${rel(f)} imports ${spec}`).not.toMatch(/src\/domain\/(mandates|mandate-v2|mandate-v2-writer|signing|key-registry|v2-keys|budget|attestation|deal-approval)$|src\/settlement\/|src\/paypal\//);
    const ALLOWED_BARE = new Set(["zod", "node:crypto", "@prisma/client"]);
    for (const f of files) {
      for (const spec of importsOf(f)) {
        if (spec.startsWith(".")) {
          const t = target(f, spec);
          expect(t.startsWith("src/verification/") || ALLOWED_REL.has(t), `${rel(f)} imports ${spec} (${t})`).toBe(true);
        } else {
          expect(ALLOWED_BARE.has(spec), `${rel(f)} imports ${spec}`).toBe(true);
        }
      }
    }
  });

  it("never executes, evaluates or shells out, and never touches the filesystem or builds raw SQL", () => {
    // (?<![.\w]) so RegExp#exec / obj.spawn are not mistaken for process execution
    const banned = /child_process|node:fs|from "fs"|\beval\s*\(|new Function|(?<![.\w])(exec|execSync|spawn|spawnSync|execFile)\s*\(|\$queryRawUnsafe|\$executeRawUnsafe|node:vm|require\(["']vm["']\)/;
    for (const f of [...files, join(ROOT, "src", "settlement", "verification-intake.ts")]) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(banned);
  });

  it("the Gate 2 intake facade imports only the engine's intake, contracts and ledger helpers, and exports no money-moving function", async () => {
    const f = join(ROOT, "src", "settlement", "verification-intake.ts");
    // P4: the intake also re-derives the authorization (read-only) and checks the V2 binding (a pure function in the same directory)
    const allowed = new Set(["src/domain/canonical", "src/domain/ledger", "src/domain/terms-v2", "src/domain/authorization", "src/verification/contracts", "src/settlement/engine", "src/settlement/binding-check"]);
    for (const spec of importsOf(f)) if (spec.startsWith(".")) expect(allowed.has(target(f, spec)), spec).toBe(true);
    const text = readFileSync(f, "utf8");
    // the only engine symbols it may use are the two intake functions and the context types
    const fromEngine = /import \{([^}]+)\} from "\.\/engine"/.exec(text)![1]!.split(",").map((s) => s.trim().replace(/^type\s+/, ""));
    expect(fromEngine.sort()).toEqual(["EngineContext", "EngineResult", "recordReverification", "recordVerification"].sort());
    const mod = await import("@/settlement/verification-intake");
    expect(Object.keys(mod).sort()).toEqual(["sealHash", "submitVerificationToSettlement"]);
  });

  it("no source file builds SQL or shell commands from data (raw-SQL helpers are absent from src/)", () => {
    for (const f of walk(join(ROOT, "src"))) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/\$queryRawUnsafe|\$executeRawUnsafe|child_process/);
  });
});
