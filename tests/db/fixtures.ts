import { randomUUID } from "node:crypto";
import { prisma } from "@/db/client";
import { beginNegotiation, createDeal, lockTerms, type PolicyDeps } from "@/domain/deals";
import { approveMandate, previewMandate } from "@/domain/mandates";
import { generateSigningKeys } from "@/domain/signing";
import type { TermsV1 } from "@/domain/terms";

export const keys = generateSigningKeys("v1");
export const deps: PolicyDeps = { publicKeyB64: keys.publicKeyB64, maxRounds: 4 };
export { prisma };

export async function makePrincipal() {
  const email = `p-${randomUUID()}@test.local`;
  const user = await prisma.user.create({ data: { email } });
  return { id: user.id, email };
}

export async function makeMandate(
  principal: { id: string; email: string },
  over: Record<string, unknown> = {},
) {
  const draft = {
    currency: "USD",
    budgetTotal: "100",
    perDealMax: "60",
    requireHumanAbove: "50",
    allowedTaskTypes: ["data_cleaning"],
    counterparties: ["seller-sim"],
    injectionPolicy: "HUMAN_REVIEW",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...over,
  };
  const { digest } = previewMandate(principal.id, draft);
  return approveMandate(prisma, { principalId: principal.id, principalEmail: principal.email, draft, confirmDigest: digest, keys });
}

export const termsFor = (mandateId: string, over: Partial<TermsV1> = {}): TermsV1 => ({
  taskType: "data_cleaning",
  description: "Clean the CSV",
  criteria: [
    { id: "schema", text: "Columns match", type: "deterministic", validator: "csv_schema_matches", params: { columns: ["id"] }, required: true, weight: 70 },
    { id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: false, weight: 30 },
  ],
  price: "20.00",
  currency: "USD",
  deadline: "2029-01-01T00:00:00.000Z",
  sellerId: "seller-sim",
  mandateId,
  ...over,
});

/** A deal with locked terms, ready for checkPolicy(). */
export async function dealWithLockedTerms(principal: { id: string }, mandateId: string, over: Partial<TermsV1> = {}) {
  const deal = await createDeal(prisma, { principalId: principal.id, mandateId, sellerId: "seller-sim", publicKeyB64: keys.publicKeyB64 });
  await beginNegotiation(prisma, deal.id, "buyer-agent", principal.id);
  await lockTerms(prisma, { dealId: deal.id, terms: termsFor(mandateId, over), actor: "buyer-agent", principalId: principal.id });
  return deal;
}
