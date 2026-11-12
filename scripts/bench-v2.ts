/**
 * V2 benchmark (P5). Offline: MOCK PayPal, SCRIPTED model, the mandate_test database only. No real LLM, no real PayPal.
 *
 *   npm run bench:v2 -- --label <name> [--workflows 1,5,10,20]
 *
 * Part 1 (in-process, no database): the largest admissible artifacts through parse -> deterministic checks -> prescan -> model-view construction -> language assessment.
 * Part 2 (PostgreSQL): N concurrent complete V2 workflows (approve -> order -> authorize -> deliver -> verify -> intake -> settle -> capture) with invariant checks
 * (at most one capture and one settlement per deal, reservations converted, ledger chains intact).
 *
 * Numbers are measurements on THIS machine at THIS time, reported with the environment; they are not capacity claims for any other environment.
 */
import { randomBytes } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// the benchmark uses the TEST database only: DATABASE_URL is replaced by TEST_DATABASE_URL before anything connects, and anything but mandate_test is refused
if (!/\/mandate_test(\?|$)/.test(process.env.TEST_DATABASE_URL ?? "")) throw new Error("bench-v2 refuses to run: TEST_DATABASE_URL must point at the mandate_test database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const label = arg("label") ?? "run";
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(label)) throw new Error("--label must be lowercase letters, digits and dashes");
const out = join("attack-lab", "reports", `bench-v2.${label}.json`);
if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
const workflows = (arg("workflows") ?? "1,5,10,20").split(",").map(Number);

const now = () => performance.now();
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;

