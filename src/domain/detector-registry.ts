/**
 * Detector release registry and governance workflow (P7; docs/15 sections 15.5, 15.18).
 *
 * A language policy pins one detector triple (id, version, vocabularyHash). A RELEASE is the governed, immutable record that this exact triple was evaluated, reviewed,
 * approved and released. The workflow is
 *
 *     DRAFT -> EVALUATION -> REVIEW -> APPROVED -> RELEASED -> RETIRED          (REVOKED from any later state; RETIRED -> RELEASED only by a signed ROLLBACK)
 *
 * with these controls, each enforced in code AND (status moves and immutability) by database triggers:
 *   - registration records the manifest (identity, coverage, dataset version, DISCLOSED known gaps) and its content hash; the row is immutable except `status`;
 *   - evaluation must present every required suite, passing, with tuning and held-out data separate (disjoint ids, different hashes), mutation testing with zero survivors,
 *     prescan performance inside budget, and NO undisclosed failures (misses must be listed in the manifest's knownGaps, which cannot change after registration);
 *   - an independent LANGUAGE review (covering every claimed language) and an independent SECURITY review (naming the adversarial corpus), by two different people, neither of
 *     whom submitted the release; the approver is a third party; the releaser is not the submitter;
 *   - every event is hash-chained and signed with the application key; `verifyRelease` re-derives the status from the events and refuses a row that disagrees;
 *   - a release that is MORE PERMISSIVE than the one it follows (any fixture moving toward "model may read it", or a language added) cannot be released without an explicit
 *     acknowledgement, and no mandate or terms can ever adopt it implicitly: a policy pins the exact triple (strictness comparison treats a different detector as different);
 *   - a detector may be USED only if a verified release matches the triple, the status permits it, the release covers every language the policy supports, and the build ships
 *     exactly that detector.
 *
 * Reviewer and approver identities are the strings the caller supplies: this module enforces that they are DISTINCT; authenticating the people is the HTTP layer's job
 * (not built). It does not claim that any real native-speaker review has happened.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import type { KeyRegistry } from "./key-registry";
import { publicKeyFingerprint } from "./key-registry";
import { signMessage, verifyMessage, type SigningKeys } from "./signing";
import { GENESIS_HASH, sanitizeForLedger } from "./ledger";

export const RELEASE_STATUSES = ["DRAFT", "EVALUATION", "REVIEW", "APPROVED", "RELEASED", "RETIRED", "REVOKED"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const REQUIRED_SUITES = [
  "LANGUAGE_FIXTURES",
  "UNICODE_MIXED_SCRIPT",
  "SHORT_INSTRUCTION",
  "PROMPT_INJECTION_REGRESSION",
  "FALSE_POSITIVE_NEGATIVE",
  "PRESCAN_PERFORMANCE",
  "MUTATION_TESTING",
  "HELD_OUT_EVALUATION",
  "RELEASE_COMPARISON",
] as const;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const vocabHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const lang = z.enum(["en", "fr", "zh"]);
export const detectorIdentitySchema = z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), vocabularyHash: vocabHash });
export type DetectorIdentity = z.infer<typeof detectorIdentitySchema>;
const person = z.strictObject({ id: z.string().min(1).max(128), label: z.string().min(1).max(254) });
export type Person = z.infer<typeof person>;

export const releaseManifestSchema = z.strictObject({
  schema: z.literal("detector.release/1"),
  detector: detectorIdentitySchema,
  languageCoverage: z.array(lang).min(1).max(3),
  evaluationDatasetVersion: z.string().min(1).max(64),
  /** fixture ids the release DISCLOSES as misses (documented limits); fixed at registration so a miss cannot be hidden afterwards */
  knownGaps: z.array(z.string().max(80)).max(500),
  submittedBy: person,
  submittedAt: z.iso.datetime(),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const evaluationReportSchema = z.strictObject({
  schema: z.literal("detector.evaluation/1"),
  detector: detectorIdentitySchema,
  datasets: z.strictObject({
    tuning: z.strictObject({ version: z.string().max(64), sha256: sha, ids: z.array(z.string().max(80)).max(5000) }),
    heldOut: z.strictObject({ version: z.string().max(64), sha256: sha, ids: z.array(z.string().max(80)).min(1).max(5000) }),
  }),
  suites: z
    .array(z.strictObject({ name: z.enum(REQUIRED_SUITES), passed: z.boolean(), total: z.number().int().min(0), failures: z.number().int().min(0), undisclosedFailures: z.number().int().min(0), note: z.string().max(300).optional() }))
    .max(20),
  knownGaps: z.array(z.string().max(80)).max(500),
  counts: z.strictObject({ unsafePasses: z.number().int().min(0), falseBlocks: z.number().int().min(0), tuningSize: z.number().int().min(0), heldOutSize: z.number().int().min(0) }),
  perf: z.strictObject({ fragments: z.number().int().min(1), ms: z.number().min(0), budgetMs: z.number().min(1) }),
  mutation: z.strictObject({ killed: z.number().int().min(0), survived: z.number().int().min(0), invalid: z.number().int().min(0), unreached: z.number().int().min(0), reportSha256: sha }),
  comparison: z.strictObject({ previousRelease: z.string().max(80).nullable(), permissivenessDelta: z.array(z.strictObject({ fixtureId: z.string().max(80), from: z.string().max(20), to: z.string().max(20) })).max(5000), languagesAdded: z.array(lang).max(3) }),
  fixtureOutcomes: z.record(z.string().max(80), z.string().max(20)),
  environment: z.strictObject({ node: z.string().max(40), platform: z.string().max(40) }),
  generatedAt: z.iso.datetime(),
});
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export class GovernanceError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GovernanceError";
  }
}
const deny = (code: string, detail?: string): never => {
  throw new GovernanceError(code, detail);
};

