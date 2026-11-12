/**
 * Final QA Stage G: V2 release-gate NEGATIVE validation.   npx tsx --env-file=.env.local scripts/qa-stage-g.ts [--label final-release-readiness-2]
 *
 * Builds NO release record, valid or fake: the only records handed to the real loader are garbage, empty, unsigned or structurally invalid files (they must all keep the
 * gate closed). The record-semantics negatives (stale, future, over-long, wrong tree, missing/failed requirement, bad evidence, revoked key ...) are exercised by
 * tests/unit/v2-release-gate.test.ts and mutation Layer F; this script only adds the environment/loader/entry-point cases and runs no database.
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyRegistry } from "../src/domain/key-registry";
import { loadV2Gate, computeSourceDigest } from "../src/lib/v2-gate-loader";
import { approveMandateV2, V2DisabledError } from "../src/domain/mandate-v2-writer";
import { detectorPermission } from "../src/domain/detector-registry";
import { shippedDetector } from "../src/verification/language";
import { generateSigningKeys } from "../src/domain/signing";
import { registryFromSigningKeys } from "../src/domain/v2-keys";
import { openMandateRow } from "../src/domain/mandates";

const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1]! : "final-release-readiness-2";
const results: { id: string; ok: boolean; detail?: unknown }[] = [];
const check = (id: string, ok: boolean, detail?: unknown) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${!ok && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 240) : ""}`);
};
const closed = (d: ReturnType<typeof loadV2Gate>) => d.open === false;
const reasons = (d: ReturnType<typeof loadV2Gate>) => (d.open ? [] : d.reasons);

const empty = createKeyRegistry([]);
const appRegistry = registryFromSigningKeys(generateSigningKeys("qa-g-ephemeral"));

// G1 the real, current environment
check("G1 MANDATE_V2_ENABLED is not set to true in the current environment", process.env.MANDATE_V2_ENABLED !== "true", { value: process.env.MANDATE_V2_ENABLED ?? "(unset)" });
check("G1 MANDATE_V2_RELEASE_RECORD is not set in the current environment", !process.env.MANDATE_V2_RELEASE_RECORD);
const real = loadV2Gate(process.env, appRegistry);
check("G1 the loader, run against the real environment and tree, is CLOSED", closed(real), reasons(real));

// G2 no release record exists anywhere in the project tree (outside node_modules / .next / reports)
const found: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    if (["node_modules", ".next", ".git"].includes(e)) continue;
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.json$/i.test(e) && s.size < 200_000 && !p.includes(`${join("attack-lab", "reports")}`) && !p.includes(join("docs", "qa"))) {
      try { if (readFileSync(p, "utf8").includes('"v2-release-gate"') && /payloadJson/.test(readFileSync(p, "utf8"))) found.push(p); } catch { /* unreadable */ }
    }
  }
};
walk(process.cwd());
check("G2 no signed V2 release record file exists in the project tree", found.length === 0, found);

