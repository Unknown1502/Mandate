/**
 * GOLDEN V2 vectors (P2). Computed by an INDEPENDENT script that imports nothing from this repository (plain Node crypto and its own canonical-JSON function);
 * the literals below are frozen. They pin the approved byte format of the V2 document and of the signed payload (docs/15 section 15.5.2) without any signing key:
 * the V2 tests sign these exact bytes with an EPHEMERAL test key and the verifier must accept them, which is only possible if the verifier rebuilds the payload byte for byte.
 * Do not edit or regenerate; add new vectors instead.
 */
export const GOLDEN_V2 = Object.freeze({
  keyVersion: "k2",
  approvedBy: "principal@example.com",
  approvedAt: "2026-11-08T12:00:00.000Z",
  approvalMethod: "EXPLICIT_DIGEST_CONFIRMATION",
  mandateId: "c0123456789abcdefghijklmn",
  nonce: "00112233445566778899aabbccddeeff",
  /** the exact canonical document text that is hashed and sealed */
  documentText: "{\"allowPartialSettlement\":false,\"allowPreDeliveryCancellation\":true,\"allowedTaskTypes\":[\"data_cleaning\"],\"budgetTotal\":\"100.00\",\"carryOver\":null,\"counterparties\":[\"seller-a\",\"seller-b\"],\"currency\":\"USD\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"injectionPolicy\":\"HUMAN_REVIEW\",\"languagePolicy\":{\"criterionScope\":[],\"detector\":{\"id\":\"mandate-lexical-detector\",\"version\":\"1.0.0\",\"vocabularyHash\":\"sha256:da1dbb57e324916c1c2f5357f672d6da2156f298ef23839f57b78a08cb97c56b\"},\"humanReview\":{\"required\":true},\"incompleteScanBehavior\":\"UNVERIFIABLE_HUMAN_REVIEW\",\"nameLikeBehavior\":\"UNCERTAIN\",\"policyVersion\":1,\"schema\":\"mandate.languagePolicy/1\",\"shortText\":\"NO_EXEMPTION\",\"supportedLanguages\":[\"en\",\"fr\",\"zh\"],\"uncertainBehavior\":\"UNVERIFIABLE_HUMAN_REVIEW\",\"unsupportedBehavior\":\"UNVERIFIABLE_HUMAN_REVIEW\"},\"mandateId\":\"c0123456789abcdefghijklmn\",\"nonce\":\"00112233445566778899aabbccddeeff\",\"perDealMax\":\"25.00\",\"principalId\":\"principal-golden-1\",\"requireHumanAbove\":\"10.00\",\"schemaVersion\":2}",
  /** sha256 of documentText */
  documentDigest: "c6d9efad0ec19f8992d3d6ab33b2a0c4fffcee25fc59738ace20f1c5c8e14930",
  languagePolicyHash: "854da72d08b121ac52f9b6bbed1e60413990512afcbaf0ae09386b0766ad06bb",
  /** sha256 of the canonical JSON of null, i.e. of the text "null" */
  carryOverHash: "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
  /** the exact message that is signed */
  signedPayloadText: "{\"approvalMethod\":\"EXPLICIT_DIGEST_CONFIRMATION\",\"approvedAt\":\"2026-11-08T12:00:00.000Z\",\"approvedBy\":\"principal@example.com\",\"authorization\":{\"allowPartialSettlement\":false,\"allowPreDeliveryCancellation\":true,\"allowedTaskTypes\":[\"data_cleaning\"],\"budgetTotal\":\"100.00\",\"counterparties\":[\"seller-a\",\"seller-b\"],\"currency\":\"USD\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"injectionPolicy\":\"HUMAN_REVIEW\",\"perDealMax\":\"25.00\",\"requireHumanAbove\":\"10.00\"},\"carryOverHash\":\"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b\",\"keyVersion\":\"k2\",\"languagePolicyHash\":\"854da72d08b121ac52f9b6bbed1e60413990512afcbaf0ae09386b0766ad06bb\",\"mandateDigest\":\"c6d9efad0ec19f8992d3d6ab33b2a0c4fffcee25fc59738ace20f1c5c8e14930\",\"mandateId\":\"c0123456789abcdefghijklmn\",\"principalId\":\"principal-golden-1\",\"purpose\":\"mandate-seal\",\"schemaVersion\":2,\"sealVersion\":2}",
  signedPayloadDigest: "b37b62e28dbd226dda6fcaff50ffef15aab789edddd45b39a54cbceaa9e555a6",
});