export const contentHashOf = (m: ReleaseManifest): string => sha256Hex(canonicalJson(m));

// ------------------------------------------------------------------------------------------------------------------------ the signed, chained log
type Tx = Prisma.TransactionClient;
const EVENT_HASH = (prev: string, e: { releaseId: string; seq: number; type: string; actor: string; payload: unknown; createdAt: string }) => sha256Hex(prev + canonicalJson(e));

async function appendReleaseEvent(tx: Tx, releaseId: string, type: string, actor: Person, payload: unknown, keys: SigningKeys, now: Date) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DetectorRelease" WHERE id = ${releaseId} FOR UPDATE`;
  if (locked.length === 0) deny("RELEASE_NOT_FOUND");
  const last = await tx.detectorReleaseEvent.findFirst({ where: { releaseId }, orderBy: { seq: "desc" } });
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const clean = sanitizeForLedger(payload) as Prisma.InputJsonValue;
  const a = `human:${actor.id}`;
  const hash = EVENT_HASH(prevHash, { releaseId, seq, type, actor: a, payload: clean, createdAt: now.toISOString() });
  const signature = signMessage(canonicalJson({ purpose: "detector-release-event", releaseId, seq, type, actor: a, hash, keyVersion: keys.keyVersion }), keys.privateKeyB64);
  return tx.detectorReleaseEvent.create({ data: { releaseId, seq, type, actor: a, payload: clean, prevHash, hash, keyVersion: keys.keyVersion, signature, createdAt: now } });
}

async function setStatus(tx: Tx, releaseId: string, from: ReleaseStatus, to: ReleaseStatus, now: Date) {
  const r = await tx.detectorRelease.updateMany({ where: { id: releaseId, status: from }, data: { status: to, statusChangedAt: now } });
  if (r.count !== 1) deny("STALE_STATUS", `${from} -> ${to}`);
}

const approvedPayload = z.looseObject({ approver: person });
const releasedPayload = z.looseObject({ permissive: z.boolean() });
const reviewPayload = z.looseObject({ kind: z.enum(["LANGUAGE", "SECURITY"]), outcome: z.enum(["PASS", "FAIL"]), reviewer: person });
const evaluationPayload = z.looseObject({ passed: z.boolean(), reportSha256: sha, report: z.unknown() });
const passedPayload = z.looseObject({ reportSha256: sha });

