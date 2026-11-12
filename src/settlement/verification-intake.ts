/**
 * The ONLY door from the verification pipeline into the Settlement Engine. It re-checks that a result is genuine, current and bound
 * to the original locked terms, maps it to the engine's existing intake (recordVerification / recordReverification), and nothing else.
 * It exposes no capture, void, reconcile or settlement function, so code that imports this file cannot move money.
 * Settlement itself (challenge window, human review, PayPal) remains entirely inside Gate 2.
 */
import { canonicalJson, sha256Hex } from "../domain/canonical";
import { appendEvent } from "../domain/ledger";
import { authorizeLoadedDeal } from "../domain/authorization";
import { termsMatchLockAny } from "../domain/terms-v2";
import { bindingRefusal } from "./binding-check";
import { verificationResultSchema, type VerificationResult } from "../verification/contracts";
import { recordReverification, recordVerification, type EngineContext, type EngineResult } from "./engine";

const INTAKE = "verification-intake";

export function sealHash(r: VerificationResult): string {
  const { resultHash: _h, ...rest } = r;
  void _h;
  return sha256Hex(canonicalJson(rest));
}

type Refused = { status: "REFUSED"; reason: string };

export async function submitVerificationToSettlement(ctx: EngineContext, p: { dealId: string; verificationId: string }): Promise<EngineResult | Refused> {
  const refuse = (reason: string): Refused => ({ status: "REFUSED", reason });
  const run = await ctx.db.verificationRun.findUnique({ where: { verificationId: p.verificationId } });
  if (!run || run.dealId !== p.dealId) return refuse("UNKNOWN_VERIFICATION");
  const deal = await ctx.db.deal.findUnique({ where: { id: p.dealId }, include: { delivery: true } });
  if (!deal || !deal.delivery) return refuse("UNKNOWN_DEAL_OR_DELIVERY");

  const parsed = verificationResultSchema.safeParse(run.resultJson);
  if (!parsed.success) return refuse("RESULT_INVALID");
  const r = parsed.data;
  if (sealHash(r) !== r.resultHash || r.resultHash !== run.resultHash || r.verificationId !== run.verificationId) return refuse("RESULT_TAMPERED");

  // Binding to the original agreement and to the exact artifact that was accepted.
  if (r.dealId !== deal.id) return refuse("STALE_VERIFICATION");
  if (!deal.termsHash || r.termsHash !== deal.termsHash || !termsMatchLockAny(deal.termsJson, deal.termsHash)) return refuse("STALE_VERIFICATION");
  if (r.artifactSha256 !== deal.delivery.artifactSha256 || run.deliveryId !== deal.delivery.id) return refuse("STALE_VERIFICATION");

  const latest = await ctx.db.verificationRun.findFirst({ where: { deliveryId: deal.delivery.id }, orderBy: { sequence: "desc" } });
  if (!latest || latest.sequence !== run.sequence) return refuse("SUPERSEDED_VERIFICATION");

  // P4/P5: the result must have been produced under the authorization that is in force NOW (V2: signed mandate, attestation, mapping, policy, detector, model calls).
  const full = await ctx.db.deal.findUnique({ where: { id: deal.id }, include: { mandate: true, reservations: true, attestation: true } });
  if (!full) return refuse("UNKNOWN_DEAL_OR_DELIVERY");
  const now = ctx.now();
  const authBase = authorizeLoadedDeal(full, { ...ctx.deps, now, llmCriteriaEnabled: true, detectorPermitted: () => true });
  if (!authBase.ok) return refuse("AUTHORIZATION_INVALID");
  const refusal = bindingRefusal(authBase.auth, r, deal.delivery.id);
  if (refusal) return refuse(refusal);
  // a result that rests on model calls is acceptable only while the deployment still permits those calls for this deal
  if (r.binding && r.binding.modelCalls.length > 0 && !authorizeLoadedDeal(full, { ...ctx.deps, now }).ok) return refuse("MODEL_USE_NO_LONGER_PERMITTED");

  // Idempotent: a result already handed to the engine is not handed over twice.
  const prior = await ctx.db.dealEvent.findMany({ where: { dealId: deal.id, type: "VERIFICATION_SUBMITTED" } });
  if (prior.some((e) => (e.payload as { verificationId?: string }).verificationId === r.verificationId)) return { status: "DONE", reason: "ALREADY_SUBMITTED", state: deal.state as EngineResult["state"] };

  const results = r.criteriaResults.map((c) => ({
    criterionId: c.criterionId,
    status: c.status === "PASS" ? ("met" as const) : c.status === "FAIL" ? ("not_met" as const) : ("unverifiable" as const),
    source: c.source,
    evidence: `${c.reason}: ${c.actual}`.slice(0, 1000),
  }));
  const flags = [
    ...r.skeptic.flags.map((f) => ({ code: f.code, severity: f.severity, source: f.source, severe: f.severe })),
    // A HIGH-severity, evidence-backed AI concern is escalated as an LLM flag: it can send the deal to a human, nothing more.
    ...r.ai.observations.filter((o) => o.severity === "HIGH" && (o.kind === "SUSPICIOUS" || o.kind === "CONTRADICTION")).map((o) => ({ code: `AI_${o.kind}`, severity: "HIGH" as const, source: "llm" as const, severe: false })),
  ];

  const out =
    run.sequence === 1
      ? await recordVerification(ctx, p.dealId, { results, flags })
      : await recordReverification(ctx, p.dealId, { results, flags, evidenceRefs: run.inputEvidenceRefs });
  if (out.status === "DONE") {
    await ctx.db.$transaction((tx) => appendEvent(tx, p.dealId, "VERIFICATION_SUBMITTED", INTAKE, { verificationId: r.verificationId, sequence: run.sequence, resultHash: r.resultHash }));
  }
  return out;
}
