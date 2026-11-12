/**
 * P1 architecture checks: no read path may bypass the version dispatcher and turn unvalidated parsed JSON into trusted authorization data.
 * STATIC checks over production source (src/ and seller-service/); behaviour is proven by tests/unit/authorization-readers.test.ts and
 * tests/db/authorization-readers.db.test.ts. A future module that parses a mandate / terms / token itself, casts parsed JSON to an authorization type, reads a stored
 * terms object without the dispatcher, or WRITES a new version field fails the build here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMandateDocument, MANDATE_V1_SHAPES } from "@/domain/mandate";

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
const withText = (re: RegExp) => PRODUCTION.filter((f) => re.test(code(read(f))));
const linesOf = (re: RegExp) => PRODUCTION.flatMap((f) => code(read(f)).split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => re.test(x.l)));

describe("JSON text is parsed only where the result is validated before it is trusted", () => {
  it("JSON.parse appears only in the model-output wrapper, the seller client (counterparty body, validated by strict wire schemas) and the two PayPal gateways (external API body, validated by the engine's zod schemas before use)", () => {
    // seller-service/server.ts parses the BUYER's negotiate request inside the separate simulated-seller process (validated by a strict wire schema; not an authorization document)
    expect(withText(/\bJSON\.parse\s*\(/)).toEqual(["seller-service/server.ts", "src/agents/llm.ts", "src/agents/seller-client.ts", "src/paypal/client.ts", "src/paypal/sdk-gateway.ts"]);
  });
  it("the mandate reader and the session reader use the strict, duplicate-key-rejecting parser; nothing else imports it", () => {
    // P2: the V2 seal verifier uses the strict parser. P3: so does the TermsAttestation verifier (the stored signed payload text).
    expect(withText(/from\s+["'](?:\.\.\/lib\/strict-json|\.\/strict-json|@\/lib\/strict-json)["']/)).toEqual(["src/domain/attestation.ts", "src/domain/mandate-v2.ts", "src/domain/mandate.ts", "src/domain/v2-release-gate.ts", "src/lib/http-guard.ts", "src/lib/session.ts", "src/lib/v2-gate-loader.ts"]);
    for (const f of ["src/domain/attestation.ts", "src/domain/mandate.ts", "src/domain/v2-release-gate.ts", "src/lib/session.ts"]) expect(code(read(f)), f).toMatch(/parseStrictJson\s*\(/);
  });
  it("ledger-event payloads (JSON read back from the database) are not cast to a shape, except in the four existing comparison-only reads", () => {
    // Found by mutation (P1-C21): a cast in integrity.ts survived because nothing pinned this. These four reads compare a field of OUR OWN ledger record with strict equality
    // (a value of the wrong type can never equal the expected string), so they cannot grant anything; they are listed so that a NEW cast fails the build.
    const casts = linesOf(/\.payload\s+as\s+\{/).map((x) => x.f);
    expect(casts).toEqual(["src/orchestration/service.ts", "src/settlement/engine.ts", "src/settlement/port.ts", "src/settlement/verification-intake.ts"]);
  });
  it("no parsed JSON is cast to an authorization type", () => {
    expect(linesOf(/\bas\s+(MandateDocument|TermsV1|SessionPayload|SealedMandate)\b/)).toEqual([]);
    expect(linesOf(/<\s*(MandateDocument|TermsV1)\s*>\s*\(?\s*JSON\.parse/)).toEqual([]);
  });
});

describe("every mandate read goes through one opener and one dispatcher", () => {
  it("readMandateDocument / openSealedMandate(Detailed) are called only inside the mandate modules", () => {
    expect(withText(/\breadMandateDocument\s*\(/)).toEqual(["src/domain/mandate.ts"]);
    expect(withText(/\bopenSealedMandate(Detailed)?\s*\(/)).toEqual(["src/domain/mandate.ts", "src/domain/mandates.ts"]);
  });
  it("every other module obtains a mandate through openMandateRow() (P3 version dispatcher); the V1-only verifiedDocument() is used by the mandate module and by negotiation (which fails closed for V2 mandates)", () => {
    expect(withText(/\bopenMandateRow\s*\(/)).toEqual(["src/app/api/mandates/route.ts", "src/domain/authorization.ts", "src/domain/deals.ts", "src/domain/mandates.ts", "src/domain/negotiation.ts", "src/orchestration/integrity.ts", "src/settlement/engine.ts"]);
    expect(withText(/\bverifiedDocument\s*\(/)).toEqual(["src/domain/mandates.ts"]);
  });
  it("the stored mandate text (.canonicalJson) is read only to seal / persist it (mandate modules) or to compare its hash (integrity)", () => {
    // P2: src/domain/mandate-v2.ts reads the envelope field inside an isolated, unconnected verifier
    const uses = linesOf(/\.canonicalJson\b/).filter((x) => !["src/domain/mandate.ts", "src/domain/mandates.ts", "src/domain/mandate-v2.ts", "src/domain/mandate-v2-writer.ts"].includes(x.f));
    expect(uses.map((x) => x.f)).toEqual(["src/orchestration/integrity.ts"]);
    expect(uses[0]!.l).toMatch(/sha256Hex\(\s*deal\.mandate\.canonicalJson\s*\)/);
  });
});

describe("every stored-terms read goes through the version dispatcher", () => {
  it("the strict terms WRITER schema is parsed only where terms are written (terms module, lockTerms, the negotiation draft)", () => {
    expect(withText(/\btermsSchema\s*\.\s*(safeParse|parse)\s*\(/)).toEqual(["src/domain/deals.ts", "src/domain/negotiation.ts", "src/domain/terms.ts"]);
  });
  it("every use of a stored termsJson is a write, a null check, the policy input, or an argument of readTerms / readTermsOrThrow / termsMatchLock", () => {
    const allowed = [
      /termsJson:\s*(terms|parsed)\b/, // lockTerms / lockTermsV2: persisting the normalised, strictly validated terms
      /isObjectWithVersion\(\s*deal\.termsJson\s*\)/, // resolvePreAuthReview: a versioned document can only be approved through the attestation flow
      /(readAnyTerms|readLockedTerms|readLockedTermsOrThrow|termsMatchLockAny)\(\s*deal\.termsJson\b/, // the P3 version dispatchers
      /terms:\s*deal\.termsJson\s*,/, // evaluatePolicy input: the policy engine reads it with readTerms
      /!\s*deal\.termsJson\b/, // null checks
      /(readTerms|readTermsOrThrow|termsMatchLock)\(\s*deal\.termsJson\b/,
    ];
    const bad = linesOf(/\btermsJson\b/).filter((x) => !allowed.some((a) => a.test(x.l)));
    expect(bad).toEqual([]);
    expect(linesOf(/\btermsJson\b/).length).toBeGreaterThanOrEqual(12);
  });
  it("the policy engine reads terms only with the version dispatcher readAnyTerms", () => {
    const s = code(read("src/domain/policy.ts"));
    expect(s).toMatch(/\breadAnyTerms\(\s*i\.terms\s*,/);
    expect(s).not.toMatch(/termsSchema|\breadTerms\(/);
  });
  it("the readers that gate settlement, verification and delivery use the dispatcher (termsMatchLock before any parsed field is used)", () => {
    // P3: settlement re-derives the WHOLE authorization (which includes the locked-terms hash check) through authorizeLoadedDeal; the others use the version-aware matcher
    expect(code(read("src/settlement/engine.ts"))).toMatch(/authorizeLoadedDeal\(/);
    for (const f of ["src/settlement/engine.ts", "src/settlement/verification-intake.ts", "src/verification/delivery.ts", "src/orchestration/integrity.ts"]) {
      expect(code(read(f)), f).toMatch(/termsMatchLockAny\(/);
      expect(code(read(f)), f).not.toMatch(/termsSchema/);
    }
    // the verification pipeline keeps the strict V1 matcher on the V1 branch and dispatches V2 locked terms to the V2 core
    expect(code(read("src/verification/pipeline.ts"))).toMatch(/termsMatchLock\(/);
    expect(code(read("src/verification/pipeline.ts"))).toMatch(/readLockedTerms\(/);
    expect(code(read("src/verification/pipeline.ts"))).not.toMatch(/\btermsSchema\b/);
  });
});

describe("only the named P3 V2 writers can WRITE a versioned authorization document", () => {
  it("schemaVersion is assigned only by the V2 verifier (payload rebuild), the V2 mandate writer and the V2 terms schema; it is mentioned only in the named domain modules", () => {
    expect(new Set(linesOf(/\bschemaVersion\s*:/).map((x) => x.f))).toEqual(new Set(["src/domain/mandate-v2-writer.ts", "src/domain/mandate-v2.ts", "src/domain/negotiation.ts", "src/domain/terms-v2.ts"]));
    expect(withText(/\bschemaVersion\b/)).toEqual(["src/domain/deals.ts", "src/domain/mandate-v2-writer.ts", "src/domain/mandate-v2.ts", "src/domain/mandate.ts", "src/domain/negotiation.ts", "src/domain/policy.ts", "src/domain/terms-v2.ts", "src/domain/terms.ts"]);
  });
  it("the V1 writers (buildMandateDocument / sealMandate / termsSchema) never emit a version field", () => {
    expect(code(read("src/domain/mandate.ts"))).not.toMatch(/schemaVersion\s*:/);
    expect(code(read("src/domain/terms.ts"))).not.toMatch(/schemaVersion\s*:/);
  });
  it("a freshly built mandate document has exactly the V1_FULL keys and passes its own strict reader", async () => {
    const { readMandateDocument } = await import("@/domain/mandate");
    const doc = buildMandateDocument("p1", { currency: "USD", budgetTotal: "10", perDealMax: "5", allowedTaskTypes: ["data_cleaning"], counterparties: ["s"], injectionPolicy: "HUMAN_REVIEW", allowPartialSettlement: false, allowPreDeliveryCancellation: true, expiresAt: "2030-01-01T00:00:00.000Z" } as never);
    expect(Object.keys(doc).sort()).toEqual(["allowPartialSettlement", "allowPreDeliveryCancellation", "allowedTaskTypes", "budgetTotal", "counterparties", "currency", "expiresAt", "injectionPolicy", "perDealMax", "principalId", "requireHumanAbove"]);
    expect(readMandateDocument(JSON.stringify(doc))).toMatchObject({ ok: true, shape: "V1_FULL" });
    expect(MANDATE_V1_SHAPES).toHaveLength(3);
  });
  it("the health route publishes the reader markers so a release check can verify the guarded build is running", () => {
    expect(code(read("src/app/api/health/route.ts"))).toMatch(/authorizationReaders:\s*AUTHORIZATION_READERS/);
  });
});
