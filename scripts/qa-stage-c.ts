/**
 * Final QA Stage C: migration, fixture and recovery validation on DISPOSABLE PostgreSQL databases only.
 *
 *   npx tsx --env-file=.env.local scripts/qa-stage-c.ts [--label final-release-readiness-2]
 *
 * It creates three databases named mandate_qa_c_<yyMMddHHmmss>_{a,rb,rs} on the local Docker PostgreSQL (127.0.0.1:55432, container mandate-pg), and never opens
 * `mandate`, `mandate_test` or any other database for writing (mandate_test / mandate are only COUNTED read-only before and after, to show they were not touched).
 * The credentials in DATABASE_URL are used to connect; the database name in it is ignored. Nothing here prints a secret.
 *   a   migrated database: first the 6 pre-V2 migrations, V1 fixtures, snapshot, then the 3 V2 migrations, V2 fixtures and constraint tests
 *   rb  clone of `a` on which the DOCUMENTED rollback (drop scripts) is executed, then the migrations are rolled forward again
 *   rs  restore of the pre-migration snapshot (backup-restore recovery, a different thing from a schema rollback), then rolled forward
 * V2 fixtures are inserted directly with EPHEMERAL keys and verified by the pure verifiers; no V2 release record is created and no V2 operational flow is run
 * (the V2 mandate opener correctly returns null while the gate is closed, and that is asserted).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { canonicalJson, sha256Hex } from "../src/domain/canonical";
import { beginNegotiation, checkPolicy, createDeal, lockTerms, reserveForDeal, type PolicyDeps } from "../src/domain/deals";
import { approveMandate, openMandateRow, previewMandate } from "../src/domain/mandates";
import { readMandateDocument, sealMandate, type MandateDocument } from "../src/domain/mandate";
import { verifyV2MandateSeal } from "../src/domain/mandate-v2";
import { buildUnsignedAttestation, signAttestation, verifyTermsAttestation, type AttestationBinding } from "../src/domain/attestation";
import { createKeyRegistry } from "../src/domain/key-registry";
import { generateSigningKeys, signMessage } from "../src/domain/signing";
import { languagePolicyHashOf, mappingHashV2, normalizeTermsV2, termsHashV2, readLockedTerms } from "../src/domain/terms-v2";
import { termsMatchLockAny } from "../src/domain/terms-v2";
import { registryFromSigningKeys } from "../src/domain/v2-keys";
import { GOLDEN_V2 } from "../tests/helpers/v2GoldenVectors";
import { goldenDocument, recordFor, sealV2 } from "../tests/helpers/v2Seal";
import { llmTermsV2 } from "../tests/helpers/v2Fixtures";
import { MANDATE_FIXTURES, TERMS_FIXTURES } from "../tests/helpers/legacyFixtures";

const argv = process.argv.slice(2);
const label = argv.includes("--label") ? argv[argv.indexOf("--label") + 1]! : "final-release-readiness-2";
const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
const NAME = { a: `mandate_qa_c_${stamp}_a`, rb: `mandate_qa_c_${stamp}_rb`, rs: `mandate_qa_c_${stamp}_rs` };
const DISPOSABLE = /^mandate_qa_c_\d{12}_(a|rb|rs)$/;

// ------------------------------------------------------------------------------------------------------------------------ connection safety (C1)
const base = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(base.hostname) || base.port !== "55432") throw new Error("Stage C refuses to run: the database server must be the local Docker PostgreSQL on 127.0.0.1:55432");
const user = decodeURIComponent(base.username);
const pw = decodeURIComponent(base.password);
const urlFor = (db: string) => {
  const u = new URL(base.toString());
  u.pathname = `/${db}`;
  u.search = "";
  return u.toString();
};
const isDisposable = (db: string) => DISPOSABLE.test(db);
const client = (db: string) => new PrismaClient({ datasourceUrl: urlFor(db), log: [] });

const evidence: Record<string, unknown> = { label, startedAt: new Date().toISOString(), databases: NAME, checks: [] as unknown[] };
const checks = evidence.checks as { id: string; ok: boolean; detail: unknown }[];
let failures = 0;
function check(id: string, ok: boolean, detail: unknown = null) {
  checks.push({ id, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail !== null && !ok ? "  " + JSON.stringify(detail).slice(0, 300) : ""}`);
}

// ------------------------------------------------------------------------------------------------------------------------ helpers
const prismaCli = resolve(ROOT, "node_modules/prisma/build/index.js");
const sh = (args: string[], url: string) => execFileSync(process.execPath, [prismaCli, ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const dockerPg = (args: string[], input?: string) =>
  execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD", "mandate-pg", ...args], { env: { ...process.env, PGPASSWORD: pw }, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const schemaDump = (db: string) =>
  dockerPg(["pg_dump", "-U", user, "-s", "--no-owner", "--no-privileges", db])
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("--") && !l.startsWith("SET ") && !l.startsWith("\\") && !l.startsWith("SELECT pg_catalog.set_config"))
    .join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const errText = (e: unknown) => String((e as { message?: string }).message ?? e).replace(/\s+/g, " ");

async function adminDo(sql: string) {
  const admin = client("postgres");
  try {
    await admin.$executeRawUnsafe(sql);
  } finally {
    await admin.$disconnect();
  }
}
async function createDb(name: string, template?: string) {
  if (!isDisposable(name)) throw new Error(`refusing to create non-disposable database ${name}`);
  await adminDo(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
}
async function dropDb(name: string) {
  if (!isDisposable(name)) throw new Error(`refusing to drop non-disposable database ${name}`);
  await adminDo(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
async function counts(db: PrismaClient, tables: string[]) {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
  return out;
}
/** hash of the OLD columns of a table (the column list is fixed from before the V2 migrations, so added columns cannot change it) */
async function tableHash(db: PrismaClient, table: string, cols: string[]) {
  const list = cols.map((c) => `"${c}"`).join(", ");
  const r = await db.$queryRawUnsafe<{ h: string }[]>(`SELECT COALESCE(encode(sha256(convert_to(string_agg(row(${list})::text, '|' ORDER BY "id"), 'UTF8')), 'hex'), 'empty') AS h FROM "${table}"`);
  return r[0]!.h;
}
async function columnsOf(db: PrismaClient, table: string) {
  const r = await db.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position`);
  return r.map((x) => x.column_name);
}
async function rejects(db: PrismaClient, id: string, sql: string, expectPart: RegExp) {
  try {
    await db.$executeRawUnsafe(sql);
    check(id, false, "statement was ACCEPTED");
  } catch (e) {
    const m = errText(e);
    check(id, expectPart.test(m), m.slice(0, 200));
  }
}

const STATE_TABLES = ["User", "Mandate", "Deal"];
const OLD_COLS: Record<string, string[]> = {};

async function main() {
  // C1: identity of the servers and of the databases not to be touched (read-only counts)
  const probeTargets = ["mandate", "mandate_test"];
  const untouchedBefore: Record<string, Record<string, number>> = {};
  for (const n of probeTargets) {
    const c = client(n);
    try {
      untouchedBefore[n] = await counts(c, ["Mandate", "Deal", "DealEvent"]);
    } catch (e) {
      untouchedBefore[n] = { error: -1 };
    } finally {
      await c.$disconnect();
    }
  }
  evidence.untouchedBefore = untouchedBefore;

  // ---------------------------------------------------------------------------------------------------------------- phase 1: pre-V2 schema + V1 fixtures
  await createDb(NAME.a);
  const tmp = mkdtempSync(join(tmpdir(), "qa-stage-c-"));
  mkdirSync(join(tmp, "prisma", "migrations"), { recursive: true });
  cpSync(join(ROOT, "prisma", "schema.prisma"), join(tmp, "prisma", "schema.prisma"));
  cpSync(join(ROOT, "prisma", "migrations", "migration_lock.toml"), join(tmp, "prisma", "migrations", "migration_lock.toml"));
  const allMigrations = readdirSync(join(ROOT, "prisma", "migrations")).filter((n) => /^\d{14}_/.test(n)).sort();
  const V2_START = "20261108120000_v2_authorization";
  const oldOnes = allMigrations.filter((n) => n < V2_START);
  const newOnes = allMigrations.filter((n) => n >= V2_START);
  for (const m of oldOnes) cpSync(join(ROOT, "prisma", "migrations", m), join(tmp, "prisma", "migrations", m), { recursive: true });
  sh(["migrate", "deploy", "--schema", join(tmp, "prisma", "schema.prisma")], urlFor(NAME.a));
  const a = client(NAME.a);
  const ident = (await a.$queryRawUnsafe<{ db: string; v: string }[]>(`SELECT current_database() AS db, version() AS v`))[0]!;
  check("C1 target is the newly created disposable database", ident.db === NAME.a && isDisposable(ident.db), { database: ident.db, server: ident.v.slice(0, 40) });
  evidence.databaseIdentity = { name: ident.db, host: "127.0.0.1:55432 (container mandate-pg)", postgres: ident.v.slice(0, 40) };
  const hist0 = await a.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM _prisma_migrations ORDER BY started_at`);
  check("C3 pre-V2 history is exactly the 6 older migrations", hist0.length === oldOnes.length, hist0.map((x) => x.migration_name));
  for (const t of STATE_TABLES) OLD_COLS[t] = await columnsOf(a, t);

  // V1 fixtures, raw SQL (the application's Prisma model no longer matches this schema), sealed with an EPHEMERAL key
  const v1 = generateSigningKeys("qa-v1-1");
  const other = generateSigningKeys("qa-other-1");
  const approval = { approvedBy: "qa-principal@disposable.invalid", approvedAt: "2026-11-01T10:00:00.000Z", approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION" };
  const seeded: { id: string; shape: string; kind: string }[] = [];
  const insertMandate = async (id: string, doc: MandateDocument, s: { canonicalJson: string; mandateDigest: string; keyVersion: string; signature: string }) => {
    await a.$executeRaw`INSERT INTO "User"(id, email) VALUES (${doc.principalId}, ${doc.principalId + "@disposable.invalid"}) ON CONFLICT (id) DO NOTHING`;
    await a.$executeRaw`INSERT INTO "Mandate"(id, "principalId", currency, "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", counterparties, "injectionPolicy", "expiresAt",
      "canonicalJson", "mandateDigest", "approvedBy", "approvedAt", "approvalMethod", "keyVersion", signature)
      VALUES (${id}, ${doc.principalId}, ${doc.currency}, ${doc.budgetTotal}::numeric, ${doc.perDealMax}::numeric, ${doc.requireHumanAbove}::numeric, ${doc.allowedTaskTypes}::text[], ${doc.counterparties}::text[],
      ${doc.injectionPolicy}, ${new Date(doc.expiresAt)}, ${s.canonicalJson}, ${s.mandateDigest}, ${approval.approvedBy}, ${new Date(approval.approvedAt)}, ${approval.approvalMethod}, ${s.keyVersion}, ${s.signature})`;
  };
  for (const [i, f] of MANDATE_FIXTURES.entries()) {
    const doc = JSON.parse(f.canonicalJson) as MandateDocument;
    const sealed = sealMandate(doc, approval, v1);
    check(`C2 V1 golden serialization: ${f.shape} re-canonicalises to the stored text and digest`, sealed.canonicalJson === f.canonicalJson && sealed.mandateDigest === f.digest);
    check(`C2 V1 shape recognised: ${f.shape}`, (() => { const r = readMandateDocument(f.canonicalJson); return r.ok && r.shape === f.shape; })());
    const id = `qa-v1-valid-${i}`;
    await insertMandate(id, doc, sealed);
    seeded.push({ id, shape: f.shape, kind: "valid" });
  }
  {
    const f = MANDATE_FIXTURES[2]!;
    const doc = JSON.parse(f.canonicalJson) as MandateDocument;
    const sealed = sealMandate(doc, approval, v1);
    const tamperedText = f.canonicalJson.replace('"budgetTotal":"100.00"', '"budgetTotal":"900.00"');
    await insertMandate("qa-v1-tamper-text", doc, { ...sealed, canonicalJson: tamperedText }); // digest + signature of the ORIGINAL text
    seeded.push({ id: "qa-v1-tamper-text", shape: "V1_FULL", kind: "digest-mismatch" });
    const newDigest = sha256Hex(tamperedText);
    await insertMandate("qa-v1-tamper-sig", doc, { ...sealed, canonicalJson: tamperedText, mandateDigest: newDigest }); // digest recomputed, signature stale
    seeded.push({ id: "qa-v1-tamper-sig", shape: "V1_FULL", kind: "signature-invalid" });
    const foreign = sealMandate(doc, approval, other);
    await insertMandate("qa-v1-foreign-key", doc, foreign); // validly signed by a key that is not the application key
    seeded.push({ id: "qa-v1-foreign-key", shape: "V1_FULL", kind: "unknown-key" });
  }
  // locked terms (legacy fixtures) attached to the valid mandates, plus one whose stored hash was changed
  const dealIds: string[] = [];
  for (const [i, t] of TERMS_FIXTURES.entries()) {
    const id = `qa-v1-deal-${i}`;
    const mandateId = seeded[i % 3]!.id;
    const tamperedHash = i === TERMS_FIXTURES.length - 1 ? "0".repeat(64) : t.hash;
    await a.$executeRaw`INSERT INTO "Deal"(id, "mandateId", state, "sellerId", "termsJson", "termsHash", price, deadline, "updatedAt")
      VALUES (${id}, ${mandateId}, 'TERMS_LOCKED'::"DealState", 'seller-sim', ${JSON.stringify(t.terms)}::jsonb, ${tamperedHash}, ${String((t.terms as { price: string }).price)}::numeric, ${new Date("2029-01-01T00:00:00.000Z")}, now())`;
    dealIds.push(id);
  }
  const pre = {
    counts: await counts(a, STATE_TABLES),
    hashes: Object.fromEntries(await Promise.all(STATE_TABLES.map(async (t) => [t, await tableHash(a, t, OLD_COLS[t]!)]))),
  };
  evidence.preMigration = pre;
  check("C2 V1 fixtures seeded (3 valid, 3 tampered/foreign, deals with legacy terms)", pre.counts.Mandate === 6 && pre.counts.Deal === TERMS_FIXTURES.length, pre.counts);

  // C1: clean pre-migration backup + schema snapshot
  const preSchema = schemaDump(NAME.a);
  dockerPg(["pg_dump", "-U", user, "-Fc", "-f", `/tmp/${NAME.a}.pre.dump`, NAME.a]);
  evidence.preSchemaSha256 = sha(preSchema);

  // ---------------------------------------------------------------------------------------------------------------- phase 2: apply the V2 migrations
  const out = sh(["migrate", "deploy"], urlFor(NAME.a));
  check("C3 migrate deploy applied exactly the 3 V2 migrations", newOnes.every((m) => out.includes(m)), out.split(/\r?\n/).filter((l) => l.includes("2026110")).slice(-5));
  const hist1 = await a.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`);
  check("C3 migration history complete (9 finished, none rolled back)", hist1.length === allMigrations.length && hist1.every((h) => h.finished_at && !h.rolled_back_at));
  const postSchema = schemaDump(NAME.a);
  evidence.postSchemaSha256 = sha(postSchema);
  const post = {
    counts: await counts(a, STATE_TABLES),
    hashes: Object.fromEntries(await Promise.all(STATE_TABLES.map(async (t) => [t, await tableHash(a, t, OLD_COLS[t]!)]))),
  };
  evidence.postMigration = post;
  check("C3 V1 row counts unchanged by the migrations", JSON.stringify(pre.counts) === JSON.stringify(post.counts));
  check("C3 V1 row content (all pre-existing columns) byte-identical after the migrations", JSON.stringify(pre.hashes) === JSON.stringify(post.hashes), { pre: pre.hashes, post: post.hashes });
  const defaults = await a.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "Mandate" WHERE "sealVersion"=1 AND "schemaVersion"=1 AND "mandateNonce" IS NULL AND "languagePolicyHash" IS NULL`);
  check("C3 every existing mandate got the V1 defaults (sealVersion 1, no nonce)", Number(defaults[0]!.n) === 6);

  // ---------------------------------------------------------------------------------------------------------------- V1 readers on migrated data (real application code)
  await a.$disconnect();
  const db = client(NAME.a);
  const v1ctx = { publicKeyB64: v1.publicKeyB64 };
  for (const s of seeded) {
    const row = await db.mandate.findUniqueOrThrow({ where: { id: s.id } });
    const opened = openMandateRow(row, v1ctx);
    if (s.kind === "valid") check(`C3 V1 ${s.shape} opens (version 1) after migration`, opened?.version === 1 && opened.doc.principalId === row.principalId);
    else check(`C3 V1 ${s.kind} mandate refused (fail closed) after migration`, opened === null);
  }
  for (const [i, id] of dealIds.entries()) {
    const d = await db.deal.findUniqueOrThrow({ where: { id } });
    const locked = readLockedTerms(d.termsJson);
    const tampered = i === dealIds.length - 1;
    check(`C3 V1 locked terms ${i} ${tampered ? "with a changed stored hash fail the lock check" : "read and match their lock"}`, locked.ok === true && termsMatchLockAny(d.termsJson, d.termsHash ?? "") === !tampered);
  }

  // V1 behaviour with the real engine on the migrated schema: concurrent reservations must not overspend
  const deps: PolicyDeps = { publicKeyB64: v1.publicKeyB64, maxRounds: 4 };
  const principal = await db.user.create({ data: { email: `qa-p-${randomBytes(4).toString("hex")}@disposable.invalid` } });
  const draft = { currency: "USD", budgetTotal: "100", perDealMax: "60", allowedTaskTypes: ["data_cleaning"], counterparties: ["seller-sim"], injectionPolicy: "HUMAN_REVIEW", expiresAt: "2030-01-01T00:00:00.000Z" };
  const prev = previewMandate(principal.id, draft);
  const sealedRow = await approveMandate(db, { principalId: principal.id, principalEmail: "qa@disposable.invalid", draft, confirmDigest: prev.digest, keys: v1 });
  const ready: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await createDeal(db, { principalId: principal.id, mandateId: sealedRow.id, sellerId: "seller-sim", publicKeyB64: v1.publicKeyB64 });
    await beginNegotiation(db, d.id, "buyer-agent", principal.id);
    await lockTerms(db, {
      dealId: d.id,
      principalId: principal.id,
      actor: "buyer-agent",
      terms: { taskType: "data_cleaning", description: "Clean the CSV", criteria: [{ id: "schema", text: "Columns match", type: "deterministic", validator: "csv_schema_matches", params: { columns: ["id"] }, required: true, weight: 100 }], price: "60.00", currency: "USD", deadline: "2029-01-01T00:00:00.000Z", sellerId: "seller-sim", mandateId: sealedRow.id },
    });
    const r = await checkPolicy(db, { dealId: d.id, deps, principalId: principal.id });
    if (r.outcome === "OK") ready.push(d.id);
  }
  const results = await Promise.all(ready.map((id) => reserveForDeal(db, { dealId: id, deps, principalId: principal.id })));
  const okCount = results.filter((r) => r.ok).length;
  const reserved = await db.budgetReservation.aggregate({ _sum: { amount: true }, where: { mandateId: sealedRow.id, status: "ACTIVE" } });
  check("C3 concurrent V1 budget reservations (3 x 60.00 against a 100.00 budget): exactly one succeeds, no overspend", ready.length === 3 && okCount === 1 && Number(reserved._sum.amount ?? 0) <= 100, { ready: ready.length, ok: okCount, reserved: String(reserved._sum.amount) });

  // ---------------------------------------------------------------------------------------------------------------- V2 storage integrity (direct inserts, ephemeral keys, pure verifiers)
  const k2 = generateSigningKeys(GOLDEN_V2.keyVersion);
  const reg = registryFromSigningKeys(k2);
  const doc = goldenDocument();
  const env = sealV2(doc, { keys: k2 });
  const expected = { mandateId: doc.mandateId as string, nonce: doc.nonce as string };
  check("C2 V2 golden document digest matches the frozen vector", env.mandateDigest === GOLDEN_V2.documentDigest);
  const good = verifyV2MandateSeal(env, { registry: reg, expected });
  check("C3 valid V2 seal verifies through the key registry", good.ok === true);
  const variants: [string, Record<string, unknown>, Parameters<typeof verifyV2MandateSeal>[1]][] = [
    ["digest mismatch", { ...env, mandateDigest: "f".repeat(64) }, { registry: reg, expected }],
    ["signature tampered", { ...env, signature: env.signature.slice(0, -4) + (env.signature.endsWith("AAA=") ? "BBB=" : "AAA=") }, { registry: reg, expected }],
    ["unknown key version", { ...env, keyVersion: "no-such-key" }, { registry: reg, expected }],
    ["revoked key", env, { registry: createKeyRegistry([recordFor(k2, "REVOKED")]), expected }],
    ["unknown envelope field", { ...env, extra: 1 }, { registry: reg, expected }],
    ["malformed envelope (no signature)", Object.fromEntries(Object.entries(env).filter(([k]) => k !== "signature")), { registry: reg, expected }],
    ["row identity mismatch (wrong mandate id)", env, { registry: reg, expected: { ...expected, mandateId: "c" + "z".repeat(24) } }],
    ["nonce mismatch", env, { registry: reg, expected: { ...expected, nonce: "f".repeat(32) } }],
    ["not canonical (reordered text)", sealV2(doc, { keys: k2, text: JSON.stringify(doc, null, 1) }), { registry: reg, expected }],
  ];
  const v2Codes: Record<string, string> = {};
  for (const [name, e, ctx] of variants) {
    const r = verifyV2MandateSeal(e, ctx);
    v2Codes[name] = r.ok ? "ACCEPTED" : r.code;
    check(`C3 V2 seal refused: ${name}`, !r.ok, r.ok ? "accepted" : r.code);
  }
  evidence.v2RefusalCodes = v2Codes;

  const sha2 = (s: string) => sha256Hex(s);
  const principalId = doc.principalId as string;
  await db.user.create({ data: { id: principalId, email: "principal@example.com" } });
  const lp = doc.languagePolicy as { detector: { id: string; version: string; vocabularyHash: string } };
  await db.$executeRaw`INSERT INTO "Mandate"(id, "principalId", currency, "budgetTotal", "perDealMax", "requireHumanAbove", "allowedTaskTypes", counterparties, "injectionPolicy", "expiresAt",
    "canonicalJson", "mandateDigest", "approvedBy", "approvedAt", "approvalMethod", "keyVersion", signature, "sealVersion", "schemaVersion", "languagePolicyHash", "mandateNonce", "detectorId", "detectorVersion", "detectorVocabularyHash")
    VALUES (${expected.mandateId}, ${principalId}, ${doc.currency}, ${doc.budgetTotal}::numeric, ${doc.perDealMax}::numeric, ${doc.requireHumanAbove}::numeric, ${doc.allowedTaskTypes}::text[], ${doc.counterparties}::text[],
    ${doc.injectionPolicy}, ${new Date(doc.expiresAt)}, ${env.canonicalJson}, ${env.mandateDigest}, ${env.approvedBy}, ${new Date(env.approvedAt)}, ${env.approvalMethod}, ${env.keyVersion}, ${env.signature},
    2, 2, ${sha2(canonicalJson(doc.languagePolicy))}, ${expected.nonce}, ${lp.detector.id}, ${lp.detector.version}, ${lp.detector.vocabularyHash})`;
  const v2row = await db.mandate.findUniqueOrThrow({ where: { id: expected.mandateId } });
  check("C3 the V2 mandate row opens ONLY through the release gate: openMandateRow returns null while the gate is closed", openMandateRow(v2row, { publicKeyB64: v1.publicKeyB64, registry: reg }) === null);
  await rejects(db, "C3 DB CHECK refuses a V2 mandate with a malformed nonce", `UPDATE "Mandate" SET "mandateNonce"='zz' WHERE id='${expected.mandateId}'`, /Mandate_v2_identity_check/);
  await rejects(db, "C3 DB CHECK refuses a V1-sealed mandate that carries a nonce", `UPDATE "Mandate" SET "mandateNonce"='${"a".repeat(32)}' WHERE id='qa-v1-valid-0'`, /Mandate_v2_identity_check/);
  await rejects(db, "C3 DB CHECK refuses a V2 mandate whose id is not a cuid-shaped id", `INSERT INTO "Mandate"(id,"principalId",currency,"budgetTotal","perDealMax","allowedTaskTypes",counterparties,"expiresAt","canonicalJson","mandateDigest","approvedBy","approvedAt","approvalMethod","keyVersion",signature,"sealVersion","schemaVersion","mandateNonce")
    VALUES ('NOT-A-CUID','${principalId}','USD',1,1,'{}','{}',now(),'x','x','x',now(),'x','x','x',2,2,'${"b".repeat(32)}')`, /Mandate_v2_identity_check/);

  const terms = llmTermsV2(expected.mandateId);
  const nt = normalizeTermsV2(terms);
  const tHash = termsHashV2(terms);
  const binding = (dealId: string, over: Partial<AttestationBinding> = {}): AttestationBinding => ({ dealId, mandateId: expected.mandateId, mandateDigest: env.mandateDigest, termsHash: tHash, termsSchemaVersion: 2, languagePolicyHash: languagePolicyHashOf(terms), mappingHash: mappingHashV2(terms), ...over });
  const newDeal = async (id: string) => {
    await db.$executeRaw`INSERT INTO "Deal"(id, "mandateId", state, "sellerId", "termsJson", "termsHash", price, deadline, "updatedAt", "termsSchemaVersion", "languagePolicyHash")
      VALUES (${id}, ${expected.mandateId}, 'TERMS_LOCKED'::"DealState", 'seller-sim', ${JSON.stringify(nt)}::jsonb, ${tHash}, ${"20.00"}::numeric, ${new Date("2029-01-01T00:00:00.000Z")}, now(), 2, ${languagePolicyHashOf(terms)})`;
    await db.$executeRaw`INSERT INTO "TermsVersion"(id, "dealId", version, "termsSchemaVersion", "termsHash", "termsJson", "lockedBy") VALUES (${"tv-" + id}, ${id}, 1, 2, ${tHash}, ${JSON.stringify(nt)}::jsonb, 'qa')`;
  };
  const attRow = async (dealId: string, nonce: string, over: Record<string, unknown> = {}) => {
    const u = buildUnsignedAttestation(binding(dealId), { keyVersion: k2.keyVersion, actor: { id: principalId, label: "principal@example.com" }, approvalNonce: nonce });
    const s = signAttestation(u, "2026-11-08T12:30:00.000Z", k2);
    return { id: "att-" + dealId + nonce.slice(0, 4), dealId, mandateId: expected.mandateId, mandateDigest: env.mandateDigest, termsHash: tHash, termsSchemaVersion: 2, languagePolicyHash: languagePolicyHashOf(terms), mappingHash: mappingHashV2(terms), approvalKind: "HUMAN_PREAUTH", actorKind: "human", actorId: principalId, approvedAt: new Date("2026-11-08T12:30:00.000Z"), approvalNonce: nonce, keyVersion: k2.keyVersion, payloadJson: s.payloadJson, signature: s.signature, ...over };
  };
  const insAtt = (r: Awaited<ReturnType<typeof attRow>>) =>
    db.$executeRaw`INSERT INTO "TermsAttestation"(id, "dealId", "mandateId", "mandateDigest", "termsHash", "termsSchemaVersion", "languagePolicyHash", "mappingHash", "approvalKind", "actorKind", "actorId", "approvedAt", "approvalNonce", "keyVersion", "payloadJson", signature)
      VALUES (${r.id}, ${r.dealId}, ${r.mandateId}, ${r.mandateDigest}, ${r.termsHash}, ${r.termsSchemaVersion}, ${r.languagePolicyHash}, ${r.mappingHash}, ${r.approvalKind}, ${r.actorKind}, ${r.actorId}, ${r.approvedAt}, ${r.approvalNonce}, ${r.keyVersion}, ${r.payloadJson}, ${r.signature})`;

  await newDeal("qa-v2-deal-1");
  const n1 = randomBytes(16).toString("hex");
  const row1 = await attRow("qa-v2-deal-1", n1);
  await insAtt(row1);
  const stored = await db.termsAttestation.findUniqueOrThrow({ where: { dealId: "qa-v2-deal-1" } });
  const rec = { payloadJson: stored.payloadJson, signature: stored.signature, keyVersion: stored.keyVersion };
  const vctx = (over: Partial<{ registry: typeof reg; expected: AttestationBinding; expectedActorId: string }> = {}) => ({ registry: reg, expected: binding("qa-v2-deal-1"), expectedActorId: principalId, ...over });
  check("C3 stored V2 attestation verifies against the re-derived binding", verifyTermsAttestation(rec, vctx()).ok === true);
  const att = (name: string, r: ReturnType<typeof verifyTermsAttestation>) => check(`C3 V2 attestation refused: ${name}`, !r.ok, r.ok ? "accepted" : r.code);
  att("terms hash differs from the locked terms", verifyTermsAttestation(rec, vctx({ expected: binding("qa-v2-deal-1", { termsHash: "e".repeat(64) }) })));
  att("mandate digest differs", verifyTermsAttestation(rec, vctx({ expected: binding("qa-v2-deal-1", { mandateDigest: "d".repeat(64) }) })));
  att("attestation presented for another deal", verifyTermsAttestation(rec, vctx({ expected: binding("qa-v2-other") })));
  att("actor is not the mandate principal", verifyTermsAttestation(rec, vctx({ expectedActorId: "someone-else" })));
  att("signing key revoked", verifyTermsAttestation(rec, vctx({ registry: createKeyRegistry([recordFor(k2, "REVOKED")]) })));
  att("signing key unknown", verifyTermsAttestation({ ...rec, keyVersion: "no-such-key" }, vctx()));
  att("payload edited after signing", verifyTermsAttestation({ ...rec, payloadJson: rec.payloadJson.replace("HUMAN_PREAUTH", "HUMAN_PREAUTH ") }, vctx()));
  att("malformed signature", verifyTermsAttestation({ ...rec, signature: "not-a-signature" }, vctx()));

  // immutable history, uniqueness, shape checks
  await rejects(db, "C3 attestation is immutable: UPDATE refused", `UPDATE "TermsAttestation" SET "actorId"='x' WHERE "dealId"='qa-v2-deal-1'`, /immutable|forbid|MANDATE/i);
  await rejects(db, "C3 attestation is immutable: DELETE refused", `DELETE FROM "TermsAttestation" WHERE "dealId"='qa-v2-deal-1'`, /immutable|forbid|MANDATE/i);
  await newDeal("qa-v2-deal-2");
  const dup = await attRow("qa-v2-deal-1", randomBytes(16).toString("hex"), { id: "att-dup-deal" });
  try { await insAtt(dup); check("C3 a second attestation for the same deal is refused (unique dealId)", false); } catch (e) { check("C3 a second attestation for the same deal is refused (unique dealId)", /23505|already exists|unique/i.test(errText(e)), errText(e).slice(0, 120)); }
  const reuse = await attRow("qa-v2-deal-2", n1, { id: "att-reuse-nonce" });
  try { await insAtt(reuse); check("C3 a reused approval nonce is refused (unique approvalNonce)", false); } catch (e) { check("C3 a reused approval nonce is refused (unique approvalNonce)", /23505|already exists|unique/i.test(errText(e)), errText(e).slice(0, 120)); }
  const badKind = await attRow("qa-v2-deal-2", randomBytes(16).toString("hex"), { id: "att-bad-kind", approvalKind: "AUTO" });
  try { await insAtt(badKind); check("C3 shape CHECK refuses a non-human / non-HUMAN_PREAUTH attestation", false); } catch (e) { check("C3 shape CHECK refuses a non-human / non-HUMAN_PREAUTH attestation", /TermsAttestation_shape_check/.test(errText(e)), errText(e).slice(0, 120)); }
  // concurrent approvals: 3 separate connections racing to attest ONE deal: exactly one wins
  await newDeal("qa-v2-deal-3");
  const racers = await Promise.all([1, 2, 3].map(async (i) => attRow("qa-v2-deal-3", randomBytes(16).toString("hex"), { id: `att-race-${i}` })));
  const conns = [1, 2, 3].map(() => client(NAME.a));
  const settled = await Promise.allSettled(
    racers.map((r, i) =>
      conns[i]!.$executeRaw`INSERT INTO "TermsAttestation"(id, "dealId", "mandateId", "mandateDigest", "termsHash", "termsSchemaVersion", "languagePolicyHash", "mappingHash", "approvalKind", "actorKind", "actorId", "approvedAt", "approvalNonce", "keyVersion", "payloadJson", signature)
        VALUES (${r.id}, ${r.dealId}, ${r.mandateId}, ${r.mandateDigest}, ${r.termsHash}, ${r.termsSchemaVersion}, ${r.languagePolicyHash}, ${r.mappingHash}, ${r.approvalKind}, ${r.actorKind}, ${r.actorId}, ${r.approvedAt}, ${r.approvalNonce}, ${r.keyVersion}, ${r.payloadJson}, ${r.signature})`,
    ),
  );
  await Promise.all(conns.map((c) => c.$disconnect()));
  const won = settled.filter((s) => s.status === "fulfilled").length;
  const rows3 = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "TermsAttestation" WHERE "dealId"='qa-v2-deal-3'`))[0]!.n);
  check("C3 three concurrent attestations for one deal: exactly one is stored", won === 1 && rows3 === 1, { won, rows3 });
  // terms history
  await rejects(db, "C3 terms history: duplicate (deal, version) refused", `INSERT INTO "TermsVersion"(id,"dealId",version,"termsSchemaVersion","termsHash","termsJson","lockedBy") VALUES ('tv-dup','qa-v2-deal-1',1,2,'${tHash}','{}'::jsonb,'qa')`, /23505|already exists|unique/i);
  await rejects(db, "C3 terms history: malformed hash refused by CHECK", `INSERT INTO "TermsVersion"(id,"dealId",version,"termsSchemaVersion","termsHash","termsJson","lockedBy") VALUES ('tv-bad','qa-v2-deal-1',2,2,'nothex','{}'::jsonb,'qa')`, /TermsVersion_shape_check/);
  await rejects(db, "C3 terms history is immutable: UPDATE refused", `UPDATE "TermsVersion" SET "lockedBy"='x' WHERE id='tv-qa-v2-deal-1'`, /immutable|forbid|MANDATE/i);
  await rejects(db, "C3 terms history is immutable: DELETE refused", `DELETE FROM "TermsVersion" WHERE id='tv-qa-v2-deal-1'`, /immutable|forbid|MANDATE/i);
  // detector pin governance tables
  const dh = "a".repeat(64);
  await db.$executeRawUnsafe(`INSERT INTO "DetectorRelease"(id,"detectorId",version,"vocabularyHash","contentHash","languageCoverage","evaluationDatasetVersion","manifestJson","submittedBy") VALUES ('qa-rel-1','qa-detector','1.0.0','sha256:${dh}','${dh}','{en}','qa','{}'::jsonb,'qa')`);
  await rejects(db, "C3 detector release: illegal transition DRAFT -> RELEASED refused", `UPDATE "DetectorRelease" SET status='RELEASED' WHERE id='qa-rel-1'`, /illegal detector release status transition/);
  await rejects(db, "C3 detector release: content is immutable", `UPDATE "DetectorRelease" SET version='9.9.9' WHERE id='qa-rel-1'`, /immutable/);
  await rejects(db, "C3 detector release: never deleted", `DELETE FROM "DetectorRelease" WHERE id='qa-rel-1'`, /immutable/);
  await rejects(db, "C3 detector release: malformed vocabulary hash refused", `INSERT INTO "DetectorRelease"(id,"detectorId",version,"vocabularyHash","contentHash","languageCoverage","evaluationDatasetVersion","manifestJson","submittedBy") VALUES ('qa-rel-2','qa-detector','1.0.1','nothex','${dh}','{en}','qa','{}'::jsonb,'qa')`, /DetectorRelease_shape_check/);
  await db.$executeRawUnsafe(`UPDATE "DetectorRelease" SET status='EVALUATION' WHERE id='qa-rel-1'`);
  check("C3 detector release: a legal transition DRAFT -> EVALUATION is accepted", true);
  const unregistered = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "DetectorRelease" WHERE "detectorId"='mandate-lexical-detector'`))[0]!.n);
  check("C3 detector 1.1.0 (mandate-lexical-detector) has no release row in this database", unregistered === 0);

  const finalA = { counts: await counts(db, ["User", "Mandate", "Deal", "TermsAttestation", "TermsVersion", "DetectorRelease", "DetectorReleaseEvent", "BudgetReservation"]) };
  evidence.finalA = finalA;
  await db.$disconnect();
  const fullSchemaA = schemaDump(NAME.a);

  // ---------------------------------------------------------------------------------------------------------------- C4 documented rollback on a CLONE
  await createDb(NAME.rb, NAME.a);
  const rb = client(NAME.rb);
  const FK_FIRST = await rb.$executeRawUnsafe(`DELETE FROM "Deal" WHERE "termsSchemaVersion"=2`).then(() => "accepted", (e) => errText(e).slice(0, 160));
  check("C4 the documented order 'withdraw V2 mandates/deals first' is NOT executable as written (attestations and term history reference the deals; attestations are immutable)", FK_FIRST !== "accepted", FK_FIRST);
  const rollback = [
    `DROP TABLE "TermsVersion"`,
    `DROP TABLE "TermsAttestation"`,
    `DELETE FROM "Deal" WHERE "termsSchemaVersion"=2`,
    `DELETE FROM "Mandate" WHERE "sealVersion"=2`,
    `DROP TABLE "DetectorReleaseEvent"`,
    `DROP TABLE "DetectorRelease"`,
    `DROP FUNCTION mandate_detector_release_guard()`,
    `ALTER TABLE "Mandate" DROP CONSTRAINT "Mandate_v2_identity_check", DROP COLUMN "detectorId", DROP COLUMN "detectorVersion", DROP COLUMN "detectorVocabularyHash", DROP COLUMN "sealVersion", DROP COLUMN "schemaVersion", DROP COLUMN "languagePolicyHash", DROP COLUMN "mandateNonce"`,
    `ALTER TABLE "Deal" DROP COLUMN "termsSchemaVersion", DROP COLUMN "languagePolicyHash"`,
    `ALTER TABLE "VerificationRun" DROP COLUMN "termsSchemaVersion", DROP COLUMN "bindingHash"`,
    `ALTER TABLE "AgentRun" DROP COLUMN "inputManifestHash"`,
    `DELETE FROM _prisma_migrations WHERE migration_name IN (${newOnes.map((m) => `'${m}'`).join(",")})`,
  ];
  let rollbackOk = true;
  const rollbackLog: string[] = [];
  for (const s of rollback) {
    try {
      await rb.$executeRawUnsafe(s);
      rollbackLog.push("ok   " + s.slice(0, 90));
    } catch (e) {
      rollbackOk = false;
      rollbackLog.push("FAIL " + s.slice(0, 90) + " :: " + errText(e).slice(0, 160));
    }
  }
  evidence.rollbackLog = rollbackLog;
  check("C4 documented rollback statements all execute on the clone (after dependent tables are dropped first)", rollbackOk, rollbackLog.filter((l) => l.startsWith("FAIL")));
  const rbCounts = await counts(rb, STATE_TABLES);
  // the clone also holds the extra V1 rows created after the snapshot (engine run); the seeded V1 rows are compared by id
  const seededIds = seeded.map((s) => `'${s.id}'`).join(",");
  const rbHash = await rb.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(string_agg(row(${OLD_COLS.Mandate!.map((c) => `"${c}"`).join(",")})::text, '|' ORDER BY "id"), 'UTF8')), 'hex') AS h FROM "Mandate" WHERE id IN (${seededIds})`);
  const preSeedHash = await (async () => {
    const x = client(NAME.a);
    try {
      return (await x.$queryRawUnsafe<{ h: string }[]>(`SELECT encode(sha256(convert_to(string_agg(row(${OLD_COLS.Mandate!.map((c) => `"${c}"`).join(",")})::text, '|' ORDER BY "id"), 'UTF8')), 'hex') AS h FROM "Mandate" WHERE id IN (${seededIds})`))[0]!.h;
    } finally {
      await x.$disconnect();
    }
  })();
  check("C4 after rollback the seeded V1 mandates are byte-identical to before the rollback", rbHash[0]!.h === preSeedHash);
  evidence.rollbackCounts = rbCounts;
  await rb.$disconnect();
  // the rolled-back clone also contains the rows the engine run added; to compare SCHEMA with the pre-migration snapshot, restore the snapshot separately
  await createDb(NAME.rs);
  try {
    dockerPg(["pg_restore", "-U", user, "-d", NAME.rs, "--no-owner", "--no-privileges", `/tmp/${NAME.a}.pre.dump`]);
  } catch (e) {
    evidence.pgRestoreWarnings = errText(e).slice(0, 300); // pg_restore exits non-zero on harmless notices (for example an existing public schema); the checks below decide
  }
  const rsSchema = schemaDump(NAME.rs);
  const rbSchema = schemaDump(NAME.rb);
  check("C4 schema after the documented rollback equals the pre-migration schema", rbSchema === rsSchema && rsSchema === preSchema, { rbSha: sha(rbSchema).slice(0, 12), preSha: sha(preSchema).slice(0, 12), rsSha: sha(rsSchema).slice(0, 12) });
  if (rbSchema !== preSchema) {
    const A = new Set(preSchema.split("\n"));
    const B = new Set(rbSchema.split("\n"));
    evidence.rollbackSchemaDiff = { onlyInPre: [...A].filter((l) => !B.has(l)).slice(0, 20), onlyInRolledBack: [...B].filter((l) => !A.has(l)).slice(0, 20) };
  }
  // restore-based recovery
  const rs = client(NAME.rs);
  const rsCounts = await counts(rs, STATE_TABLES);
  const rsHashes = Object.fromEntries(await Promise.all(STATE_TABLES.map(async (t) => [t, await tableHash(rs, t, OLD_COLS[t]!)])));
  check("C4 backup-restore recovery: restored snapshot has the pre-migration row counts and row content", JSON.stringify(rsCounts) === JSON.stringify(pre.counts) && JSON.stringify(rsHashes) === JSON.stringify(pre.hashes), { rsCounts });
  await rs.$disconnect();
  // roll forward both recovered databases and compare with the migrated database
  sh(["migrate", "deploy"], urlFor(NAME.rb));
  sh(["migrate", "deploy"], urlFor(NAME.rs));
  const cleanSchema = (s: string) => s;
  const fwdRb = cleanSchema(schemaDump(NAME.rb));
  const fwdRs = cleanSchema(schemaDump(NAME.rs));
  check("C4 after rollback + roll-forward the schema equals the migrated schema", fwdRb === postSchema && fwdRb === fullSchemaA, { rb: sha(fwdRb).slice(0, 12), migrated: sha(postSchema).slice(0, 12) });
  check("C4 after restore + roll-forward the schema equals the migrated schema", fwdRs === postSchema, { rs: sha(fwdRs).slice(0, 12), migrated: sha(postSchema).slice(0, 12) });

  // ---------------------------------------------------------------------------------------------------------------- untouched databases, cleanup
  const untouchedAfter: Record<string, Record<string, number>> = {};
  for (const n of probeTargets) {
    const c = client(n);
    try {
      untouchedAfter[n] = await counts(c, ["Mandate", "Deal", "DealEvent"]);
    } catch {
      untouchedAfter[n] = { error: -1 };
    } finally {
      await c.$disconnect();
    }
  }
  evidence.untouchedAfter = untouchedAfter;
  const probeFailed = JSON.stringify([untouchedBefore, untouchedAfter]).includes("\"error\"");
  check("C1 mandate and mandate_test row counts identical before and after (read-only probe, no probe error)", !probeFailed && JSON.stringify(untouchedBefore) === JSON.stringify(untouchedAfter), { untouchedBefore, untouchedAfter });
  rmSync(tmp, { recursive: true, force: true });
  if (!argv.includes("--keep")) for (const n of Object.values(NAME)) await dropDb(n);
  try { dockerPg(["rm", "-f", `/tmp/${NAME.a}.pre.dump`]); } catch { /* best effort */ }
  evidence.droppedDisposableDatabases = !argv.includes("--keep");
  evidence.failures = failures;
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(join(ROOT, "docs", "qa", `${label}.stage-c.json`), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nStage C: ${checks.length - failures}/${checks.length} checks passed; evidence docs/qa/${label}.stage-c.json`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("Stage C aborted:", errText(e).slice(0, 500));
  evidence.aborted = errText(e).slice(0, 500);
  evidence.failures = failures + 1;
  try { writeFileSync(join(ROOT, "docs", "qa", `${label}.stage-c.aborted.json`), JSON.stringify(evidence, null, 2) + "\n"); } catch { /* ignore */ }
  for (const n of Object.values(NAME)) { try { await dropDb(n); } catch { /* ignore */ } }
  process.exitCode = 2;
});
