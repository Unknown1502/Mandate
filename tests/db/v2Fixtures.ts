/**
 * DB fixtures for the V2 lifecycle (P3-P7). Real PostgreSQL (mandate_test), MOCK PayPal, SCRIPTED model. Nothing here is evidence about a real LLM or real PayPal.
 */
import { randomBytes } from "node:crypto";
import { prisma, keys, deps as baseDeps, makePrincipal } from "./fixtures";
import { approveMandateV2, previewMandateV2 } from "@/domain/mandate-v2-writer";
import { approveDealWithAttestation, previewDealApproval } from "@/domain/deal-approval";
import { beginNegotiation, checkPolicy, createDeal, lockTerms, type PolicyDeps } from "@/domain/deals";
import { registryFromSigningKeys } from "@/domain/v2-keys";
import type { TermsV2 } from "@/domain/terms-v2";
import { createPayPalOrder, defaultEngineConfig, refreshBuyerApproval, type EngineContext } from "@/settlement/engine";
import { ModelRunner } from "@/verification/model-runner";
import type { LlmProvider } from "@/agents/llm";
import { MockPayPal } from "../helpers/mockPayPal";
import { openTestGate } from "../helpers/v2Gate";
import { DETECTOR, floorPolicy, llmTermsV2, detTermsV2, mandateDraftV2 } from "../helpers/v2Fixtures";
import { toCsv } from "@/verification/csv";
import { createHash } from "node:crypto";
import { submitDelivery } from "@/verification/delivery";

export { prisma, keys, makePrincipal };
export const registry = registryFromSigningKeys(keys);
/** the open V2 release gate (an ordinary signed record under an ephemeral test key; see tests/helpers/v2Gate.ts) */
export const v2Gate = openTestGate(keys, registry);

/** the V2 deployment context: V1 key + registry, LLM criteria switched ON (the production default is OFF), one test detector permitted */
export const v2Deps: PolicyDeps = {
  ...baseDeps,
  registry,
  v2Gate,
  llmCriteriaEnabled: true,
  modelGroupCap: 1,
  detectorPermitted: (d) => d.id === DETECTOR.id && d.version === DETECTOR.version && d.vocabularyHash === DETECTOR.vocabularyHash,
};

export async function makeV2Mandate(principal: { id: string; email: string }, over: Record<string, unknown> = {}) {
  const pv = previewMandateV2(principal.id, mandateDraftV2(over));
  return approveMandateV2(prisma, { principalId: principal.id, principalEmail: principal.email, draft: pv.draft, confirmDigest: pv.digest, keys, registry, v2Gate });
}

export type V2Terms = (mandateId: string) => TermsV2;
export const llmTerms: V2Terms = (mid) => llmTermsV2(mid);
export const detTerms: V2Terms = (mid) => detTermsV2(mid);

export interface V2Setup {
  terms?: V2Terms;
  mandateOver?: Record<string, unknown>;
  deps?: Partial<PolicyDeps>;
}

/** principal + V2 mandate + deal with locked V2 terms, policy-checked: state NEEDS_HUMAN (a V2 deal always needs the human attestation) */
export async function v2PendingApproval(s: V2Setup = {}) {
  const p = await makePrincipal();
  const m = await makeV2Mandate(p, s.mandateOver);
  const deps = { ...v2Deps, ...s.deps };
  const deal = await createDeal(prisma, { principalId: p.id, mandateId: m.id, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64, registry, v2Gate });
  await beginNegotiation(prisma, deal.id, "buyer-agent", p.id);
  await lockTerms(prisma, { dealId: deal.id, terms: (s.terms ?? llmTerms)(m.id), actor: "principal", principalId: p.id, deps });
  const pol = await checkPolicy(prisma, { dealId: deal.id, deps });
  return { p, m, dealId: deal.id, policy: pol, deps };
}

/** ... then the two-step human approval: attestation written, budget reserved */
export async function v2Approved(s: V2Setup = {}) {
  const base = await v2PendingApproval(s);
  if (base.policy.outcome !== "NEEDS_HUMAN") throw new Error(`fixture policy ${base.policy.outcome} ${base.policy.reasons}`);
  const preview = await previewDealApproval(prisma, { dealId: base.dealId, principalId: base.p.id, principalEmail: base.p.email, deps: base.deps, keys });
  const approval = await approveDealWithAttestation(prisma, {
    dealId: base.dealId,
    principalId: base.p.id,
    principalEmail: base.p.email,
    confirmDigest: preview.attestationDigest,
    approvalNonce: preview.approvalNonce,
    deps: base.deps,
    keys,
  });
  return { ...base, preview, approval };
}