const STATUS_BY_EVENT: Record<string, ReleaseStatus | undefined> = {
  SUBMITTED: "DRAFT",
  EVALUATION_PASSED: "REVIEW",
  APPROVED: "APPROVED",
  RELEASED: "RELEASED",
  RETIRED: "RETIRED",
  REVOKED: "REVOKED",
  ROLLBACK_TO: "RELEASED",
};

// ------------------------------------------------------------------------------------------------------------------------ verification of a stored release
export type VerifiedRelease = {
  ok: true;
  id: string;
  identity: DetectorIdentity;
  status: ReleaseStatus;
  languageCoverage: string[];
  manifest: ReleaseManifest;
  approvedBy: Person[];
  approvedAt: string | null;
  permissive: boolean;
};
export type ReleaseVerification = VerifiedRelease | { ok: false; code: string };

type ReleaseRow = Prisma.DetectorReleaseGetPayload<{ include: { events: true } }>;

/** Re-derives everything from the rows: manifest hash, hash chain, signatures under the registry, and the status implied by the events. */
export function verifyRelease(row: ReleaseRow, registry: KeyRegistry): ReleaseVerification {
  const m = releaseManifestSchema.safeParse(row.manifestJson);
  if (!m.success) return { ok: false, code: "MANIFEST_INVALID" };
  if (contentHashOf(m.data) !== row.contentHash) return { ok: false, code: "CONTENT_HASH_MISMATCH" };
  if (m.data.detector.id !== row.detectorId || m.data.detector.version !== row.version || m.data.detector.vocabularyHash !== row.vocabularyHash) return { ok: false, code: "IDENTITY_MISMATCH" };
  if (m.data.languageCoverage.join(",") !== [...row.languageCoverage].join(",") || m.data.evaluationDatasetVersion !== row.evaluationDatasetVersion) return { ok: false, code: "COLUMNS_DIFFER_FROM_MANIFEST" };

  const events = [...row.events].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS_HASH;
  let derived: ReleaseStatus = "DRAFT";
  let approvedAt: string | null = null;
  const approvedBy: Person[] = [];
  let permissive = false;
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1 || e.prevHash !== prev) return { ok: false, code: "CHAIN_BROKEN" };
    const expect = EVENT_HASH(prev, { releaseId: row.id, seq: e.seq, type: e.type, actor: e.actor, payload: e.payload, createdAt: e.createdAt.toISOString() });
    if (expect !== e.hash) return { ok: false, code: "EVENT_HASH_MISMATCH" };
    const rec = registry.lookup(e.keyVersion);
    if (!rec || rec.status !== "ACTIVE" || publicKeyFingerprint(rec.publicKeyB64) !== rec.fingerprint) return { ok: false, code: "SIGNING_KEY_NOT_TRUSTED" };
    if (!verifyMessage(canonicalJson({ purpose: "detector-release-event", releaseId: row.id, seq: e.seq, type: e.type, actor: e.actor, hash: e.hash, keyVersion: e.keyVersion }), e.signature, rec.publicKeyB64)) return { ok: false, code: "EVENT_SIGNATURE_INVALID" };
    prev = e.hash;
    const next = STATUS_BY_EVENT[e.type];
    if (next) derived = next;
    if (e.type === "APPROVED") {
      approvedAt = e.createdAt.toISOString();
      const a = approvedPayload.safeParse(e.payload);
      if (a.success) approvedBy.push(a.data.approver);
    }
    if (e.type === "RELEASED") {
      const r = releasedPayload.safeParse(e.payload);
      if (r.success && r.data.permissive) permissive = true;
    }
  }
  if (events.length === 0 || events[0]!.type !== "SUBMITTED") return { ok: false, code: "NO_SUBMISSION_EVENT" };
  if (derived !== row.status) return { ok: false, code: "STATUS_DIFFERS_FROM_LOG" };
  return { ok: true, id: row.id, identity: m.data.detector, status: row.status as ReleaseStatus, languageCoverage: [...row.languageCoverage], manifest: m.data, approvedBy, approvedAt, permissive };
}

