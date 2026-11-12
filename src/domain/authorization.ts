/**
 * THE central authorization revalidation (P3/P5; docs/15 sections 15.5.4, 15.9.1). One function re-derives, from the stored records and the key registry, everything a
 * consequential action depends on, and refuses unless ALL of it still holds. No component may reconstruct a more permissive authorization than this function returns.
 *
 * Checked, in this order (each failure is a closed-enum reason; nothing is skipped when an earlier check passes):
 *   mandate seal (V1 or V2) -> mandate identity/nonce -> mandate revocation and expiry -> terms present and strictly readable -> terms hash equals the locked hash ->
 *   terms bind THIS mandate and THIS counterparty -> V1/V2 consistency -> (V2) classification and group cap -> (V2 LLM) language policy at least as strict as the signed
 *   floor, deployment switch, detector permission -> mirrored column hints equal the signed/locked values -> (V2) TermsAttestation present, signature valid under the
 *   registry, bound to THIS deal / mandate digest / terms hash / mapping / language policy, approved by the mandate's principal.
 *
 * Budget reservation, deal state and verification provenance are checked by the caller that owns them (they need the caller's expected state); the helper
 * `requireActiveReservation` exists for the common case. AI never reaches this function: nothing here reads model output.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Tx } from "./ledger";
import { openMandateRow, type MandateKeyContext, type OpenedMandate } from "./mandates";
import { strictnessFailures, type LanguagePolicy } from "./language-policy";
import { verifyTermsAttestation, type AttestationBinding, type AttestationPayload } from "./attestation";
import { hashAny, hasLlmCriteria, languagePolicyHashOf, mappingHashV2, readAnyTerms, type TermsV2 } from "./terms-v2";
import type { TermsV1 } from "./terms";

export const AUTHORIZATION_REASONS = [
  "DEAL_NOT_FOUND",
  "MANDATE_SEAL_INVALID",
  "MANDATE_REVOKED",
  "MANDATE_EXPIRED",
  "TERMS_NOT_LOCKED",
  "TERMS_INVALID",
  "TERMS_VERSION_UNSUPPORTED",
  "TERMS_DRIFT",
  "TERMS_MANDATE_MISMATCH",
  "TERMS_COUNTERPARTY_MISMATCH",
  "COUNTERPARTY_NOT_ALLOWED",
  "TERMS_VERSION_MANDATE_MISMATCH",
  "CLASSIFICATION_INVALID",
  "MODEL_GROUP_CAP_EXCEEDED",
  "LANGUAGE_POLICY_WEAKER_THAN_MANDATE",
  "LLM_CRITERIA_NOT_ENABLED",
  "DETECTOR_NOT_PERMITTED",
  "COLUMN_HINT_MISMATCH",
  "ATTESTATION_MISSING",
  "ATTESTATION_INVALID",
  "NO_ACTIVE_BUDGET_RESERVATION",
] as const;
export type AuthorizationReason = (typeof AUTHORIZATION_REASONS)[number];

export interface AuthorizationDeps extends MandateKeyContext {
  now?: Date;
  modelGroupCap?: number;
  llmCriteriaEnabled?: boolean;
  detectorPermitted?: (d: LanguagePolicy["detector"], supported?: readonly string[]) => boolean;
}

export type DealForAuthorization = Prisma.DealGetPayload<{ include: { mandate: true; reservations: true; attestation: true } }>;

export type VerifiedTerms = { version: 1; terms: TermsV1; termsHash: string } | { version: 2; terms: TermsV2; termsHash: string };

export interface DealAuthorization {
  deal: DealForAuthorization;
  mandate: OpenedMandate;
  terms: VerifiedTerms;
  attestation: AttestationPayload | null;
}
export type AuthorizationResult = { ok: true; auth: DealAuthorization } | { ok: false; reason: AuthorizationReason; detail?: string };

const fail = (reason: AuthorizationReason, detail?: string): AuthorizationResult => (detail ? { ok: false, reason, detail } : { ok: false, reason });

export interface AuthorizeOptions {
  /** check mandate expiry against deps.now (true for actions that create or extend authority; false for completing an already-authorized deal) */
  checkExpiry?: boolean;
  /** require an ACTIVE or CONVERTED budget reservation row for the deal */
  requireActiveReservation?: boolean;
  /** V2: require the attestation (default true). Only the attestation-issuing flow itself sets this to false, before the attestation exists. */
  requireAttestation?: boolean;
}

/** The binding an attestation must have for THIS deal in its CURRENT state, derived from freshly verified records (never from the attestation). */
export function expectedBinding(dealId: string, mandate: Extract<OpenedMandate, { version: 2 }>, terms: Extract<VerifiedTerms, { version: 2 }>): AttestationBinding {
  return {
    dealId,
    mandateId: mandate.doc.mandateId,
    mandateDigest: mandate.mandateDigest,
    termsHash: terms.termsHash,
    termsSchemaVersion: 2,
    languagePolicyHash: languagePolicyHashOf(terms.terms),
    mappingHash: mappingHashV2(terms.terms),
  };
}

export async function authorizeDeal(db: PrismaClient | Tx, dealId: string, deps: AuthorizationDeps, opts: AuthorizeOptions = {}): Promise<AuthorizationResult> {
  const deal = await db.deal.findUnique({ where: { id: dealId }, include: { mandate: true, reservations: true, attestation: true } });
  if (!deal) return fail("DEAL_NOT_FOUND");
  return authorizeLoadedDeal(deal, deps, opts);
}

