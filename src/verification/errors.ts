export class VerificationError extends Error {
  constructor(
    public readonly code:
      | "NO_DELIVERY"
      | "TERMS_DRIFT"
      | "ARTIFACT_INTEGRITY_FAILURE"
      | "PREVIOUS_RUN_MISSING"
      | "EVIDENCE_REQUIRED"
      | "DEAL_NOT_FOUND"
      | "IN_PROGRESS"
      /** V2: the stored authorization (mandate seal, attestation, language policy floor ...) no longer holds; nothing is verified */
      | "AUTHORIZATION_INVALID",
  ) {
    super(code);
    this.name = "VerificationError";
  }
}