async function loadRow(tx: Tx | PrismaClient, releaseId: string): Promise<ReleaseRow> {
  const row = await tx.detectorRelease.findUnique({ where: { id: releaseId }, include: { events: true } });
  return row ?? deny("RELEASE_NOT_FOUND");
}
const eventsOf = (row: ReleaseRow, type: string) => [...row.events].filter((e) => e.type === type).sort((a, b) => a.seq - b.seq);
const distinct = (...ids: string[]) => new Set(ids).size === ids.length;

// ------------------------------------------------------------------------------------------------------------------------ workflow
export async function registerDraft(
  db: PrismaClient,
  p: { identity: DetectorIdentity; languageCoverage: Array<"en" | "fr" | "zh">; evaluationDatasetVersion: string; knownGaps: string[]; submittedBy: Person; keys: SigningKeys; now?: Date },
) {
  const now = p.now ?? new Date();
  const manifest = releaseManifestSchema.parse({
    schema: "detector.release/1",
    detector: p.identity,
    languageCoverage: [...new Set(p.languageCoverage)].sort(),
    evaluationDatasetVersion: p.evaluationDatasetVersion,
    knownGaps: [...new Set(p.knownGaps)].sort(),
    submittedBy: p.submittedBy,
    submittedAt: now.toISOString(),
  });
  const contentHash = contentHashOf(manifest);
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.detectorRelease.create({
        data: { detectorId: manifest.detector.id, version: manifest.detector.version, vocabularyHash: manifest.detector.vocabularyHash, contentHash, languageCoverage: manifest.languageCoverage, evaluationDatasetVersion: manifest.evaluationDatasetVersion, manifestJson: manifest as unknown as Prisma.InputJsonValue, submittedBy: p.submittedBy.id, status: "DRAFT", statusChangedAt: now, createdAt: now },
      });
      await appendReleaseEvent(tx, row.id, "SUBMITTED", p.submittedBy, { contentHash, manifest }, p.keys, now);
      return row;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return deny("DUPLICATE_RELEASE", "this detector version or vocabulary hash is already registered");
    throw e;
  }
}

/** Held-out and tuning data must be separate: disjoint fixture ids and different content hashes. */
export function datasetsSeparate(r: EvaluationReport): boolean {
  const t = new Set(r.datasets.tuning.ids);
  return r.datasets.heldOut.ids.every((id) => !t.has(id)) && r.datasets.heldOut.sha256 !== r.datasets.tuning.sha256 && r.datasets.heldOut.version !== r.datasets.tuning.version;
}

export function evaluationProblems(r: EvaluationReport, manifest: ReleaseManifest): string[] {
  const out: string[] = [];
  const d = r.detector;
  if (d.id !== manifest.detector.id || d.version !== manifest.detector.version || d.vocabularyHash !== manifest.detector.vocabularyHash) out.push("EVALUATED_DETECTOR_DIFFERS_FROM_RELEASE");
  if (!datasetsSeparate(r)) out.push("TUNING_AND_HELD_OUT_NOT_SEPARATE");
  if (r.datasets.heldOut.version !== manifest.evaluationDatasetVersion) out.push("DATASET_VERSION_MISMATCH");
  const names = r.suites.map((s) => s.name);
  for (const need of REQUIRED_SUITES) if (names.filter((n) => n === need).length !== 1) out.push(`SUITE_MISSING_OR_DUPLICATE:${need}`);
  for (const s of r.suites) {
    if (!s.passed) out.push(`SUITE_FAILED:${s.name}`);
    if (s.undisclosedFailures > 0) out.push(`UNDISCLOSED_FAILURES:${s.name}`);
  }
  if ([...r.knownGaps].sort().join("|") !== [...manifest.knownGaps].sort().join("|")) out.push("KNOWN_GAPS_DIFFER_FROM_MANIFEST");
  if (r.mutation.survived > 0 || r.mutation.invalid > 0 || r.mutation.unreached > 0) out.push("MUTATION_NOT_CLEAN");
  if (r.perf.ms > r.perf.budgetMs) out.push("PRESCAN_OVER_BUDGET");
  if (r.counts.heldOutSize !== r.datasets.heldOut.ids.length || r.counts.tuningSize !== r.datasets.tuning.ids.length) out.push("COUNTS_DIFFER_FROM_DATASETS");
  return out;
}

