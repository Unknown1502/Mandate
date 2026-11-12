/**
 * Pure fixtures for the V2 lifecycle tests (P3-P7). No database, no network, no real model: ephemeral Ed25519 keys only.
 */
import { generateSigningKeys, type SigningKeys } from "@/domain/signing";
import { registryFromSigningKeys } from "@/domain/v2-keys";
import type { LanguagePolicy } from "@/domain/language-policy";
import type { ArtifactField, TermsV2 } from "@/domain/terms-v2";
import { newMandateId } from "@/domain/mandate-v2-writer";
import { shippedDetector } from "@/verification/language";

export const v2Keys: SigningKeys = generateSigningKeys("v2-test-1");
export const v2Registry = registryFromSigningKeys(v2Keys);

/** the real identity of the detector shipped in this build (so the fixtures agree with the default runtime check) */
export const DETECTOR = shippedDetector();

export function floorPolicy(over: Partial<LanguagePolicy> = {}): LanguagePolicy {
  return {
    schema: "mandate.languagePolicy/1",
    policyVersion: 1,
    supportedLanguages: ["en", "fr"],
    detector: { ...DETECTOR },
    unsupportedBehavior: "UNVERIFIABLE_HUMAN_REVIEW",
    uncertainBehavior: "UNVERIFIABLE_HUMAN_REVIEW",
    nameLikeBehavior: "UNCERTAIN",
    incompleteScanBehavior: "UNVERIFIABLE_HUMAN_REVIEW",
    shortText: "NO_EXEMPTION",
    criterionScope: [],
    humanReview: { required: true },
    ...over,
  };
}

export const mandateDraftV2 = (over: Record<string, unknown> = {}) => ({
  currency: "USD",
  budgetTotal: "100",
  perDealMax: "60",
  requireHumanAbove: "50",
  allowedTaskTypes: ["data_cleaning"],
  counterparties: ["seller-sim"],
  injectionPolicy: "HUMAN_REVIEW",
  allowPartialSettlement: false,
  allowPreDeliveryCancellation: true,
  expiresAt: "2030-01-01T00:00:00.000Z",
  languagePolicy: floorPolicy(),
  ...over,
});

const reservedOpaque = (): ArtifactField[] => [
  { id: "csv:header", classification: "OPAQUE" },
  { id: "manifest:artifactReference", classification: "OPAQUE" },
  { id: "manifest:mediaType", classification: "OPAQUE" },
  { id: "manifest:metadata", classification: "OPAQUE" },
];

/** LLM-judged V2 terms: C3 reads col:description and col:delivery_notes; customer_id / email / legacy are OPAQUE. */
export function llmTermsV2(mandateId: string, over: Partial<TermsV2> = {}): TermsV2 {
  return {
    schemaVersion: 2,
    taskType: "data_cleaning",
    description: "Clean the customer export",
    criteria: [
      { id: "schema", text: "Required columns present", type: "deterministic", validator: "required_columns_present", params: { columns: ["customer_id", "email"] }, required: true, weight: 70 },
      { id: "coherent", text: "Descriptions are coherent with the delivery notes", type: "llm_judged", inputFields: ["col:description", "col:delivery_notes"], inputMaxRows: 15, required: false, weight: 30 },
    ],
    price: "20.00",
    currency: "USD",
    deadline: "2029-01-01T00:00:00.000Z",
    sellerId: "seller-sim",
    mandateId,
    artifactSchema: {
      format: "csv",
      fields: [
        ...reservedOpaque(),
        { id: "col:customer_id", classification: "OPAQUE" },
        { id: "col:email", classification: "OPAQUE" },
        { id: "col:description", classification: "CRITERION_INPUT", criteria: ["coherent"] },
        { id: "col:delivery_notes", classification: "CRITERION_INPUT", criteria: ["coherent"] },
      ],
    },
    languagePolicy: floorPolicy({ criterionScope: [{ criterionId: "coherent", scope: "INPUT_FIELDS", rows: "MODEL_SAMPLE" }] }),
    ...over,
  };
}

/** deterministic-only V2 terms (no artifactSchema, no languagePolicy) */
export function detTermsV2(mandateId: string, over: Partial<TermsV2> = {}): TermsV2 {
  return {
    schemaVersion: 2,
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
  };
}

export const fakeMandateId = (): string => newMandateId();
export const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
