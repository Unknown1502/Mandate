/**
 * Strict contracts for Gate 4. The delivery manifest is UNTRUSTED seller input; the VerificationResult is our immutable,
 * hash-sealed output. Note what the result does NOT contain: no score, no percentage, no amount. Statuses only, so nothing in it
 * can be mistaken for (or used as) a PayPal settlement amount. Money is derived later by the Settlement Engine from locked weights.
 */
import { z } from "zod";

/** "p0-iso-1": verification no longer places artifact text in front of a model for V1 terms (docs/15 s15.9.0). Earlier results carry "gate4-1". */
export const VERIFIER_VERSION = "p0-iso-1";
/** "p4-v2-1": V2 verification (restricted model inputs, language assessment on the exact prompt text, evidence scoped to the approved view, a signed-state `binding`). */
export const V2_VERIFIER_VERSION = "p4-v2-1";
/** result versions that may be handed to settlement for a V1 deal (frozen: V1 results carry no binding) */
export const V1_VERIFIER_VERSIONS = ["gate4-1", "p0-iso-1"] as const;
export const DEFAULT_MAX_ARTIFACT_BYTES = 200_000;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** artifactReference is an opaque label. It is NEVER used to open a file; the bytes arrive in the request and are stored in the database. */
export const artifactReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "artifactReference must be a simple name (no path separators)")
  .refine((v) => !v.includes(".."), "path traversal sequence");

export const deliveryManifestSchema = z
  .object({
    dealId: z.string().min(1).max(64),
    termsHash: sha256,
    sellerPrincipalId: z.string().min(1).max(64),
    artifactReference: artifactReferenceSchema,
    artifactSha256: sha256,
    artifactSize: z.number().int().min(1).max(50_000_000),
    mediaType: z.enum(["text/csv", "text/csv; charset=utf-8"]),
    submittedAt: z.iso.datetime(),
    metadata: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.union([z.string().max(1000), z.number().int().min(-1_000_000_000).max(1_000_000_000), z.boolean()]))
      .refine((o) => Object.keys(o).length <= 20, "too many metadata keys")
      .optional(),
  })
  .strict();
export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;

const status = z.enum(["PASS", "FAIL", "UNVERIFIABLE"]);
const severity = z.enum(["LOW", "MED", "HIGH"]);
const refs = z.array(z.string().max(300)).max(40);

export const criterionResultSchema = z
  .object({
    criterionId: z.string(),
    type: z.enum(["deterministic", "llm_judged"]),
    required: z.boolean(),
    /** copied from the LOCKED terms for reference; the verifier never changes it and the result never turns it into money */
    weight: z.number().int().min(1).max(100),
    status,
    source: z.enum(["deterministic", "verifier"]),
    validator: z.string().max(64).optional(),
    expected: z.string().max(600),
    actual: z.string().max(600),
    reason: z.string().max(120),
    evidenceRefs: refs,
    aiRunRefs: z.array(z.string()).max(5).optional(),
  })
  .strict();

