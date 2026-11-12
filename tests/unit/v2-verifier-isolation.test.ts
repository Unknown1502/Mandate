/**
 * Architecture proof for the V2 seal verifier. STATIC checks over production source. P2 proved it was isolated; P3 connects it, deliberately and narrowly:
 *   1. the set of modules that may import the V2 verifier / key registry is PINNED (the domain modules that write, open and bind V2 documents). The verifier function is
 *      referenced only by the mandate opener (openMandateRow) and the writer's pre-persist self-check; no live layer (settlement, orchestration, verification, agents,
 *      HTTP routes, PayPal, database) names the V2 seal modules at all;
 *   2. the verifier's whole import closure contains no settlement, PayPal, database, orchestration, verification, agent or HTTP code, so even a future caller could not
 *      make it trigger a payment;
 *   3. it can only VERIFY: no signing function, no private key, no environment access, no network, no document creation;
 *   4. its result type is not assignable to the V1 document the policy and settlement engines consume (compile-time, in tests/unit/mandate-v2-seal.test.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_READERS } from "@/domain/compat";

const ROOT = resolve(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|js|mjs)$/.test(n) ? [p] : [];
  });
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const PRODUCTION = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "seller-service"))].map(rel).sort();
const V2 = "src/domain/mandate-v2.ts";
const REG = "src/domain/key-registry.ts";

const importsOf = (file: string): string[] => [...code(read(file)).matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1]!);
const resolveRel = (from: string, spec: string) => {
  const base = resolve(ROOT, dirname(from), spec);
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    try {
      if (statSync(base + ext).isFile()) return rel(base + ext);
    } catch {
      /* try next */
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
};
function closure(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of importsOf(f)) {
      if (spec.startsWith(".")) todo.push(resolveRel(f, spec));
      else bare.add(spec);
    }
  }
  return { files: [...files].sort(), bare: [...bare].sort() };
}

