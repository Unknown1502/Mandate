/**
 * Reader-compatibility markers (P1). They state, in one place and in a form a deployment check can read, which authorization-document versions THIS build
 * reads. GET /api/health publishes them so a release check can confirm every instance runs the guarded readers before any future version is ever written.
 * This module only DESCRIBES the readers; it enables nothing. P3: V2 mandates and V2 terms can be written and read (human-approved, application-attested);
 * V2 LLM-judged criteria additionally need the deployment switch (off by default, docs/15 Q3).
 */
import { MANDATE_V1_SHAPES } from "./mandate";

/** bump whenever the set of readable authorization-document versions or shapes changes */
export const READER_GUARD_VERSION = "p3-v1-v2";

export const AUTHORIZATION_READERS = Object.freeze({
  guard: READER_GUARD_VERSION,
  mandateShapes: [...MANDATE_V1_SHAPES],
  termsVersions: [1, 2],
  /** mandate seal versions: 1 = legacy seal (unchanged), 2 = V2 seal (verified through the key registry) */
  mandateSealVersions: [1, 2],
  /** an explicit schemaVersion on a mandate, on terms or on a criterion is refused, never read as V1 */
  unknownVersions: "refused",
  /** unknown authorization fields are refused, never stripped */
  unknownFields: "refused",
  /** duplicate JSON keys in text payloads are refused */
  duplicateKeys: "refused",
  /** V2 mandate writer (two-step digest confirmation), V2 terms lock and TermsAttestation writer exist (P3) */
  v2Writers: "mandate+terms+attestation",
  /** the V2 seal verifier is reached only through the mandate opener (openMandateRow) and the writer's pre-persist self-check */
  v2SealVerifier: "connected-via-opener",
} as const);
