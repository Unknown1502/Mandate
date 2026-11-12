/**
 * Two-step human approval of V2 terms (P3; docs/15 section 15.5.5), with a TermsAttestation.
 *
 *   1. previewDealApproval  - READ-ONLY apart from one ledger event that issues a single-use server nonce. Shows the human, without truncation, the deal, the budget,
 *      each criterion with its permitted input fields, the full field mapping, the fields withheld from every model (OPAQUE), the language policy and what happens in the
 *      unsupported / uncertain case, the counterparties, the expiry, the task restrictions and the acceptance criteria. Returns the attestationDigest to be echoed.
 *   2. approveDealWithAttestation - the human echoes the digest. In ONE transaction (mandate row locked): re-verify the whole authorization, check the nonce, recompute the
 *      digest from the CURRENT state, sign and store the attestation, append the HUMAN_REVIEW_DECISION event carrying the terms hash / attestation id / nonce, and reserve
 *      the budget. Any failure rolls back all of it: there is never an attestation without a reservation, or a reservation without an attestation.
 *
 * Concurrency: the mandate row lock serialises concurrent approvals; the unique (dealId) and unique (approvalNonce) constraints are the backstops, so two approvals can never
 * bind different terms to one deal. The attestation is the application's record that this human approved these exact terms; it is not a signature the user made.
 */
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { safeEqual } from "../lib/session";
import { attestationDigest, buildUnsignedAttestation, signAttestation } from "./attestation";
import { authorizeLoadedDeal, expectedBinding, type AuthorizationReason } from "./authorization";
import { lockMandate, committedFor } from "./budget";
import { evaluateFor, reserveForDealTx, type PolicyDeps } from "./deals";
import { appendEvent, type Tx } from "./ledger";
import { NotFoundError } from "./mandates";
import { D, fmt, parseMoney } from "./money";
import type { SigningKeys } from "./signing";
import { hasLlmCriteria, modelGroups, normalizeTermsV2, RESERVED_OPAQUE_FIELDS } from "./terms-v2";

export const APPROVAL_PREVIEW_TTL_MS = 15 * 60_000;

/** a string field of a ledger payload (JSON read back from the database: nothing about it is assumed) */
const payloadString = (payload: unknown, key: string): string | undefined => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

export const APPROVAL_ERROR_CODES = [
  "NOT_AWAITING_APPROVAL",
  "ALREADY_APPROVED",
  "AUTHORIZATION_INVALID",
  "POLICY_NOT_APPROVABLE",
  "NONCE_UNKNOWN",
  "NONCE_EXPIRED",
  "NONCE_USED",
  "DIGEST_MISMATCH",
  "KEY_MISMATCH",
  "BUDGET_REFUSED",
  "NOT_A_V2_DEAL",
] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];
export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ApprovalError";
  }
}

type DealWithAll = Prisma.DealGetPayload<{ include: { mandate: true; reservations: true; attestation: true } }>;

async function loadForApproval(tx: Tx, dealId: string, principalId: string): Promise<DealWithAll> {
  const deal = await tx.deal.findUnique({ where: { id: dealId }, include: { mandate: true, reservations: true, attestation: true } });
  if (!deal || deal.mandate.principalId !== principalId) throw new NotFoundError("Deal not found");
  return deal;
}

/** shared verification of everything the human is being asked to approve, in the CURRENT state */
async function verifyApprovable(tx: Tx, deal: DealWithAll, deps: PolicyDeps, now: Date) {
  if (deal.attestation) throw new ApprovalError("ALREADY_APPROVED");
  if (deal.state !== "NEEDS_HUMAN" || deal.needsHumanFrom !== "POLICY_CHECKED") throw new ApprovalError("NOT_AWAITING_APPROVAL", deal.state);
  const a = authorizeLoadedDeal(deal, { ...deps, now }, { checkExpiry: true, requireAttestation: false });
  if (!a.ok) throw new ApprovalError("AUTHORIZATION_INVALID", a.detail ? `${a.reason}:${a.detail}` : a.reason);
  if (a.auth.terms.version !== 2 || a.auth.mandate.version !== 2) throw new ApprovalError("NOT_A_V2_DEAL");
  const { result } = await evaluateFor(tx, deal.id, { ...deps, now }, false);
  if (result.outcome !== "NEEDS_HUMAN") throw new ApprovalError("POLICY_NOT_APPROVABLE", result.reasons.join(","));
  return { mandate: a.auth.mandate, terms: a.auth.terms };
}

