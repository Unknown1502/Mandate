/**
 * Repeatable benchmark of the deterministic skeptic's processing limits (docs/14 §14.21).
 *   npm run bench:prescan                # prints a table and writes attack-lab/reports/bench-prescan.json
 *   npm run bench:prescan -- --check     # exits non-zero if a limit does not hold (used as a regression check)
 *
 * Three families of input, all through the real CSV parser and the real prescan:
 *   NORMAL     ordinary deliveries                                  -> must complete, no SCAN_INCOMPLETE
 *   ADMISSIBLE the worst shapes that fit the 200,000-byte intake cap -> must complete, no SCAN_INCOMPLETE, and quickly
 *   OVER-LIMIT in-memory inputs far larger than intake can admit    -> must STOP with SCAN_INCOMPLETE within a bounded time
 * Timing is wall-clock on THIS machine and varies run to run by several seconds on the largest inputs; the work-unit counts are exact and machine-independent.
 */
import { cpus, platform, release, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../src/verification/contracts";
import { parseCsv, toCsv } from "../src/verification/csv";
import { DEFAULT_PRESCAN_BUDGET, prescan, scanUnits } from "../src/verification/prescan";

const check = process.argv.includes("--check");
type Mk = (i: number, j: number) => string;
const headersOf = (n: number) => Array.from({ length: n }, (_, j) => `c${j}`);

/** the largest CSV (by rows) that still fits the intake byte cap */
function fitToIntake(cols: number, mk: Mk): string {
  const headers = headersOf(cols);
  const rows: string[][] = [];
  let text = toCsv(headers, rows);
  for (let i = 0; i < 10_000; i++) {
    rows.push(Array.from({ length: cols }, (_, j) => mk(i, j)));
    const candidate = toCsv(headers, rows);
    if (Buffer.byteLength(candidate, "utf8") > DEFAULT_MAX_ARTIFACT_BYTES) break;
    text = candidate;
  }
  return text;
}
const inMemory = (rows: number, cols: number, mk: Mk) => ({ headers: headersOf(cols), rows: Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => mk(i, j))) });

interface Result {
  family: "NORMAL" | "ADMISSIBLE" | "OVER-LIMIT";
  name: string;
  bytes: number | null;
  cells: number;
  units: number;
  parseMs: number | null;
  scanMs: number;
  complete: boolean;
  flags: string[];
}
const results: Result[] = [];

function runText(family: Result["family"], name: string, text: string) {
  const t0 = performance.now();
  const csv = parseCsv(text);
  const t1 = performance.now();
  const flags = prescan({ csv, sha12: "abcdef012345" });
  const t2 = performance.now();
  results.push({ family, name, bytes: Buffer.byteLength(text, "utf8"), cells: csv.rows.reduce((n, r) => n + r.filter((c) => c !== "").length, 0), units: scanUnits(csv), parseMs: Math.round(t1 - t0), scanMs: Math.round(t2 - t1), complete: !flags.some((f) => f.code === "SCAN_INCOMPLETE"), flags: [...new Set(flags.map((f) => f.code))] });
}
function runMem(family: Result["family"], name: string, csv: ReturnType<typeof inMemory>) {
  const t0 = performance.now();
  const flags = prescan({ csv, sha12: "abcdef012345" });
  const t1 = performance.now();
  results.push({ family, name, bytes: null, cells: csv.rows.reduce((n, r) => n + r.filter((c) => c !== "").length, 0), units: scanUnits(csv), parseMs: null, scanMs: Math.round(t1 - t0), complete: !flags.some((f) => f.code === "SCAN_INCOMPLETE"), flags: [...new Set(flags.map((f) => f.code))] });
}

runText("NORMAL", "500 honest rows (id, email, date)", toCsv(["id", "email", "joined"], Array.from({ length: 500 }, (_, i) => [String(i), `user${i}@example.com`, "2024-03-01"])));
runText("NORMAL", "300 rows of international names and addresses", toCsv(["name", "address", "city"], Array.from({ length: 300 }, (_, i) => [["Александр Иванов", "محمد علي", "María García", "김민수"][i % 4]!, `Calle ${i} 12, Madrid`, ["Москва", "Madrid", "Paris", "北京"][i % 4]!])));
runText("ADMISSIBLE", "100 columns of 1 character (max cell count)", fitToIntake(100, () => "a"));
runText("ADMISSIBLE", "100 columns, short ASCII words", fitToIntake(100, (i, j) => `w${(i * 7 + j) % 97}`));
runText("ADMISSIBLE", "20 columns, 36-char ASCII prose", fitToIntake(20, (i) => `Customer ${i} prefers email contact now`));
runText("ADMISSIBLE", "10 columns, Cyrillic prose (non-ASCII)", fitToIntake(10, (i) => `Это длинное предложение номер ${i} здесь`));
runText("ADMISSIBLE", "100 columns, 1 Cyrillic letter", fitToIntake(100, () => "я"));
runText("ADMISSIBLE", "100 columns, 'ignore' trigger words (every cell hits)", fitToIntake(100, () => "ignore the update"));
runMem("OVER-LIMIT", "10,000 x 100 numeric (1M cells, ~7 MB)", inMemory(10_000, 100, (i, j) => String(i * 1000 + j)));
runMem("OVER-LIMIT", "10,000 x 100 short text (1M cells)", inMemory(10_000, 100, (i, j) => `Name${j} Surname${i}`));
runMem("OVER-LIMIT", "10,000 x 100 trigger-heavy ASCII (1M cells)", inMemory(10_000, 100, () => "please ignore the update"));
runMem("OVER-LIMIT", "10,000 x 100 Cyrillic prose (1M cells, the reported 32 s case)", inMemory(10_000, 100, (i) => `Это длинное предложение номер ${i} здесь`));

const env = { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1), budget: DEFAULT_PRESCAN_BUDGET, intakeCapBytes: DEFAULT_MAX_ARTIFACT_BYTES, at: new Date().toISOString() };
console.log(`environment: ${JSON.stringify(env)}\n`);
console.log("family      | cells    | units    | bytes    | parse ms | scan ms | complete | input");
for (const r of results) console.log(`${r.family.padEnd(11)} | ${String(r.cells).padStart(8)} | ${String(r.units).padStart(8)} | ${String(r.bytes ?? "-").padStart(8)} | ${String(r.parseMs ?? "-").padStart(8)} | ${String(r.scanMs).padStart(7)} | ${String(r.complete).padEnd(8)} | ${r.name}`);

mkdirSync("attack-lab/reports", { recursive: true });
writeFileSync("attack-lab/reports/bench-prescan.json", JSON.stringify({ environment: env, results }, null, 2) + "\n");

if (check) {
  const bad: string[] = [];
  for (const r of results) {
    if (r.family !== "OVER-LIMIT" && !r.complete) bad.push(`${r.name}: an input within the intake cap did not complete`);
    if (r.family === "OVER-LIMIT" && r.units > DEFAULT_PRESCAN_BUDGET.maxUnits && r.complete) bad.push(`${r.name}: over the work budget but reported complete`);
    if (r.family === "ADMISSIBLE" && r.scanMs > 5000) bad.push(`${r.name}: admissible input took ${r.scanMs} ms (> 5000)`);
    if (r.family === "OVER-LIMIT" && r.scanMs > 15_000) bad.push(`${r.name}: over-limit input took ${r.scanMs} ms (> 15000): the limits did not bound the work`);
  }
  if (bad.length) {
    console.error(`\nFAILED:\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("\nall limits hold");
}
