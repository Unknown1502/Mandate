/**
 * Issue the signed V2 release record AFTER the QA campaign (final directive part 7). NOT run by the build: nobody has authorized V2 to be enabled.
 *
 *   npx tsx --env-file=.env.local scripts/issue-v2-release.ts --evidence qa-evidence.json --out v2-release.json [--days 14]
 *
 * qa-evidence.json:  { "P2": [ {kind, path}, ... ], "P3": [...], "P4": [...], "P5": [...], "P7": [...], "SECURITY_REGRESSION": [...], "securitySuites": ["..."] }
 *   kind "vitest-json"   a report written by  vitest run --reporter=json --outputFile=<path>   (must say success: true and contain no failed test)
 *   kind "mutation-json" a mutation layer report from attack:mutate:layers                      (must have survived = invalid = unreached = 0 and killed > 0)
 * The tool refuses to sign unless EVERY requirement has at least one passing evidence file; the signed record carries the sha256 of the evidence it rests on and the digest
 * of the current source tree. The private key is read from the environment and never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../src/domain/canonical";
import { loadSigningKeys } from "../src/domain/signing";
import { GATE_REQUIREMENTS, GATE_MAX_VALIDITY_MS, issueReleaseRecord } from "../src/domain/v2-release-gate";
import { computeSourceDigest } from "../src/lib/v2-gate-loader";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const evidencePath = arg("evidence");
const outPath = arg("out");
if (!evidencePath || !outPath) throw new Error("--evidence and --out are required");
if (existsSync(resolve(outPath))) throw new Error(`refusing to overwrite ${outPath}`);
const days = Math.min(Number(arg("days") ?? "14"), 30);

type Entry = { kind: "vitest-json" | "mutation-json"; path: string };
const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8")) as Record<string, unknown>;

function check(e: Entry): { ok: boolean; sha: string; why: string } {
  const raw = readFileSync(resolve(e.path), "utf8");
  const sha = createHash("sha256").update(raw).digest("hex");
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (e.kind === "vitest-json") {
    const ok = j.success === true && j.numFailedTests === 0 && Number(j.numTotalTests) > 0;
    return { ok, sha, why: ok ? "" : `vitest report not green (${String(j.numFailedTests)} failed of ${String(j.numTotalTests)})` };
  }
  const c = (j.counts ?? {}) as Record<string, number>;
  const ok = Number(c.killed) > 0 && c.survived === 0 && c.invalid === 0 && c.unreached === 0 && j.srcRestoredByteForByte === true;
  return { ok, sha, why: ok ? "" : "mutation report has survivors / invalid / unreached mutants or src was not restored" };
}

const validations: Record<string, { status: "PASS"; evidenceSha256: string }> = {};
for (const req of GATE_REQUIREMENTS) {
  const list = evidence[req];
  if (!Array.isArray(list) || list.length === 0) throw new Error(`no evidence for ${req}`);
  const shas: string[] = [];
  for (const e of list as Entry[]) {
    const r = check(e);
    if (!r.ok) throw new Error(`${req}: ${e.path}: ${r.why}`);
    shas.push(r.sha);
  }
  validations[req] = { status: "PASS", evidenceSha256: createHash("sha256").update(canonicalJson(shas.sort())).digest("hex") };
}
const digest = computeSourceDigest();
if (!digest) throw new Error("source tree not found");
const now = new Date();
const record = issueReleaseRecord(
  {
    sourceDigest: digest,
    issuedAt: now.toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + days * 86_400_000, now.getTime() + GATE_MAX_VALIDITY_MS)).toISOString(),
    validations: validations as never,
    securitySuites: (evidence.securitySuites as string[]) ?? [],
  },
  loadSigningKeys(process.env),
);
writeFileSync(resolve(outPath), JSON.stringify(record, null, 2));
console.log(`release record written to ${outPath} (source digest ${digest.slice(0, 12)}..., valid ${days} days)`);