/** the key used to sign an attestation must be an ACTIVE registry entry with the same public key (otherwise the attestation could never verify) */
function assertSigningKeyTrusted(deps: PolicyDeps, keys: SigningKeys): void {
  const rec = deps.registry?.lookup(keys.keyVersion);
  if (!rec || rec.status !== "ACTIVE" || rec.publicKeyB64 !== keys.publicKeyB64) throw new ApprovalError("KEY_MISMATCH");
}

export interface DealApprovalPreview {
  dealId: string;
  mandateId: string;
  mandateDigest: string;
  sellerId: string;
  price: string;
  currency: string;
  deadline: string;
  taskType: string;
  termsHash: string;
  languagePolicyHash: string | null;
  mappingHash: string;
  budget: { budgetTotal: string; perDealMax: string; committedByOthers: string; remainingBefore: string; thisDeal: string; remainingAfter: string };
  counterparties: string[];
  allowedTaskTypes: string[];
  mandateExpiresAt: string;
  acceptanceCriteria: Array<{ id: string; text: string; type: string; required: boolean; weight: number; validator: string | null }>;
  mapping: { criteria: Array<{ id: string; inputFields: string[] | null; inputMaxRows: number | null }>; fields: Array<{ id: string; classification: string; criteria: string[] }> };
  opaqueFields: string[];
  languagePolicy: unknown;
  modelCallsPermitted: boolean;
  modelGroups: number;
  rendering: string[];
  approvalNonce: string;
  attestationDigest: string;
  keyVersion: string;
  expiresAt: string;
}

export async function previewDealApproval(
  db: PrismaClient,
  p: { dealId: string; principalId: string; principalEmail: string; deps: PolicyDeps; keys: SigningKeys; now?: Date; rng?: (n: number) => Buffer },
): Promise<DealApprovalPreview> {
  const now = p.now ?? new Date();
  return db.$transaction(async (tx) => {
    const deal = await loadForApproval(tx, p.dealId, p.principalId);
    const { mandate, terms } = await verifyApprovable(tx, deal, p.deps, now);
    if (mandate.version !== 2 || terms.version !== 2) throw new ApprovalError("NOT_A_V2_DEAL");
    assertSigningKeyTrusted(p.deps, p.keys);

    const nonce = (p.rng ?? randomBytes)(16).toString("hex");
    const binding = expectedBinding(deal.id, mandate, terms);
    const unsigned = buildUnsignedAttestation(binding, { keyVersion: p.keys.keyVersion, actor: { id: p.principalId, label: p.principalEmail }, approvalNonce: nonce });
    const digest = attestationDigest(unsigned);
    const expiresAt = new Date(now.getTime() + APPROVAL_PREVIEW_TTL_MS).toISOString();
    await appendEvent(tx, deal.id, "APPROVAL_PREVIEWED", `human:${p.principalEmail}`, { approvalNonce: nonce, attestationDigest: digest, termsHash: terms.termsHash, keyVersion: p.keys.keyVersion, expiresAt });

    const t = normalizeTermsV2(terms.terms);
    const committed = await committedFor(tx, deal.mandateId, deal.id);
    const budgetTotal = parseMoney(mandate.doc.budgetTotal);
    const price = parseMoney(t.price);
    const fields = t.artifactSchema?.fields ?? [];
    const opaque = fields.filter((f) => f.classification === "OPAQUE").map((f) => f.id);
    const llm = hasLlmCriteria(t);
    const lp = t.languagePolicy ?? null;
    const preview: DealApprovalPreview = {
      dealId: deal.id,
      mandateId: deal.mandateId,
      mandateDigest: mandate.mandateDigest,
      sellerId: t.sellerId,
      price: t.price,
      currency: t.currency,
      deadline: t.deadline,
      taskType: t.taskType,
      termsHash: terms.termsHash,
      languagePolicyHash: binding.languagePolicyHash,
      mappingHash: binding.mappingHash,
      budget: {
        budgetTotal: mandate.doc.budgetTotal,
        perDealMax: mandate.doc.perDealMax,
        committedByOthers: fmt(committed),
        remainingBefore: fmt(budgetTotal.sub(committed)),
        thisDeal: fmt(price),
        remainingAfter: fmt(budgetTotal.sub(committed).sub(price)),
      },
      counterparties: [...mandate.doc.counterparties],
      allowedTaskTypes: [...mandate.doc.allowedTaskTypes],
      mandateExpiresAt: mandate.doc.expiresAt,
      acceptanceCriteria: t.criteria.map((c) => ({ id: c.id, text: c.text, type: c.type, required: c.required, weight: c.weight, validator: c.type === "deterministic" ? c.validator : null })),
      mapping: {
        criteria: t.criteria.map((c) => ({ id: c.id, inputFields: c.type === "llm_judged" ? c.inputFields : null, inputMaxRows: c.type === "llm_judged" ? c.inputMaxRows : null })),
        fields: fields.map((f) => ({ id: f.id, classification: f.classification, criteria: f.classification === "CRITERION_INPUT" ? f.criteria : [] })),
      },
      opaqueFields: opaque,
      languagePolicy: lp,
      modelCallsPermitted: llm,
      modelGroups: llm ? modelGroups(t).length : 0,
      rendering: [],
      approvalNonce: nonce,
      attestationDigest: digest,
      keyVersion: p.keys.keyVersion,
      expiresAt,
    };
    preview.rendering = renderDealApproval(preview);
    return preview;
  });
}