export function makeV2Ctx(mock: MockPayPal, over: { deps?: Partial<PolicyDeps>; now?: () => Date } = {}): EngineContext {
  return {
    db: prisma,
    gateway: mock,
    deps: { ...v2Deps, ...over.deps },
    config: { ...defaultEngineConfig("http://localhost:3000"), challengeWindowMs: 0, partialCaptureVerified: false },
    now: over.now ?? (() => new Date()),
  };
}

/** ... through order creation, MOCK buyer approval and authorization: AWAITING_DELIVERY */
export async function v2Authorized(mock: MockPayPal, ctx: EngineContext, s: V2Setup = {}) {
  const base = await v2Approved({ ...s, deps: { ...s.deps } });
  const created = await createPayPalOrder(ctx, base.dealId);
  if (created.status !== "DONE") throw new Error(`fixture createOrder: ${created.status} ${created.reason}`);
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: base.dealId } });
  mock.buyerApprove(deal.paypalOrderId!); // MOCK: stands in for the human checkout
  const auth = await refreshBuyerApproval(ctx, base.dealId);
  if (auth.status !== "DONE") throw new Error(`fixture authorize: ${auth.status} ${auth.reason}`);
  return base;
}

// ------------------------------------------------------------------------------------------------ artifacts and the scripted model
export const V2_HEADERS = ["customer_id", "email", "description", "delivery_notes"];
export const V2_ROWS = [
  ["c-1", "a@x.com", "Customer record cleaned and merged with the existing account", "Merged two duplicate accounts and corrected the postal code"],
  ["c-2", "b@x.com", "Address normalised and the phone number validated", "Replaced a missing phone number with the verified one on file"],
  ["c-3", "c@x.com", "The duplicate entry was removed after the review of the account", "Removed the duplicate row and kept the most recent update"],
];
export const csvBuf = (headers: string[], rows: string[][]) => Buffer.from(toCsv(headers, rows), "utf8");
export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function deliverV2(dealId: string, artifact: Buffer, over: Record<string, unknown> = {}) {
  const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  const manifest = {
    dealId,
    termsHash: deal.termsHash!,
    sellerPrincipalId: "seller-sim",
    artifactReference: "cleaned.csv",
    artifactSha256: sha256(artifact),
    artifactSize: artifact.length,
    mediaType: "text/csv",
    submittedAt: new Date().toISOString(),
    ...over,
  };
  return submitDelivery({ db: prisma }, { dealId, authenticatedSellerId: "seller-sim", manifest, artifact });
}

/** A scripted model: replies are built from the request, so a test can simulate a model that cites evidence, disagrees, obeys an injected instruction, etc. */
export class RecordingModel implements LlmProvider {
  readonly name = "scripted";
  readonly requests: { role: string; system: string; user: string }[] = [];
  constructor(private readonly reply: (req: { role: string; system: string; user: string }, n: number) => string) {}
  async complete(req: { role: string; system: string; user: string; maxTokens: number }) {
    this.requests.push({ role: req.role, system: req.system, user: req.user });
    return { text: this.reply(req, this.requests.length), tokensIn: 10, tokensOut: 5 };
  }
}

/** verdict for the group's criteria, citing the first cell of the first shown column */
export const verdictReply = (verdict: "met" | "not_met" | "unverifiable", criterionIds = ["coherent"]) => (req: { role: string; user: string }) => {
  if (req.role === "skeptic") return JSON.stringify({ flags: [] });
  const sha12 = /sha12=([0-9a-f]{12})/.exec(req.user)![1]!;
  return JSON.stringify({
    assessments: criterionIds.map((criterionId) => ({ criterionId, verdict, rationale: "scripted", evidenceRefs: [`csv:${sha12}#row:1,col:description`] })),
    observations: [],
    summary: "scripted",
  });
};

export const runnerFor = (model: LlmProvider, maxCalls = 12) => new ModelRunner(model, "scripted-model", { maxCalls, newId: () => randomBytes(8).toString("hex") });
export { floorPolicy };