describe("1. who may reach the V2 verifier and the key registry (P3)", () => {
  it("the importers of mandate-v2 / key-registry are exactly the named domain modules", () => {
    const importers = PRODUCTION.filter((f) => /from\s+["'][^"']*(?:mandate-v2|key-registry)["']/.test(code(read(f))));
    expect(importers).toEqual([
      "src/domain/attestation.ts", "src/domain/deals.ts", "src/domain/detector-registry.ts", "src/domain/language-policy.ts", "src/domain/mandate-v2-writer.ts", "src/domain/mandate-v2.ts", "src/domain/mandates.ts",
      "src/domain/policy.ts", "src/domain/terms-v2.ts", "src/domain/v2-keys.ts", "src/domain/v2-release-gate.ts", "src/lib/v2-gate-loader.ts",
    ]);
    expect(code(read(V2)).match(/from\s+["'][^"']*key-registry["']/g)).toHaveLength(1);
  });
  it("verifyV2MandateSeal is referenced only by the mandate opener and the writer's self-check; the registry constructor is used by the registry and the key helper", () => {
    expect(PRODUCTION.filter((f) => /\bverifyV2MandateSeal\b/.test(code(read(f))))).toEqual(["src/domain/mandate-v2-writer.ts", V2, "src/domain/mandates.ts"]);
    expect(PRODUCTION.filter((f) => /\bcreateKeyRegistry\b|\bEMPTY_KEY_REGISTRY\b/.test(code(read(f))))).toEqual([REG, "src/domain/v2-keys.ts"]);
    expect(code(read("src/domain/mandates.ts")).match(/verifyV2MandateSeal\(/g)).toHaveLength(1);
  });
  it("none of the live layers names the V2 seal modules or the V2 document type (settlement, orchestration, verification, agents, HTTP routes, PayPal, database, ledger, negotiation)", () => {
    const live = PRODUCTION.filter((f) => /^src\/(settlement|orchestration|verification|agents|app|paypal|db)\//.test(f) || ["src/domain/negotiation.ts", "src/domain/ledger.ts"].includes(f));
    expect(live.length).toBeGreaterThan(20);
    for (const f of live) expect(read(f), f).not.toMatch(/mandate-v2|key-registry|MandateDocumentV2|verifyV2MandateSeal/);
  });
  it("the deployed reader markers say what is connected", () => {
    expect(AUTHORIZATION_READERS).toMatchObject({ v2Writers: "mandate+terms+attestation", v2SealVerifier: "connected-via-opener", mandateShapes: ["V1_FULL", "V1_NO_CANCELLATION_FLAG", "V1_BASE"], termsVersions: [1, 2], mandateSealVersions: [1, 2] });
  });
});

describe("2. the verifier's import closure cannot reach money, the database, the network or any live layer", () => {
  const c = closure(V2);
  it("is exactly the small pure set it needs", () => {
    expect(c.files).toEqual(["src/domain/canonical.ts", "src/domain/key-registry.ts", "src/domain/mandate-v2.ts", "src/domain/mandate.ts", "src/domain/money.ts", "src/domain/signing.ts", "src/lib/strict-json.ts"]);
  });
  it("uses only zod and node:crypto from outside the repository", () => {
    expect(c.bare).toEqual(["decimal.js", "node:crypto", "zod"].filter((x) => c.bare.includes(x)));
    expect(c.bare.every((b) => ["decimal.js", "node:crypto", "zod"].includes(b))).toBe(true);
  });
  it("contains no settlement, PayPal, database, orchestration, verification, agent, ledger or HTTP module", () => {
    for (const f of c.files) expect(f, f).not.toMatch(/^src\/(settlement|orchestration|verification|agents|app|paypal|db)\/|ledger|deals|negotiation|policy|mandates\.ts/);
  });
});

describe("3. the verifier can only VERIFY", () => {
  const v2 = code(read(V2));
  const reg = code(read(REG));
  it("imports only verifyMessage from the signing module (no signMessage, no key generation, no key loading)", () => {
    const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\/signing["']/.exec(v2);
    expect(m).not.toBeNull();
    expect(m![1]!.split(",").map((x) => x.trim()).filter(Boolean)).toEqual(["verifyMessage"]);
  });
  it("contains no signing, private-key, key-generation, environment, filesystem, network or database code", () => {
    for (const [name, s] of [["mandate-v2", v2], ["key-registry", reg]] as const) {
      expect(s, name).not.toMatch(/\bsignMessage\b|\bcrypto\.sign\b|\bcreateSign\b|\bcreatePrivateKey\b|\bgenerateKeyPair(?:Sync)?\b|\bgenerateSigningKeys\b|\bloadSigningKeys\b|privateKey|PRIVATE_KEY|PKCS8|pkcs8/);
      expect(s, name).not.toMatch(/process\.env|\bfetch\s*\(|node:http|node:https|node:net|node:fs|child_process|\bimport\s*\(|require\s*\(|prisma|@prisma/);
    }
  });
  it("imports from node:crypto only the primitives it needs", () => {
    const names = (s: string) => (/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/.exec(s)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort();
    expect(names(v2)).toEqual(["createHash", "timingSafeEqual"]);
    expect(names(reg)).toEqual(["createHash", "createPublicKey"]);
  });
  it("exports exactly two functions: the verifier and the pure payload REBUILDER the writer shares (no key, no signing); no sealer, signer or writer lives in this module", () => {
    const fns = [...v2.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
    expect(fns).toEqual(["buildV2SignedPayload", "verifyV2MandateSeal"]);
    const regFns = [...reg.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]).sort();
    expect(regFns).toEqual(["createKeyRegistry", "publicKeyFingerprint"]);
    expect(v2).not.toMatch(/export\s+(?:const|function)\s+(?:seal|sign|create|write|issue|mint|make)\w*/i);
    // the signer is a separate module; the verifier module never gains a private key, even through the shared builder
    expect(code(read("src/domain/mandate-v2-writer.ts"))).toMatch(/\bsignMessage\b/);
  });
  it("compares digests, identifiers, nonces, fingerprints and signatures only in constant time or by cryptographic verification", () => {
    const stripped = v2.replace(/typeof\s+[\w.?]+\s*[!=]==\s*"[a-z]+"/g, "").replace(/[!=]==\s*(?:undefined|null)\b/g, "");
    const offenders = stripped.split("\n").filter((l) => /(mandateDigest|mandateId|\bnonce\b|fingerprint|signature)\b[^;]*[!=]==|[!=]==[^;]*(mandateDigest|mandateId|\.nonce|fingerprint|signature)\b/.test(l));
    expect(offenders).toEqual([]);
    expect(v2).toMatch(/timingSafeEqual\(/);
    expect((v2.match(/constantTimeEqual\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it("takes verification keys only from the registry argument (no key field is read from the document or the envelope)", () => {
    expect(v2).toMatch(/ctx\.registry\.lookup\(env\.keyVersion\)/);
    expect(v2).not.toMatch(/\b(?:doc|env|raw|value|json|input)\??\.publicKey/);
    expect(v2.match(/verifyMessage\(/g)).toHaveLength(1);
    expect(v2).toMatch(/verifyMessage\(message,\s*env\.signature,\s*rec\.publicKeyB64\)/);
  });
});