/** Plain-language rendering. Nothing is truncated; every OPAQUE field and every criterion-to-field edge is listed. */
export function renderDealApproval(v: DealApprovalPreview): string[] {
  const out: string[] = [];
  out.push(`You are approving deal ${v.dealId} with seller ${v.sellerId}: ${v.price} ${v.currency}, deadline ${v.deadline}, task type ${v.taskType}.`);
  out.push(`Mandate ${v.mandateId} (digest ${v.mandateDigest}); allowed task types ${v.allowedTaskTypes.join(", ")}; counterparties ${v.counterparties.join(", ")}; the mandate expires ${v.mandateExpiresAt}.`);
  out.push(`Budget: total ${v.budget.budgetTotal}, per-deal maximum ${v.budget.perDealMax}, already committed to other deals ${v.budget.committedByOthers}; this deal reserves ${v.budget.thisDeal}, leaving ${v.budget.remainingAfter}.`);
  out.push("Acceptance criteria (what the seller must deliver):");
  for (const c of v.acceptanceCriteria) out.push(`  - ${c.id}: ${c.text} [${c.type === "llm_judged" ? "AI-judged" : `checked by program (${c.validator})`}; ${c.required ? "required" : "optional"}; weight ${c.weight}]`);
  if (!v.modelCallsPermitted) {
    out.push("No criterion is AI-judged: no AI model will read the delivered artifact.");
  } else {
    out.push("Which parts of the delivery each AI-judged criterion may read (and nothing else):");
    for (const c of v.mapping.criteria) if (c.inputFields) out.push(`  - ${c.id}: fields ${c.inputFields.join(", ")} (at most ${c.inputMaxRows} rows)`);
    out.push(`Fields never sent to any AI model (${v.opaqueFields.length}): ${v.opaqueFields.join(", ")}. This includes the header row and all seller-provided metadata.`);
    const lp = v.languagePolicy as { supportedLanguages: string[]; detector: { id: string; version: string; vocabularyHash: string }; unsupportedBehavior: string; uncertainBehavior: string } | null;
    if (lp) {
      out.push(`Language policy: supported languages ${lp.supportedLanguages.join(", ")}; detector ${lp.detector.id}@${lp.detector.version} (${lp.detector.vocabularyHash}).`);
      out.push(`If a model-readable field contains text in an unsupported language, or the language cannot be confidently determined, the affected criterion is marked UNVERIFIABLE, no AI model is called for it, and the deal is held for human review (${lp.unsupportedBehavior} / ${lp.uncertainBehavior}). Name-like tokens in model-readable fields are treated as uncertain.`);
    }
  }
  out.push(`Terms hash ${v.termsHash}; language policy hash ${v.languagePolicyHash ?? "(none)"}; mapping hash ${v.mappingHash}.`);
  out.push(`To approve, confirm the digest ${v.attestationDigest}. The application will record that you approved these exact terms and attest to that record with its key (this is not a signature made with a key you hold). The confirmation code expires ${v.expiresAt}.`);
  return out;
}

export interface ApproveDealParams {
  dealId: string;
  principalId: string;
  principalEmail: string;
  confirmDigest: string;
  approvalNonce: string;
  deps: PolicyDeps;
  keys: SigningKeys;
  now?: Date;
}
export type ApproveDealResult = { ok: true; attestationId: string; reserved: boolean };

class Rollback extends Error {
  constructor(readonly reasons: string[]) {
    super("rollback");
  }
}