export async function recordEvaluation(db: PrismaClient, p: { releaseId: string; report: unknown; actor: Person; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  const report = evaluationReportSchema.parse(p.report);
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status !== "DRAFT" && row.status !== "EVALUATION") return deny("WRONG_STATUS", row.status);
    const manifest = releaseManifestSchema.parse(row.manifestJson);
    const problems = evaluationProblems(report, manifest);
    const reportSha256 = sha256Hex(canonicalJson(report));
    if (row.status === "DRAFT") {
      await setStatus(tx, row.id, "DRAFT", "EVALUATION", now);
      await appendReleaseEvent(tx, row.id, "EVALUATION_STARTED", p.actor, {}, p.keys, now);
    }
    await appendReleaseEvent(tx, row.id, "EVALUATION_RECORDED", p.actor, { reportSha256, passed: problems.length === 0, problems, report }, p.keys, now);
    if (problems.length > 0) return { passed: false as const, problems, status: "EVALUATION" as ReleaseStatus };
    await appendReleaseEvent(tx, row.id, "EVALUATION_PASSED", p.actor, { reportSha256 }, p.keys, now);
    await setStatus(tx, row.id, "EVALUATION", "REVIEW", now);
    return { passed: true as const, problems, status: "REVIEW" as ReleaseStatus };
  });
}

const reviewInput = z.strictObject({
  kind: z.enum(["LANGUAGE", "SECURITY"]),
  outcome: z.enum(["PASS", "FAIL"]),
  languages: z.array(lang).max(3).optional(),
  /** sha256 of the reviewer's written findings */
  findingsSha256: sha,
  /** SECURITY: sha256 of the adversarial corpus used (prompt injection, paraphrase, code switching, mixed scripts, Unicode evasion) */
  adversarialCorpusSha256: sha.optional(),
});

export async function recordReview(db: PrismaClient, p: { releaseId: string; reviewer: Person; review: unknown; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  const review = reviewInput.parse(p.review);
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status !== "REVIEW") return deny("WRONG_STATUS", row.status);
    if (p.reviewer.id === row.submittedBy) return deny("REVIEWER_NOT_INDEPENDENT", "the submitter cannot review their own release");
    if (review.kind === "LANGUAGE") {
      const need = new Set(row.languageCoverage);
      if (!review.languages || [...need].some((l) => !review.languages!.includes(l as "en"))) return deny("LANGUAGE_REVIEW_INCOMPLETE", "the review must cover every language the release claims");
    }
    if (review.kind === "SECURITY" && !review.adversarialCorpusSha256) return deny("SECURITY_REVIEW_NEEDS_CORPUS");
    const other = review.kind === "LANGUAGE" ? "SECURITY" : "LANGUAGE";
    const others = eventsOf(row, "REVIEW_RECORDED").filter((e) => {
      const x = reviewPayload.safeParse(e.payload);
      return x.success && x.data.kind === other && x.data.outcome === "PASS";
    });
    if (others.some((e) => e.actor === `human:${p.reviewer.id}`)) return deny("REVIEWERS_NOT_DISTINCT", "language and security review must be done by different people");
    await appendReleaseEvent(tx, row.id, "REVIEW_RECORDED", p.reviewer, { ...review, reviewer: p.reviewer }, p.keys, now);
    return { recorded: true };
  });
}

/** the latest review of each kind, if its outcome is PASS */
function latestPassingReviews(row: ReleaseRow): { language?: { actor: string; person: Person }; security?: { actor: string; person: Person } } {
  const out: { language?: { actor: string; person: Person }; security?: { actor: string; person: Person } } = {};
  for (const e of eventsOf(row, "REVIEW_RECORDED")) {
    const parsed = reviewPayload.safeParse(e.payload);
    if (!parsed.success) continue;
    const pl = parsed.data;
    const slot = pl.kind === "LANGUAGE" ? "language" : "security";
    if (pl.outcome === "PASS") out[slot] = { actor: e.actor, person: pl.reviewer };
    else delete out[slot]; // a later FAIL withdraws an earlier PASS
  }
  return out;
}