export const observationSchema = z
  .object({
    origin: z.enum(["ai-verifier", "ai-skeptic"]),
    kind: z.enum(["QUALITATIVE", "SUSPICIOUS", "CONTRADICTION", "SUGGESTED_EVIDENCE"]),
    severity,
    text: z.string().max(500),
    evidenceRefs: z.array(z.string().max(300)).min(1).max(10),
    quote: z.string().max(200).optional(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export const SKEPTIC_CODES = [
  "INSTR_OVERRIDE",
  "VERIFIER_TAMPER",
  "EXFIL_REQUEST",
  "AUTHORITY_SPOOF",
  "URGENCY_PRESSURE",
  "TERMS_DRIFT",
  "PRICE_CHANGE_ATTEMPT",
  "HIDDEN_TEXT",
  "BIDI_CONTROL",
  "ENCODED_PAYLOAD",
  "HTML_COMMENT",
  "CSV_FORMULA_CELL",
  "EMPTY_OR_PLACEHOLDER",
  "UNSUPPORTED_COMPLETION_CLAIM",
  "CONTRADICTORY_METADATA",
  /** deterministic: prose in a language or script the deterministic skeptic cannot read (fail closed; see language.ts) */
  "UNSCANNED_LANGUAGE",
  /** deterministic: the prescan hit a processing limit and did not examine the whole file (fail closed; see prescan.ts) */
  "SCAN_INCOMPLETE",
  /** deterministic: a word mixing scripts (Latin with Cyrillic / Greek ...) or a look-alike word inside Latin text: visual spoofing (final QA B1) */
  "CONFUSABLE_SCRIPT_MIX",
] as const;

export const skepticFlagSchema = z
  .object({
    code: z.enum(SKEPTIC_CODES),
    severity,
    source: z.enum(["deterministic", "llm"]),
    /** deterministic severe manipulation (hidden text, encoded payload, verifier-addressed instructions) */
    severe: z.boolean(),
    evidenceRefs: refs,
    detail: z.string().max(300),
  })
  .strict();
export type SkepticFlag = z.infer<typeof skepticFlagSchema>;

const detectorRef = z.strictObject({ id: z.string().max(64), version: z.string().max(32), vocabularyHash: z.string().max(80) });

/**
 * V2 lineage (P4): everything the intake needs to re-derive, from the CURRENT locked deal, that this result was produced under the approved authorization. Contains
 * hashes, ids, counts and closed-enum reasons only: no artifact text, no prompt text, no model output text.
 */
export const bindingSchema = z.strictObject({
  termsSchemaVersion: z.literal(2),
  mandateId: z.string().max(64),
  mandateDigest: sha256,
  termsHash: sha256,
  mappingHash: sha256,
  languagePolicyHash: sha256.nullable(),
  effectivePolicyHash: sha256.nullable(),
  deploymentFloorHash: sha256.nullable(),
  /** dimensions in which the deployment floor was weaker than the signed policy (recorded, never silent) */
  deploymentWeakerDimensions: z.array(z.string().max(60)).max(20),
  detector: detectorRef.nullable(),
  attestationNonce: z.string().max(64),
  attestationRecordSha256: sha256,
  deliveryId: z.string().max(64),
  verificationId: z.string().max(64),
  /** closed list of fields observed in the artifact that the approved schema does not declare (never shown to a model) */
  unclassifiedFields: z.array(z.string().max(210)).max(100),
  groups: z
    .array(
      z.strictObject({
        groupKey: z.string().max(64),
        criterionIds: z.array(z.string().max(64)).max(20),
        fieldIds: z.array(z.string().max(210)).max(50),
        outcome: z.enum(["MODEL_CALLED", "BLOCKED", "NOT_ELIGIBLE"]),
        blockedReason: z.string().max(60).nullable(),
        behaviour: z.string().max(40).nullable(),
        languageExamined: z.number().int().min(0),
        languageFindings: z.number().int().min(0),
      }),
    )
    .max(5),
  modelCalls: z
    .array(
      z.strictObject({
        callId: z.string().max(64),
        role: z.enum(["verifier", "skeptic"]),
        pass: z.number().int().min(1).max(3),
        groupKey: z.string().max(64),
        criterionIds: z.array(z.string().max(64)).max(20),
        fieldIds: z.array(z.string().max(210)).max(50),
        provider: z.string().max(40),
        model: z.string().max(80),
        promptVersion: z.string().max(40),
        policyVersion: z.string().max(40),
        inputManifestHash: sha256,
        inputDigest: sha256,
        outputDigest: sha256.nullable(),
        status: z.enum(["OK", "OUTPUT_INVALID", "TIMEOUT", "ERROR"]),
      }),
    )
    .max(15),
  /** each accepted evidence reference, bound to the criterion it supports and the field/row it addresses */
  evidence: z
    .array(
      z.strictObject({
        criterionId: z.string().max(64),
        ref: z.string().max(300),
        fieldId: z.string().max(210).nullable(),
        row: z.number().int().min(1).nullable(),
        quoteSha256: sha256.nullable(),
        callIds: z.array(z.string().max(64)).max(5),
      }),
    )
    .max(200),
});

export const verificationResultSchema = z
  .object({
    verificationId: z.string().min(8).max(64),
    dealId: z.string(),
    termsHash: sha256,
    artifactSha256: sha256,
    sequence: z.number().int().min(1).max(20),
    overall: z.enum(["ALL_REQUIRED_PASSED", "REQUIRED_FAILED", "REQUIRED_UNVERIFIABLE"]),
    criteriaResults: z.array(criterionResultSchema).min(1).max(20),
    deterministicFailures: z.array(z.string()),
    unverifiableCriteria: z.array(z.string()),
    ai: z
      .object({
        status: z.enum(["NOT_CONFIGURED", "UNAVAILABLE", "COMPLETED"]),
        passes: z.number().int().min(0).max(3),
        observations: z.array(observationSchema).max(60),
        rejected: z.array(z.object({ kind: z.string().max(40), reason: z.string().max(120) }).strict()).max(100),
        summary: z.string().max(1000),
      })
      .strict(),
    skeptic: z
      .object({
        llmStatus: z.enum(["NOT_CONFIGURED", "UNAVAILABLE", "COMPLETED"]),
        flags: z.array(skepticFlagSchema).max(60),
        rejected: z.array(z.object({ kind: z.string().max(40), reason: z.string().max(120) }).strict()).max(100),
      })
      .strict(),
    evidenceReferences: refs,
    provenance: z
      .object({
        artifactSizeBytes: z.number().int(),
        rowCount: z.number().int(),
        columnCount: z.number().int(),
        parserVersion: z.string(),
        aiRunRefs: z.array(z.string()).max(10),
        inputEvidenceRefs: z.array(z.string().max(300)).max(10),
        /** which language policy and scan limits were applied (optional: results recorded before this field existed lack it) */
        scan: z
          .object({
            languageSupported: z.array(z.string().max(8)).max(3),
            languageScope: z.enum(["criterion", "all"]),
            opaqueColumns: z.array(z.string().max(200)).max(100),
            /** an LLM-judged criterion (or scope "all") made model-readable text language-relevant */
            languageRelevant: z.boolean(),
            languageFindings: z.number().int().min(0),
            /** false: a processing limit was hit and part of the file was not checked */
            prescanComplete: z.boolean(),
            /** unreadable-language or unchecked text was kept away from the AI verifier and skeptic */
            aiWithheld: z.boolean(),
          })
          .strict()
          .optional(),
        /** the model-isolation decision taken for this verification (optional: results recorded before it existed lack it) */
        isolation: z
          .object({
            modelCallsPermitted: z.boolean(),
            reason: z.enum(["NO_LLM_CRITERIA", "LLM_CRITERIA_BLOCKED_PENDING_V2", "V2_NO_LLM_CRITERIA", "V2_MODEL_PERMITTED", "V2_MODEL_NOT_PERMITTED"]),
            /** model calls actually made while producing this result (counted at the provider boundary) */
            modelCallsMade: z.number().int().min(0).max(100),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** present on V2 results only; a V1 result never carries it and a V2 result must (checked at intake) */
    binding: bindingSchema.optional(),
    verifierVersion: z.string(),
    createdAt: z.iso.datetime(),
    resultHash: sha256,
  })
  .strict();
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationBinding = z.infer<typeof bindingSchema>;
export type CriterionResult = z.infer<typeof criterionResultSchema>;

// ---- AI output contracts (strict; evidence is validated SEMANTICALLY so one bad item cannot discard the rest) ----
export const aiVerifierOutputSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            criterionId: z.string().max(64),
            verdict: z.enum(["met", "not_met", "unverifiable"]),
            rationale: z.string().max(500),
            evidenceRefs: z.array(z.string().max(300)).max(10),
            quote: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(50),
    observations: z
      .array(
        z
          .object({
            kind: z.enum(["QUALITATIVE", "SUSPICIOUS", "CONTRADICTION", "SUGGESTED_EVIDENCE"]),
            severity,
            text: z.string().max(500),
            evidenceRefs: z.array(z.string().max(300)).max(10),
            quote: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(30),
    summary: z.string().max(1000),
  })
  .strict();
export type AiVerifierOutput = z.infer<typeof aiVerifierOutputSchema>;

export const skepticLlmOutputSchema = z
  .object({
    flags: z
      .array(
        z
          .object({
            code: z.enum(SKEPTIC_CODES),
            severity,
            evidenceRefs: z.array(z.string().max(300)).max(10),
            quote: z.string().max(200).optional(),
            explanation: z.string().max(300),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type SkepticLlmOutput = z.infer<typeof skepticLlmOutputSchema>;