async function main() {
  const { parseCsv, DEFAULT_LIMITS } = await import("../src/verification/csv");
  const { runDeterministicChecks } = await import("../src/verification/validators");
  const { prescan } = await import("../src/verification/prescan");
  const { toCsv } = await import("../src/verification/csv");
  const { DEFAULT_MAX_ARTIFACT_BYTES } = await import("../src/verification/contracts");
  const { buildModelInput, deriveModelAuthorization } = await import("../src/verification/model-input");
  const { assessModelInputLanguage } = await import("../src/verification/language-v2");
  const { modelGroups, normalizeTermsV2 } = await import("../src/domain/terms-v2");
  const { llmTermsV2, fakeMandateId } = await import("../tests/helpers/v2Fixtures");
  const { sha256Hex } = await import("../src/domain/canonical");

  const env = { node: process.version, platform: `${platform()} ${release()}`, cpu: `${cpus()[0]?.model ?? "?"} x${cpus().length}`, memGB: Math.round(totalmem() / 2 ** 30) };

  // ---------------------------------------------------------------- Part 1: artifacts at the limits
  const text = "x".repeat(40);
  const cases: Array<{ name: string; headers: string[]; rows: string[][] }> = [
    { name: "max bytes (~200,000 B, 4 columns)", headers: ["customer_id", "email", "description", "delivery_notes"], rows: Array.from({ length: Math.floor(DEFAULT_MAX_ARTIFACT_BYTES / 150) }, (_v, i) => [`c-${i}`, `u${i}@x.com`, `${text} ${i}`, `${text} done`]) },
    { name: "max rows (10,000 rows, 1 column)", headers: ["description"], rows: Array.from({ length: DEFAULT_LIMITS.maxRows }, (_v, i) => [`r${i}`]) },
    { name: "max columns (100 columns, 100 rows)", headers: Array.from({ length: DEFAULT_LIMITS.maxColumns }, (_v, i) => `c${i}`), rows: Array.from({ length: 100 }, (_v, r) => Array.from({ length: DEFAULT_LIMITS.maxColumns }, (_u, c) => `${r}-${c}`)) },
    { name: "max cell length (10,000 chars, 15 rows)", headers: ["customer_id", "email", "description", "delivery_notes"], rows: Array.from({ length: 15 }, (_v, i) => [`c-${i}`, "a@x.com", "d".repeat(DEFAULT_LIMITS.maxFieldLength), "n".repeat(DEFAULT_LIMITS.maxFieldLength)]) },
  ];
  const mid = fakeMandateId();
  const terms = normalizeTermsV2(llmTermsV2(mid));
  const authRes = deriveModelAuthorization(
    { deal: { id: "bench" }, mandate: { version: 2, mandateDigest: "d".repeat(64), keyVersion: "k", doc: { mandateId: mid } }, terms: { version: 2, terms, termsHash: "e".repeat(64) }, attestation: { approvalNonce: "ab".repeat(16) } } as never,
    undefined,
    modelGroups(terms),
  );
  if (!authRes.ok) throw new Error("bench fixture");
  const part1 = cases.map((c) => {
    const csvText = toCsv(c.headers, c.rows);
    const bytes = Buffer.byteLength(csvText, "utf8");
    const t0 = now();
    let parsed;
    try {
      parsed = parseCsv(csvText);
    } catch (e) {
      return { name: c.name, bytes, error: (e as Error).message };
    }
    const tParse = now() - t0;
    const t1 = now();
    runDeterministicChecks([{ id: "schema", text: "t", type: "deterministic", validator: "csv_schema_matches", params: { columns: c.headers.slice(0, 2) }, required: true, weight: 100 }] as never, parsed, sha256Hex(csvText));
    const tChecks = now() - t1;
    const t2 = now();
    const flags = prescan({ csv: parsed, sha12: "0".repeat(12), language: { mode: "OFF" } });
    const tScan = now() - t2;
    const t3 = now();
    const built = buildModelInput({ authorization: authRes.authorization, groupKey: authRes.authorization.groups[0]!.key, role: "verifier", pass: 1, artifact: { csv: parsed, sha12: "0".repeat(12), sha256: "0".repeat(64), deliveryId: "bench" }, deterministic: [] });
    const tBuild = now() - t3;
    let tLang = 0;
    let langBlocked: string | null = null;
    let inputChars = 0;
    if (built.ok) {
      const t4 = now();
      const a = assessModelInputLanguage(built.input);
      tLang = now() - t4;
      langBlocked = a.reason;
      inputChars = built.input.manifest.inputChars;
    }
    return {
      name: c.name,
      bytes,
      rows: parsed.rows.length,
      cols: parsed.headers.length,
      ms: { parse: Math.round(tParse), checks: Math.round(tChecks), prescan: Math.round(tScan), buildModelInput: Math.round(tBuild), languageAssessment: Math.round(tLang) },
      prescanFlags: flags.map((f) => f.code),
      modelView: built.ok ? { inputChars, languageBlocked: langBlocked } : { refused: built.code },
    };
  });
  const tooBig = Buffer.byteLength(toCsv(["a"], Array.from({ length: DEFAULT_MAX_ARTIFACT_BYTES }, () => ["xx"])), "utf8");

  // ---------------------------------------------------------------- Part 2: concurrent workflows
  const { prisma, v2Authorized, makeV2Ctx, deliverV2, csvBuf, V2_HEADERS, V2_ROWS, runnerFor, RecordingModel, verdictReply, v2Deps, llmTerms } = await import("../tests/db/v2Fixtures");
  const { MockPayPal } = await import("../tests/helpers/mockPayPal");
  const { verifyDelivery } = await import("../src/verification/pipeline");
  const { submitVerificationToSettlement } = await import("../src/settlement/verification-intake");
  const { settleDeal } = await import("../src/settlement/engine");
  const { verifyChain } = await import("../src/domain/ledger");

  const pgVersion = (await prisma.$queryRaw<{ version: string }[]>`SELECT version()`)[0]?.version ?? "?";
  const part2: unknown[] = [];
  for (const n of workflows) {
    const lat: number[] = [];
    const ids: string[] = [];
    const wall0 = now();
    const results = await Promise.allSettled(
      Array.from({ length: n }, async () => {
        const t0 = now();
        const mock = new MockPayPal();
        const ctx = makeV2Ctx(mock);
        const base = await v2Authorized(mock, ctx, { terms: llmTerms });
        ids.push(base.dealId);
        const d = await deliverV2(base.dealId, csvBuf(V2_HEADERS, V2_ROWS.map((r) => [...r])));
        if (!d.ok) throw new Error(d.code);
        const model = new RecordingModel(verdictReply("met"));
        const v = await verifyDelivery({ db: prisma, v2: { authz: v2Deps, runner: runnerFor(model) }, claim: { waitMs: 20_000 } }, { dealId: base.dealId });
        await submitVerificationToSettlement(ctx, { dealId: base.dealId, verificationId: v.result.verificationId });
        const s = await settleDeal(ctx, base.dealId);
        lat.push(now() - t0);
        return { captures: mock.writes.filter((w) => w.type === "CAPTURE").length, state: s.state };
      }),
    );
    const wall = now() - wall0;
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r] : []));
    const settlements = await prisma.settlement.count({ where: { dealId: { in: ids } } });
    const converted = await prisma.budgetReservation.count({ where: { dealId: { in: ids }, status: "CONVERTED" } });
    let chainsOk = 0;
    for (const id of ids) if ((await verifyChain(prisma, id)).ok) chainsOk++;
    part2.push({
      concurrentWorkflows: n,
      completed: ok.length,
      failed: results.length - ok.length,
      failures: results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message).slice(0, 120)] : [])).slice(0, 3),
      wallMs: Math.round(wall),
      perWorkflowMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), max: Math.round(Math.max(0, ...lat)) },
      invariants: { capturesPerDealMax: Math.max(0, ...ok.map((r) => r.value.captures)), allCaptured: ok.every((r) => r.value.state === "CAPTURED"), settlements, reservationsConverted: converted, ledgerChainsIntact: `${chainsOk}/${ids.length}` },
    });
  }
  const report = { label, generatedAt: new Date().toISOString(), environment: { ...env, postgres: pgVersion.slice(0, 60), database: "mandate_test", paypal: "MOCK", model: "SCRIPTED" }, limits: { maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES, maxRows: DEFAULT_LIMITS.maxRows, maxColumns: DEFAULT_LIMITS.maxColumns, maxCellChars: DEFAULT_LIMITS.maxFieldLength, oversizedArtifactBytes: tooBig, modelInputMaxChars: 60_000, modelRowsMax: 15, modelFieldsMax: 50 }, part1, part2 };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  void randomBytes;
}
void main();