export async function approveRelease(db: PrismaClient, p: { releaseId: string; approver: Person; registry: KeyRegistry; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status !== "REVIEW") return deny("WRONG_STATUS", row.status);
    const v = verifyRelease(row, p.registry);
    if (!v.ok) return deny("RELEASE_UNVERIFIABLE", v.code);
    const evalOk = eventsOf(row, "EVALUATION_PASSED");
    if (evalOk.length === 0) return deny("EVALUATION_NOT_PASSED");
    const rv = latestPassingReviews(row);
    if (!rv.language || !rv.security) return deny("REVIEWS_INCOMPLETE", "a passing LANGUAGE and a passing SECURITY review are required");
    if (!distinct(rv.language.actor, rv.security.actor)) return deny("REVIEWERS_NOT_DISTINCT");
    const actors = [`human:${row.submittedBy}`, rv.language.actor, rv.security.actor];
    if (actors.includes(`human:${p.approver.id}`)) return deny("APPROVER_NOT_INDEPENDENT", "the approver must differ from the submitter and both reviewers");
    await appendReleaseEvent(tx, row.id, "APPROVED", p.approver, { approver: p.approver, contentHash: row.contentHash, vocabularyHash: row.vocabularyHash, evaluation: passedPayload.parse(evalOk[evalOk.length - 1]!.payload).reportSha256, languageReviewer: rv.language.person, securityReviewer: rv.security.person }, p.keys, now);
    await setStatus(tx, row.id, "REVIEW", "APPROVED", now);
    return { approvedAt: now.toISOString() };
  });
}

/**
 * Release an APPROVED version. `permissive` is derived from the recorded evaluation's release comparison; a release that is more permissive than its predecessor
 * (a fixture now treated as readable, or a language added) needs `acknowledgePermissive` and is flagged in the log, so a new mandate's preview can say so.
 */
export async function releaseRelease(db: PrismaClient, p: { releaseId: string; releaser: Person; acknowledgePermissive?: boolean; registry: KeyRegistry; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status !== "APPROVED") return deny("WRONG_STATUS", row.status);
    const v = verifyRelease(row, p.registry);
    if (!v.ok) return deny("RELEASE_UNVERIFIABLE", v.code);
    if (p.releaser.id === row.submittedBy) return deny("RELEASER_NOT_INDEPENDENT");
    const evs = eventsOf(row, "EVALUATION_RECORDED").flatMap((e) => {
      const x = evaluationPayload.safeParse(e.payload);
      return x.success && x.data.passed ? [x.data] : [];
    });
    if (evs.length === 0) return deny("EVALUATION_NOT_PASSED");
    const rep = evaluationReportSchema.parse(evs[evs.length - 1]!.report);
    const permissive = rep.comparison.permissivenessDelta.length > 0 || rep.comparison.languagesAdded.length > 0;
    if (permissive && p.acknowledgePermissive !== true) return deny("MORE_PERMISSIVE_NEEDS_ACKNOWLEDGEMENT", `${rep.comparison.permissivenessDelta.length} fixture(s) moved toward model-readable; languages added: ${rep.comparison.languagesAdded.join(",") || "none"}`);
    await appendReleaseEvent(tx, row.id, "RELEASED", p.releaser, { releaser: p.releaser, permissive, permissivenessDelta: rep.comparison.permissivenessDelta.length, languagesAdded: rep.comparison.languagesAdded, selectableByExistingMandates: false }, p.keys, now);
    await setStatus(tx, row.id, "APPROVED", "RELEASED", now);
    return { permissive };
  });
}

export async function retireRelease(db: PrismaClient, p: { releaseId: string; actor: Person; reason: string; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status !== "RELEASED" && row.status !== "APPROVED") return deny("WRONG_STATUS", row.status);
    await appendReleaseEvent(tx, row.id, "RETIRED", p.actor, { actor: p.actor, reason: p.reason.slice(0, 300) }, p.keys, now);
    await setStatus(tx, row.id, row.status as ReleaseStatus, "RETIRED", now);
  });
}

