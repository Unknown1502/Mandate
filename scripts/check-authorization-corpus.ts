/**
 * READ-ONLY compatibility check for the P1 strict readers against STORED data.   npm run check:authorization-corpus
 *
 * Run it against a database BEFORE deploying the guarded readers to it. It reads every Mandate row and every locked Deal.termsJson and reports, per row class, whether the
 * strict readers accept them. It writes nothing, changes nothing, prints no secret (no document text, only counts, shapes and ids of rows that fail).
 *
 * Database: CORPUS_DATABASE_URL if set, otherwise DATABASE_URL. For the test database:  CORPUS_DATABASE_URL=$TEST_DATABASE_URL npm run check:authorization-corpus
 * A mandate whose stored digest does not equal sha256(canonicalJson) is reported separately: openSealedMandate refuses it BEFORE any parsing (DIGEST_MISMATCH), exactly as
 * before P1 (the test suites keep deliberate tamper fixtures of this kind). Signatures are not checked here (the public key is not needed to decide whether a
 * document's SHAPE is readable); this script answers only "would the strict reader accept this stored text?".
 * Exit code 1 if any digest-consistent mandate or any hash-consistent locked terms object is refused by the strict readers.
 */
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../src/domain/canonical";
import { MANDATE_V1_SHAPES, readMandateDocument } from "../src/domain/mandate";
import { criterionSchema, normalizeTerms, readTerms, termsHash, termsSchema } from "../src/domain/terms";

/** the pre-P1 terms reader, rebuilt from the strict schemas: same fields and types, but unknown keys are silently STRIPPED instead of refused */
const lenientCriterion = z.discriminatedUnion("type", criterionSchema.options.map((o) => z.object(o.shape)) as never);
const lenientTerms = z.object({ ...termsSchema.shape, criteria: z.array(lenientCriterion).min(1).max(20) });

const url = process.env.CORPUS_DATABASE_URL ?? process.env.DATABASE_URL;
const before = process.env.CORPUS_CREATED_BEFORE ? new Date(process.env.CORPUS_CREATED_BEFORE) : null;
if (before && Number.isNaN(before.getTime())) throw new Error("CORPUS_CREATED_BEFORE must be an ISO timestamp");
if (!url) throw new Error("set CORPUS_DATABASE_URL or DATABASE_URL");
const db = new PrismaClient({ datasources: { db: { url } } });

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const show = (m: Map<string, number>) => JSON.stringify(Object.fromEntries([...m.entries()].sort()));

try {
  const mandates = await db.mandate.findMany({ where: before ? { createdAt: { lt: before } } : undefined, select: { id: true, canonicalJson: true, mandateDigest: true } });
  const shapes = new Map<string, number>();
  const refused = new Map<string, number>();
  const refusedIds: string[] = [];
  let digestMismatch = 0;
  for (const m of mandates) {
    if (sha256Hex(m.canonicalJson) !== m.mandateDigest) {
      digestMismatch++;
      continue;
    }
    const r = readMandateDocument(m.canonicalJson);
    if (r.ok) bump(shapes, r.shape);
    else {
      bump(refused, r.code);
      if (refusedIds.length < 10) refusedIds.push(m.id);
    }
  }

  const deals = await db.deal.findMany({ where: { termsJson: { not: undefined }, ...(before ? { createdAt: { lt: before } } : {}) }, select: { id: true, termsJson: true, termsHash: true } });
  let validBeforeP1ButRefusedNow = 0;
  const validBeforeIds: string[] = [];
  let withTerms = 0;
  let readableAndLocked = 0;
  let readableButHashDiffers = 0;
  const termsRefused = new Map<string, number>();
  const termsRefusedIds: string[] = [];
  for (const d of deals) {
    if (d.termsJson === null) continue;
    withTerms++;
    const r = readTerms(d.termsJson);
    if (r.ok) {
      if (d.termsHash === termsHash(r.terms)) readableAndLocked++;
      else readableButHashDiffers++;
    } else {
      bump(termsRefused, r.code);
      if (termsRefusedIds.length < 10) termsRefusedIds.push(d.id);
      // would the pre-P1 reader have accepted this row AS A VALID LOCK (parse with unknown keys stripped, hash equals the stored lock)? That is the real compatibility risk.
      const old = lenientTerms.safeParse(d.termsJson);
      if (old.success && d.termsHash === sha256Hex(canonicalJson(normalizeTerms(old.data as never)))) {
        validBeforeP1ButRefusedNow++;
        if (validBeforeIds.length < 10) validBeforeIds.push(d.id);
      }
    }
  }

  console.log(`database: ${new URL(url).pathname}  (read-only)${before ? `  rows created before ${before.toISOString()}` : ""}`);
  console.log(`mandates: ${mandates.length} total | digest mismatch (refused before parsing, as before P1): ${digestMismatch} | digest-consistent: ${mandates.length - digestMismatch}`);
  console.log(`  accepted by the strict reader, by shape: ${show(shapes)}   (known shapes: ${MANDATE_V1_SHAPES.join(", ")})`);
  console.log(`  digest-consistent but REFUSED: ${show(refused)} ${refusedIds.length ? `e.g. ${refusedIds.join(",")}` : ""}`);
  console.log(`locked terms: ${withTerms} rows | readable and hash equals the stored lock: ${readableAndLocked} | readable but stored hash differs (drift fixtures): ${readableButHashDiffers} | REFUSED: ${show(termsRefused)} ${termsRefusedIds.length ? `e.g. ${termsRefusedIds.join(",")}` : ""}`);
  console.log(`locked terms that the pre-P1 reader accepted as a VALID lock (unknown keys stripped, hash equals the stored lock) but the strict reader refuses: ${validBeforeP1ButRefusedNow} ${validBeforeIds.length ? `e.g. ${validBeforeIds.join(",")}` : ""}`);
  const bad = [...refused.values()].reduce((a, b) => a + b, 0) + validBeforeP1ButRefusedNow;
  console.log(bad === 0 ? "RESULT: every digest-consistent stored mandate and every hash-consistent locked terms object is readable by the strict readers." : "RESULT: SOME stored documents are refused. On a database with deliberate tamper fixtures (the test database) these are the fixtures; on a real database do not deploy without review.");
  process.exitCode = bad === 0 ? 0 : 1;
} finally {
  await db.$disconnect();
}