export function authorizeLoadedDeal(deal: DealForAuthorization, deps: AuthorizationDeps, opts: AuthorizeOptions = {}): AuthorizationResult {
  const now = deps.now ?? new Date();
  const m = openMandateRow(deal.mandate, deps);
  if (!m) return fail("MANDATE_SEAL_INVALID");
  if (deal.mandate.revokedAt) return fail("MANDATE_REVOKED");
  if (opts.checkExpiry && new Date(m.doc.expiresAt) <= now) return fail("MANDATE_EXPIRED");

  if (!deal.termsJson || !deal.termsHash) return fail("TERMS_NOT_LOCKED");
  const parsed = readAnyTerms(deal.termsJson, { modelGroupCap: deps.modelGroupCap });
  if (!parsed.ok) return fail(parsed.code === "TERMS_VERSION_UNSUPPORTED" || parsed.code === "CRITERION_VERSION_UNSUPPORTED" ? "TERMS_VERSION_UNSUPPORTED" : "TERMS_INVALID");
  const termsHash = hashAny(parsed);
  if (termsHash !== deal.termsHash) return fail("TERMS_DRIFT");
  if (parsed.terms.mandateId !== deal.mandateId) return fail("TERMS_MANDATE_MISMATCH");
  if (parsed.terms.sellerId !== deal.sellerId) return fail("TERMS_COUNTERPARTY_MISMATCH");
  if (!m.doc.counterparties.includes(parsed.terms.sellerId)) return fail("COUNTERPARTY_NOT_ALLOWED");

  // V1 mandates carry V1 terms; V2 mandates carry V2 terms. Nothing crosses (no downgrade around the signed language policy).
  if (deal.termsSchemaVersion !== parsed.version) return fail("COLUMN_HINT_MISMATCH", "termsSchemaVersion");
  const reservationOk = !opts.requireActiveReservation || deal.reservations.some((r) => r.status === "ACTIVE" || r.status === "CONVERTED");

  if (parsed.version === 1 && m.version === 1) {
    if (!reservationOk) return fail("NO_ACTIVE_BUDGET_RESERVATION");
    return { ok: true, auth: { deal, mandate: m, terms: { version: 1, terms: parsed.terms, termsHash }, attestation: null } };
  }
  if (parsed.version !== 2 || m.version !== 2) return fail("TERMS_VERSION_MANDATE_MISMATCH");

  // ---------------------------------------------------------------- V2
  const terms: Extract<VerifiedTerms, { version: 2 }> = { version: 2, terms: parsed.terms, termsHash };
  if (parsed.issues.length > 0) return fail(parsed.issues.includes("MODEL_GROUP_CAP_EXCEEDED") ? "MODEL_GROUP_CAP_EXCEEDED" : "CLASSIFICATION_INVALID", parsed.issues.join(","));
  const lpHash = languagePolicyHashOf(parsed.terms);
  if ((deal.languagePolicyHash ?? null) !== lpHash) return fail("COLUMN_HINT_MISMATCH", "languagePolicyHash");
  if (hasLlmCriteria(parsed.terms)) {
    if (!deps.llmCriteriaEnabled) return fail("LLM_CRITERIA_NOT_ENABLED");
    const tp = parsed.terms.languagePolicy!;
    const weaker = strictnessFailures(tp, m.doc.languagePolicy);
    if (weaker.length > 0) return fail("LANGUAGE_POLICY_WEAKER_THAN_MANDATE", weaker.join(","));
    if (!deps.detectorPermitted || !deps.detectorPermitted(tp.detector, tp.supportedLanguages)) return fail("DETECTOR_NOT_PERMITTED");
  }

  let attestation: AttestationPayload | null = null;
  if (opts.requireAttestation !== false) {
    const a = deal.attestation;
    if (!a) return fail("ATTESTATION_MISSING");
    if (!deps.registry) return fail("ATTESTATION_INVALID", "NO_REGISTRY");
    const v = verifyTermsAttestation(
      { payloadJson: a.payloadJson, signature: a.signature, keyVersion: a.keyVersion },
      { registry: deps.registry, expected: expectedBinding(deal.id, m, terms), expectedActorId: deal.mandate.principalId },
    );
    if (!v.ok) return fail("ATTESTATION_INVALID", v.field ? `${v.code}:${v.field}` : v.code);
    // the mirrored columns are copies for queries; they must equal the signed payload
    const p = v.payload;
    if (a.dealId !== p.dealId || a.mandateId !== p.mandateId || a.termsHash !== p.termsHash || a.mappingHash !== p.mappingHash || a.approvalNonce !== p.approvalNonce || a.actorId !== p.actor.id || (a.languagePolicyHash ?? null) !== p.languagePolicyHash || a.approvedAt.toISOString() !== p.approvedAt)
      return fail("ATTESTATION_INVALID", "COLUMNS_DIFFER_FROM_SIGNED_PAYLOAD");
    attestation = p;
  }
  if (!reservationOk) return fail("NO_ACTIVE_BUDGET_RESERVATION");
  return { ok: true, auth: { deal, mandate: m, terms, attestation } };
}
