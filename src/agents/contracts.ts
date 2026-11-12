/**
 * Wire contracts between the orchestrator, the Buyer Agent and the (separate-process) Seller Agent.
 * This file imports ONLY zod: the seller process imports it, so it must never pull in the database, PayPal,
 * settlement or signing code. Every object is .strict(): unknown keys (a smuggled "criteria", "amount", ...) fail.
 */
import { z } from "zod";

export const MONEY_RE = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;
const price = z.string().regex(MONEY_RE, "price must be a USD decimal string with at most 2 decimals");
const message = z.string().max(500);

export const specCriterionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    text: z.string().min(1).max(300),
    type: z.enum(["deterministic", "llm_judged"]),
    required: z.boolean(),
    weight: z.number().int().min(1).max(100),
    validator: z.string().max(64).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type SpecCriterion = z.infer<typeof specCriterionSchema>;

/** The task as the seller sees it. Authored by the principal's brief; neither agent can change it. */
export const taskSpecSchema = z
  .object({
    taskType: z.literal("data_cleaning"),
    description: z.string().min(1).max(2000),
    criteria: z.array(specCriterionSchema).min(1).max(20),
    currency: z.literal("USD"),
    deadline: z.iso.datetime(),
  })
  .strict();
export type TaskSpec = z.infer<typeof taskSpecSchema>;

// ---- Buyer Agent output: typed intents only. No tools, no free-form actions. ----
export const buyerIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("propose"), price, message: message.optional() }).strict(),
  z.object({ kind: z.literal("counter"), price, message: message.optional() }).strict(),
  z.object({ kind: z.literal("accept"), message: message.optional() }).strict(),
  z.object({ kind: z.literal("walk_away"), reason: z.string().max(200) }).strict(),
]);
export type BuyerIntent = z.infer<typeof buyerIntentSchema>;

// ---- Orchestrator -> Seller request ----
export const negotiateRequestSchema = z
  .object({
    round: z.number().int().min(1).max(8),
    spec: taskSpecSchema,
    buyer: z
      .object({
        kind: z.enum(["propose", "counter", "accept", "walk_away"]),
        price: price.optional(),
        message: message.optional(),
      })
      .strict(),
  })
  .strict();
export type NegotiateRequest = z.infer<typeof negotiateRequestSchema>;

// ---- Seller response. It can quote, accept, or decline; it cannot touch criteria, deadline or anything else. ----
export const sellerResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), message: message.optional() }).strict(),
  z.object({ kind: z.literal("counter"), price, message: message.optional() }).strict(),
  z.object({ kind: z.literal("decline"), reason: z.string().max(200), message: message.optional() }).strict(),
]);
export type SellerResponse = z.infer<typeof sellerResponseSchema>;

/** Anything a seller says AFTER terms are locked (delivery notes, invoices) that restates terms. */
export const sellerRestatementSchema = z
  .object({ price: price.optional(), deadline: z.iso.datetime().optional(), criteria: z.array(specCriterionSchema).optional() })
  .passthrough();
export type SellerRestatement = z.infer<typeof sellerRestatementSchema>;

// ---- Demo delivery (Seller simulator -> orchestrator). The seller builds the artifact AND the manifest itself; the buyer's request only picks the simulated behaviour. ----
export const DELIVERY_QUALITIES = ["good", "duplicates", "injection"] as const;
export const deliverRequestSchema = z
  .object({
    dealId: z.string().min(1).max(64),
    termsHash: z.string().regex(/^[0-9a-f]{64}$/),
    criteria: z.array(specCriterionSchema).min(1).max(20),
    quality: z.enum(DELIVERY_QUALITIES),
  })
  .strict();
export type DeliverRequest = z.infer<typeof deliverRequestSchema>;

export const deliverResponseSchema = z
  .object({
    manifest: z
      .object({
        dealId: z.string().min(1).max(64),
        termsHash: z.string().regex(/^[0-9a-f]{64}$/),
        sellerPrincipalId: z.string().min(1).max(64),
        artifactReference: z.string().min(1).max(120),
        artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
        artifactSize: z.number().int().min(1).max(2_000_000),
        mediaType: z.literal("text/csv"),
        submittedAt: z.iso.datetime(),
      })
      .strict(),
    artifactText: z.string().min(1).max(200_000),
  })
  .strict();
export type DeliverResponse = z.infer<typeof deliverResponseSchema>;