// G3 opt-in flag matrix with NO record: always closed
for (const v of [undefined, "", "false", "FALSE", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
  const d = loadV2Gate({ MANDATE_V2_ENABLED: v }, appRegistry);
  check(`G3 opt-in value ${JSON.stringify(v)} without a record is closed`, closed(d), reasons(d));
}
const exactOptInNoRecord = loadV2Gate({ MANDATE_V2_ENABLED: "true" }, appRegistry);
check("G3 opt-in exactly 'true' but no record: closed (opt-in alone never opens)", closed(exactOptInNoRecord), reasons(exactOptInNoRecord));

// G4 hostile / invalid record files, with the opt-in on: all closed. None of these is a signed record.
const tmp = mkdtempSync(join(tmpdir(), "qa-gate-"));
const fakeSig = "A".repeat(86) + "==";
const files: Record<string, string> = {
  "missing.json": "",
  "empty.json": "",
  "garbage.json": "this is not json {{{",
  "empty-object.json": "{}",
  "array.json": "[]",
  "null.json": "null",
  "unsigned.json": JSON.stringify({ payloadJson: "{}", signature: "" }),
  "bad-signature.json": JSON.stringify({ payloadJson: "{\"purpose\":\"v2-release-gate\"}", signature: fakeSig }),
  "extra-field.json": JSON.stringify({ payloadJson: "{}", signature: fakeSig, override: true }),
  "duplicate-keys.json": '{"payloadJson":"{}","payloadJson":"{}","signature":"' + fakeSig + '"}',
  "huge.json": "x".repeat(40_000),
};
for (const [name, text] of Object.entries(files)) {
  const path = join(tmp, name);
  if (name !== "missing.json") writeFileSync(path, text);
  const d = loadV2Gate({ MANDATE_V2_ENABLED: "true", MANDATE_V2_RELEASE_RECORD: path }, appRegistry);
  check(`G4 opt-in on + record '${name.replace(".json", "")}' is closed`, closed(d), reasons(d));
  const d2 = loadV2Gate({ MANDATE_V2_ENABLED: "true", MANDATE_V2_RELEASE_RECORD: path }, empty);
  check(`G4 same with an EMPTY trust registry is closed`, closed(d2), reasons(d2));
}
rmSync(tmp, { recursive: true, force: true });

// G5 source-tree mismatch: a root without a src directory yields no digest, so nothing can match
const noTree = mkdtempSync(join(tmpdir(), "qa-gate-notree-"));
check("G5 a root without a source tree has no digest (null)", computeSourceDigest(noTree) === null);
const d5 = loadV2Gate({ MANDATE_V2_ENABLED: "true" }, appRegistry, new Date(), noTree);
check("G5 opt-in on + unknown source tree is closed", closed(d5), reasons(d5));
rmSync(noTree, { recursive: true, force: true });

// G6 the V2 writer refuses without an OPEN gate, before touching the database (the db object throws on any use)
const hostileDb = new Proxy({}, { get: () => { throw new Error("DATABASE TOUCHED"); } }) as never;
const keys = generateSigningKeys("qa-g-writer");
const base = { principalId: "p", principalEmail: "p@example.com", draft: {}, confirmDigest: "0".repeat(64), keys };
const futureIso = new Date(Date.now() + 86_400_000).toISOString();
const attempts: [string, unknown][] = [
  ["no gate", undefined],
  ["empty object posing as a gate", {}],
  ["object with a future expiry posing as a gate", { expiresAt: futureIso, requirements: ["P2", "P3", "P4", "P5", "P7", "SECURITY_REGRESSION"] }],
  ["JSON-cloned gate-looking object", JSON.parse(JSON.stringify({ open: true, expiresAt: futureIso }))],
];
for (const [name, gate] of attempts) {
  try {
    await approveMandateV2(hostileDb, { ...base, v2Gate: gate as never });
    check(`G6 approveMandateV2 with ${name}: refused`, false, "ACCEPTED");
  } catch (e) {
    check(`G6 approveMandateV2 with ${name}: refused with V2DisabledError, database untouched`, e instanceof V2DisabledError, String((e as Error).message).slice(0, 80));
  }
}

// G7 V2 mandate rows do not open without a gate (hostile row; no database)
const row = { id: "c" + "a".repeat(24), principalId: "p", sealVersion: 2, mandateNonce: "a".repeat(32), canonicalJson: "{}", mandateDigest: "0".repeat(64), approvedBy: "x", approvedAt: new Date(), approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION", keyVersion: "k", signature: fakeSig, detectorId: null, detectorVersion: null, detectorVocabularyHash: null } as never;
check("G7 openMandateRow(V2 row) without a gate returns null", openMandateRow(row, { publicKeyB64: "x", registry: appRegistry }) === null);
check("G7 openMandateRow(V2 row) with a gate-shaped forged object returns null", openMandateRow(row, { publicKeyB64: "x", registry: appRegistry, v2Gate: { expiresAt: futureIso } as never }) === null);

// G8 detector 1.1.0 cannot be pinned by a new mandate while it has no verified RELEASED release
const shipped = shippedDetector();
const emptySnapshot = { releases: [], rejected: [] };
check("G8 shipped detector is 1.1.0", shipped.version === "1.1.0", shipped);
check("G8 NEW_PIN of the shipped detector is refused with no release", detectorPermission(emptySnapshot, shipped, "NEW_PIN")(shipped, ["en", "fr", "zh"]) === false);
check("G8 EXISTING_PIN of the shipped detector is also refused with no release", detectorPermission(emptySnapshot, shipped, "EXISTING_PIN")(shipped, ["en"]) === false);
check("G8 a different detector triple is refused", detectorPermission(emptySnapshot, shipped, "NEW_PIN")({ ...shipped, version: "9.9.9" }) === false);

const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(process.cwd(), "docs", "qa", `${label}.stage-g.json`), JSON.stringify({ label, ranAt: new Date().toISOString(), total: results.length, failed, results }, null, 2) + "\n");
console.log(`\nStage G script: ${results.length - failed}/${results.length} checks passed; evidence docs/qa/${label}.stage-g.json`);
process.exitCode = failed ? 1 : 0;