export async function revokeRelease(db: PrismaClient, p: { releaseId: string; actor: Person; reason: string; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const row = await loadRow(tx, p.releaseId);
    if (row.status === "DRAFT" || row.status === "REVOKED") return deny("WRONG_STATUS", row.status);
    await appendReleaseEvent(tx, row.id, "REVOKED", p.actor, { actor: p.actor, reason: p.reason.slice(0, 300) }, p.keys, now);
    await setStatus(tx, row.id, row.status as ReleaseStatus, "REVOKED", now);
  });
}

/** Roll back to a prior release that WAS approved (its log proves it) and still verifies; the current one is retired (or revoked when it was defective). */
export async function rollbackTo(db: PrismaClient, p: { toReleaseId: string; fromReleaseId: string; actor: Person; reason: string; revokeFrom?: boolean; registry: KeyRegistry; keys: SigningKeys; now?: Date }) {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const to = await loadRow(tx, p.toReleaseId);
    const from = await loadRow(tx, p.fromReleaseId);
    if (to.id === from.id || to.detectorId !== from.detectorId) return deny("ROLLBACK_TARGET_INVALID");
    if (to.status !== "RETIRED" && to.status !== "APPROVED" && to.status !== "RELEASED") return deny("WRONG_STATUS", to.status);
    const v = verifyRelease(to, p.registry);
    if (!v.ok) return deny("RELEASE_UNVERIFIABLE", v.code);
    if (eventsOf(to, "APPROVED").length === 0) return deny("TARGET_NEVER_APPROVED");
    if (from.status !== "RELEASED" && from.status !== "APPROVED") return deny("WRONG_STATUS", from.status);
    await appendReleaseEvent(tx, from.id, p.revokeFrom ? "REVOKED" : "RETIRED", p.actor, { actor: p.actor, reason: p.reason.slice(0, 300), rollbackTo: to.id }, p.keys, now);
    await setStatus(tx, from.id, from.status as ReleaseStatus, p.revokeFrom ? "REVOKED" : "RETIRED", now);
    if (to.status !== "RELEASED") {
      await appendReleaseEvent(tx, to.id, "ROLLBACK_TO", p.actor, { actor: p.actor, reason: p.reason.slice(0, 300), from: from.id }, p.keys, now);
      await setStatus(tx, to.id, to.status as ReleaseStatus, "RELEASED", now);
    }
  });
}

// ------------------------------------------------------------------------------------------------------------------------ use
export interface DetectorSnapshot {
  releases: VerifiedRelease[];
  /** rows that failed verification (listed for the operator; they grant nothing) */
  rejected: Array<{ id: string; code: string }>;
}

export async function loadDetectorSnapshot(db: PrismaClient, registry: KeyRegistry): Promise<DetectorSnapshot> {
  const rows = await db.detectorRelease.findMany({ include: { events: true } });
  const snap: DetectorSnapshot = { releases: [], rejected: [] };
  for (const r of rows) {
    const v = verifyRelease(r, registry);
    if (v.ok) snap.releases.push(v);
    else snap.rejected.push({ id: r.id, code: v.code });
  }
  return snap;
}

/**
 * The predicate the policy, the terms lock, the mandate writer and verification use. `NEW_PIN` (a new mandate choosing a detector) requires status RELEASED; `EXISTING_PIN`
 * (a mandate or terms that already pin it) also accepts RETIRED. REVOKED, DRAFT, EVALUATION, REVIEW and APPROVED are never usable. The build must ship exactly the pinned
 * detector, and the release must cover every language the policy supports.
 */
export function detectorPermission(snapshot: DetectorSnapshot, shipped: DetectorIdentity, mode: "NEW_PIN" | "EXISTING_PIN"): (d: DetectorIdentity, supported?: readonly string[]) => boolean {
  const usable = new Set<ReleaseStatus>(mode === "NEW_PIN" ? ["RELEASED"] : ["RELEASED", "RETIRED"]);
  return (d, supported) => {
    if (d.id !== shipped.id || d.version !== shipped.version || d.vocabularyHash !== shipped.vocabularyHash) return false;
    const rel = snapshot.releases.find((r) => r.identity.id === d.id && r.identity.version === d.version && r.identity.vocabularyHash === d.vocabularyHash);
    if (!rel || !usable.has(rel.status)) return false;
    return (supported ?? []).every((l) => rel.languageCoverage.includes(l));
  };
}
