/** Final directive part 7: V2 stays disabled until a signed, unexpired, source-bound release record exists. No override exists. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/domain/canonical";
import { createKeyRegistry } from "@/domain/key-registry";
import { generateSigningKeys, signMessage } from "@/domain/signing";
import { GATE_MAX_VALIDITY_MS, GATE_REQUIREMENTS, evaluateV2Gate, gateStillValid, isV2GateOpen, issueReleaseRecord } from "@/domain/v2-release-gate";
import { registryFromSigningKeys } from "@/domain/v2-keys";
import { computeSourceDigest, loadV2Gate } from "@/lib/v2-gate-loader";
import { TEST_SOURCE_DIGEST, openTestGate, testReleaseRecord } from "../helpers/v2Gate";

const keys = generateSigningKeys("gate-1");
const registry = registryFromSigningKeys(keys);
const NOW = new Date();
const ev = (over: Partial<Parameters<typeof evaluateV2Gate>[0]> = {}) => evaluateV2Gate({ optedIn: true, record: testReleaseRecord(keys), registry, now: NOW, runtimeSourceDigest: TEST_SOURCE_DIGEST, ...over });
const reasons = (d: ReturnType<typeof ev>) => (d.open ? [] : d.reasons);

describe("evaluateV2Gate", () => {
  it("opens only for a valid signed record whose source digest equals the running code, and says which requirements it covers", () => {
    const d = ev();
    expect(d.open).toBe(true);
    if (d.open) {
      expect(d.gate.requirements).toEqual([...GATE_REQUIREMENTS]);
      expect(isV2GateOpen(d.gate)).toBe(true);
      expect(Object.isFrozen(d.gate)).toBe(true);
    }
  });
  it("is closed without the deployment opt-in, without a record, and for a malformed record", () => {
    expect(reasons(ev({ optedIn: false }))).toEqual(["NOT_OPTED_IN"]);
    expect(reasons(ev({ record: null }))).toEqual(["NO_RECORD"]);
    for (const bad of ["x", 1, [], {}, { payloadJson: "{}", signature: "x" }, { ...testReleaseRecord(keys), extra: 1 }]) expect(reasons(ev({ record: bad })), JSON.stringify(bad).slice(0, 40)).toEqual(["RECORD_MALFORMED"]);
  });
  it("an altered payload, a flipped signature, a foreign key, a disabled / revoked key all keep it closed", () => {
    const r = testReleaseRecord(keys);
    const p = JSON.parse(r.payloadJson) as Record<string, unknown>;
    expect(reasons(ev({ record: { ...r, payloadJson: canonicalJson({ ...p, sourceDigest: "f".repeat(64) }) } }))).toEqual(["SIGNATURE_INVALID"]);
    expect(reasons(ev({ record: { ...r, signature: r.signature.slice(0, 5) + (r.signature[5] === "A" ? "B" : "A") + r.signature.slice(6) } }))).toEqual(["SIGNATURE_INVALID"]);
    expect(reasons(ev({ registry: registryFromSigningKeys(generateSigningKeys("gate-1")) }))).toEqual(["SIGNATURE_INVALID"]);
    expect(reasons(ev({ registry: createKeyRegistry([]) }))).toEqual(["KEY_NOT_TRUSTED"]);
    expect(reasons(ev({ registry: registryFromSigningKeys(keys, "DISABLED") }))).toEqual(["KEY_NOT_TRUSTED"]);
    expect(reasons(ev({ registry: registryFromSigningKeys(keys, "REVOKED") }))).toEqual(["KEY_NOT_TRUSTED"]);
  });
  it("a non-canonical (re-ordered but correctly signed) payload is refused", () => {
    const r = testReleaseRecord(keys);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r.payloadJson) as object).reverse()));
    expect(reasons(ev({ record: { payloadJson: reordered, signature: signMessage(reordered, keys.privateKeyB64) } }))).toEqual(["RECORD_NON_CANONICAL"]);
  });
  it("expiry, a future issue time and an over-long validity close it", () => {
    expect(reasons(ev({ now: new Date(NOW.getTime() + 8 * 86_400_000) }))).toEqual(["RECORD_EXPIRED"]);
    expect(reasons(ev({ now: new Date(NOW.getTime() - 3_600_000) }))).toEqual(["RECORD_NOT_YET_VALID"]);
    const p = JSON.parse(testReleaseRecord(keys).payloadJson) as { issuedAt: string };
    const long = canonicalJson({ ...p, expiresAt: new Date(new Date(p.issuedAt).getTime() + GATE_MAX_VALIDITY_MS + 86_400_000).toISOString() });
    expect(reasons(ev({ record: { payloadJson: long, signature: signMessage(long, keys.privateKeyB64) } }))).toEqual(["RECORD_VALIDITY_TOO_LONG"]);
    const base = JSON.parse(testReleaseRecord(keys).payloadJson) as Record<string, unknown>;
    expect(() => issueReleaseRecord({ ...base, issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + GATE_MAX_VALIDITY_MS + 1000).toISOString() } as never, keys)).toThrow(/30 days/);
  });
  it("the record must be for the code that is running", () => {
    expect(reasons(ev({ runtimeSourceDigest: "c".repeat(64) }))).toEqual(["SOURCE_DIGEST_MISMATCH"]);
    expect(reasons(ev({ runtimeSourceDigest: null }))).toEqual(["SOURCE_DIGEST_UNAVAILABLE"]);
  });
  it("every requirement must be PASS with evidence: a record missing one, or carrying FAIL, cannot even be parsed", () => {
    const p = JSON.parse(testReleaseRecord(keys).payloadJson) as { validations: Record<string, unknown> };
    for (const req of GATE_REQUIREMENTS) {
      const missing = canonicalJson({ ...p, validations: Object.fromEntries(Object.entries(p.validations).filter(([k]) => k !== req)) });
      expect(reasons(ev({ record: { payloadJson: missing, signature: signMessage(missing, keys.privateKeyB64) } })), `missing ${req}`).toEqual(["RECORD_MALFORMED"]);
      const failed = canonicalJson({ ...p, validations: { ...p.validations, [req]: { status: "FAIL", evidenceSha256: "b".repeat(64) } } });
      expect(reasons(ev({ record: { payloadJson: failed, signature: signMessage(failed, keys.privateKeyB64) } })), `failed ${req}`).toEqual(["RECORD_MALFORMED"]);
    }
  });
  it("a gate cannot be forged or kept past its expiry", () => {
    const forged = { kind: "V2GateOpen", sourceDigest: TEST_SOURCE_DIGEST, expiresAt: new Date(Date.now() + 1e9).toISOString(), requirements: [...GATE_REQUIREMENTS] };
    expect(isV2GateOpen(forged)).toBe(false);
    expect(isV2GateOpen({ ...openTestGate(keys, registry) })).toBe(false);
    const g = openTestGate(keys, registry);
    expect(gateStillValid(g, new Date())).toBe(true);
    expect(gateStillValid(g, new Date(Date.now() + 30 * 86_400_000))).toBe(false);
    expect(gateStillValid(undefined, new Date())).toBe(false);
    expect(gateStillValid(forged as never, new Date())).toBe(false);
  });
  it("never throws on hostile input", () => {
    for (const rec of [Symbol("x"), () => 1, new Proxy({}, { get: () => { throw new Error("boom"); } })]) expect(() => ev({ record: rec })).not.toThrow();
  });
});

describe("loader (composition root)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  const digest = computeSourceDigest(dir)!;
  const rec = (d: string) => {
    const p = JSON.parse(testReleaseRecord(keys).payloadJson) as Record<string, unknown>;
    const payloadJson = canonicalJson({ ...p, sourceDigest: d });
    return { payloadJson, signature: signMessage(payloadJson, keys.privateKeyB64) };
  };
  const file = join(dir, "v2-release.json");
  it("the source digest is stable and changes with any source byte", () => {
    expect(computeSourceDigest(dir)).toBe(digest);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    expect(computeSourceDigest(dir)).not.toBe(digest);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    expect(computeSourceDigest(dir)).toBe(digest);
    expect(computeSourceDigest(join(dir, "nowhere"))).toBeNull();
  });
  it("opens only with BOTH the opt-in and a valid record for this tree; either alone, or a stale tree, keeps it closed", () => {
    writeFileSync(file, JSON.stringify(rec(digest)));
    const env = { MANDATE_V2_ENABLED: "true", MANDATE_V2_RELEASE_RECORD: file };
    expect(loadV2Gate(env, registry, NOW, dir).open).toBe(true);
    expect(loadV2Gate({ MANDATE_V2_RELEASE_RECORD: file }, registry, NOW, dir)).toMatchObject({ open: false, reasons: ["NOT_OPTED_IN"] });
    for (const v of ["TRUE", "1", "yes", "", undefined]) expect(loadV2Gate({ MANDATE_V2_ENABLED: v, MANDATE_V2_RELEASE_RECORD: file }, registry, NOW, dir).open, String(v)).toBe(false);
    expect(loadV2Gate({ MANDATE_V2_ENABLED: "true" }, registry, NOW, dir)).toMatchObject({ open: false, reasons: ["NO_RECORD"] });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n");
    expect(loadV2Gate(env, registry, NOW, dir)).toMatchObject({ open: false, reasons: ["SOURCE_DIGEST_MISMATCH"] });
    writeFileSync(file, "{ not json");
    expect(loadV2Gate(env, registry, NOW, dir).open).toBe(false);
    writeFileSync(file, '{"payloadJson":"x","payloadJson":"y"}');
    expect(loadV2Gate(env, registry, NOW, dir).open).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("no override exists", () => {
  it("the gate module and the loader read no environment variable (the opt-in is read only by the loader's caller-supplied env) and export no setter or bypass", async () => {
    const { readFileSync } = await import("node:fs");
    const gate = readFileSync(join(__dirname, "../../src/domain/v2-release-gate.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(gate).not.toMatch(/process\.env|node:fs|setGate|bypass|override|forceOpen|testOnly/i);
    const exported = [...gate.matchAll(/export\s+(?:const|function|type|interface)\s+(\w+)/g)].map((m) => m[1]).sort();
    expect(exported).toEqual(["GATE_CLOSED_REASONS", "GATE_MAX_VALIDITY_MS", "GATE_PURPOSE", "GATE_REQUIREMENTS", "GateClosedReason", "GateRequirement", "ReleaseRecord", "ReleaseRecordPayload", "V2GateDecision", "V2GateOpen", "digestOfLines", "evaluateV2Gate", "gateStillValid", "isV2GateOpen", "issueReleaseRecord", "releaseRecordPayloadSchema", "releaseRecordSchema"].sort());
    const loader = readFileSync(join(__dirname, "../../src/lib/v2-gate-loader.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(loader).not.toMatch(/process\.env/);
  });
});
