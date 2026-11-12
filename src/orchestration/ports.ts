/**
 * The orchestrator's ONLY view of the Settlement Engine. These are narrow, typed operations; there is deliberately no capture,
 * void, amount or PayPal identifier anywhere in this file. A settlement INSTRUCTION says "settle this deal on the basis of this exact
 * verification"; the engine (Gate 2) re-checks it and alone decides whether and how much money moves.
 */
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const settlementInstructionSchema = z
  .object({
    kind: z.literal("SETTLE"),
    dealId: z.string().min(1).max(64),
    verificationId: z.string().min(8).max(64),
    termsHash: sha256,
    resultHash: sha256,
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict();
export type SettlementInstruction = z.infer<typeof settlementInstructionSchema>;

export interface PortResult {
  status: string;
  reason?: string;
  state: string;
}

export interface SettlementPort {
  createOrder(dealId: string): Promise<PortResult>;
  refreshApproval(dealId: string): Promise<PortResult>;
  submitVerification(i: { dealId: string; verificationId: string }): Promise<PortResult>;
  requestSettlement(instruction: unknown): Promise<PortResult>;
  acceptVerification(i: { dealId: string; principalId: string; principalEmail: string }): Promise<PortResult>;
  submitChallenge(i: { dealId: string; principalId: string; principalEmail: string; challenge: unknown }): Promise<PortResult>;
  submitReviewDecision(i: { dealId: string; principalId: string; principalEmail: string; decision: unknown }): Promise<PortResult>;
  expireOverdueReviews(): Promise<{ dealId: string; expired: boolean }[]>;
  reconcileDeal(dealId: string): Promise<PortResult>;
  cancelForDeadline(dealId: string): Promise<PortResult>;
}