/** Step 2. Throws ApprovalError (nothing persisted) on any failure. */
export async function approveDealWithAttestation(db: PrismaClient, p: ApproveDealParams): Promise<ApproveDealResult> {
  const now = p.now ?? new Date();
  try {
    return await db.$transaction(async (tx) => {
      const pre = await tx.deal.findUnique({ where: { id: p.dealId }, select: { mandateId: true, mandate: { select: { principalId: true } } } });
      if (!pre || pre.mandate.principalId !== p.principalId) throw new NotFoundError("Deal not found");
      await lockMandate(tx, pre.mandateId); // serialises concurrent approvals and reservations for this mandate
      const deal = await loadForApproval(tx, p.dealId, p.principalId);
      const { mandate, terms } = await verifyApprovable(tx, deal, p.deps, now);
      if (mandate.version !== 2 || terms.version !== 2) throw new ApprovalError("NOT_A_V2_DEAL");
      assertSigningKeyTrusted(p.deps, p.keys);
      if (!/^[0-9a-f]{32}$/.test(p.approvalNonce)) throw new ApprovalError("NONCE_UNKNOWN");

      // the preview that issued this nonce (ledger event on THIS deal; a nonce from another deal is simply unknown here)
      const events = await tx.dealEvent.findMany({ where: { dealId: deal.id, type: "APPROVAL_PREVIEWED" }, orderBy: { seq: "asc" } });
      const issuedEvent = events.find((e) => payloadString(e.payload, "approvalNonce") === p.approvalNonce);
      if (!issuedEvent) throw new ApprovalError("NONCE_UNKNOWN");
      const issued = { attestationDigest: payloadString(issuedEvent.payload, "attestationDigest"), expiresAt: payloadString(issuedEvent.payload, "expiresAt"), keyVersion: payloadString(issuedEvent.payload, "keyVersion") };
      if (issued.expiresAt === undefined || new Date(issued.expiresAt) <= now) throw new ApprovalError("NONCE_EXPIRED");
      if (await tx.termsAttestation.findUnique({ where: { approvalNonce: p.approvalNonce } })) throw new ApprovalError("NONCE_USED");
      if (issued.keyVersion !== p.keys.keyVersion) throw new ApprovalError("KEY_MISMATCH");

      // recompute from the CURRENT verified state; the human's echo must equal both it and what the preview showed
      const binding = expectedBinding(deal.id, mandate, terms);
      const unsigned = buildUnsignedAttestation(binding, { keyVersion: p.keys.keyVersion, actor: { id: p.principalId, label: p.principalEmail }, approvalNonce: p.approvalNonce });
      const digest = attestationDigest(unsigned);
      if (!safeEqual(p.confirmDigest, digest) || issued.attestationDigest === undefined || !safeEqual(issued.attestationDigest, digest)) throw new ApprovalError("DIGEST_MISMATCH");

      const signed = signAttestation(unsigned, now.toISOString(), p.keys);
      const row = await tx.termsAttestation.create({
        data: {
          dealId: deal.id,
          mandateId: binding.mandateId,
          mandateDigest: binding.mandateDigest,
          termsHash: binding.termsHash,
          termsSchemaVersion: 2,
          languagePolicyHash: binding.languagePolicyHash,
          mappingHash: binding.mappingHash,
          approvalKind: "HUMAN_PREAUTH",
          actorKind: "human",
          actorId: p.principalId,
          approvedAt: new Date(signed.payload.approvedAt),
          approvalNonce: p.approvalNonce,
          keyVersion: signed.keyVersion,
          payloadJson: signed.payloadJson,
          signature: signed.signature,
        },
      });
      await appendEvent(tx, deal.id, "HUMAN_REVIEW_DECISION", `human:${p.principalEmail}`, {
        phase: "PRE_AUTH",
        decision: "approve",
        termsHash: binding.termsHash,
        attestationId: row.id,
        approvalNonce: p.approvalNonce,
        attestationDigest: digest,
      });
      const r = await reserveForDealTx(tx, { dealId: deal.id, deps: { ...p.deps, now }, humanApproved: true, principalId: p.principalId });
      if (!r.ok) throw new Rollback(r.reasons);
      return { ok: true as const, attestationId: row.id, reserved: r.created };
    });
  } catch (e) {
    if (e instanceof Rollback) throw new ApprovalError("BUDGET_REFUSED", e.reasons.join(","));
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ApprovalError("ALREADY_APPROVED", "concurrent approval");
    throw e;
  }
}

export type { AuthorizationReason };
export { D, RESERVED_OPAQUE_FIELDS };
