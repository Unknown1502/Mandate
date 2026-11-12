/**
 * IMMUTABLE historical fixtures (P1). These are byte-for-byte copies of the OLDEST stored row of each shape found in the mandate_test database on 2026-11-08
 * (read-only query), with the digest / terms hash that was stored with it. They are GOLDEN: if a change to the canonical form, the hashing or a reader makes any of
 * them read differently, a P1 test fails. Do NOT edit, "fix" or regenerate them; add new fixtures instead.
 *
 * Selection rule: the oldest row of the shape whose stored digest equals sha256(canonicalJson). (The very oldest base-shape row is a deliberate TAMPER fixture from the
 * mandate-tamper tests - its digest does not match its bytes - so it is not a historical fixture; 125 of 16,297 stored rows are such fixtures.)
 * Mandate documents carry no version field. The three shapes differ only in which behaviour flags exist (the flags were added over time):
 *   V1_BASE                  neither allowPartialSettlement nor allowPreDeliveryCancellation   (64 rows, 62 with a matching digest, at the time)
 *   V1_NO_CANCELLATION_FLAG  allowPartialSettlement only                                       (969 rows)
 *   V1_FULL                  both flags                                                        (13,083 rows)
 */
export interface MandateFixture {
  shape: "V1_BASE" | "V1_NO_CANCELLATION_FLAG" | "V1_FULL";
  /** the exact stored canonicalJson string */
  canonicalJson: string;
  /** the stored mandateDigest = sha256(canonicalJson) */
  digest: string;
}

export const MANDATE_FIXTURES: readonly MandateFixture[] = Object.freeze([
  {
    shape: "V1_BASE",
    canonicalJson:
      '{"allowedTaskTypes":["data_cleaning"],"budgetTotal":"30.00","counterparties":["seller-sim"],"currency":"USD","expiresAt":"2030-01-01T00:00:00.000Z","injectionPolicy":"HUMAN_REVIEW","perDealMax":"30.00","principalId":"cmw3vgu6s0008vfycmzlq84eu","requireHumanAbove":null}',
    digest: "941c8cd83bfd4b0b4b27251877df5aac411f1ee3c8663337505771957d0f66ae",
  },
  {
    shape: "V1_NO_CANCELLATION_FLAG",
    canonicalJson:
      '{"allowPartialSettlement":false,"allowedTaskTypes":["data_cleaning"],"budgetTotal":"100.00","counterparties":["seller-sim"],"currency":"USD","expiresAt":"2030-01-01T00:00:00.000Z","injectionPolicy":"HUMAN_REVIEW","perDealMax":"60.00","principalId":"cmw3wn5le0000vfns60y05qtz","requireHumanAbove":"50.00"}',
    digest: "fd52c3f96ed8a815248a9ba48a2e4eb3c730138738b849a6ddc88f90909f6c92",
  },
  {
    shape: "V1_FULL",
    canonicalJson:
      '{"allowPartialSettlement":false,"allowPreDeliveryCancellation":true,"allowedTaskTypes":["data_cleaning"],"budgetTotal":"100.00","counterparties":["seller-sim"],"currency":"USD","expiresAt":"2030-01-01T00:00:00.000Z","injectionPolicy":"HUMAN_REVIEW","perDealMax":"60.00","principalId":"cmw3xoefu0000vfd4exqasaje","requireHumanAbove":"50.00"}',
    digest: "5417e471be54dca9027b4ecf538b6250d0db175ed8dd32ea228dd5ef1c58b7e9",
  },
]);

export interface TermsFixture {
  name: string;
  /** the stored termsJson (jsonb: key order is not significant) */
  terms: Record<string, unknown>;
  /** the stored termsHash = sha256(canonicalJson(normalizeTerms(terms))) */
  hash: string;
}

export const TERMS_FIXTURES: readonly TermsFixture[] = Object.freeze([
  {
    name: "one LLM-judged and one deterministic criterion",
    terms: {
      price: "20.00",
      criteria: [
        { id: "quality", text: "quality", type: "llm_judged", weight: 50, required: true },
        { id: "schema", text: "schema", type: "deterministic", params: {}, weight: 50, required: true, validator: "no_duplicate_rows" },
      ],
      currency: "USD",
      deadline: "2029-01-01T00:00:00.000Z",
      sellerId: "seller-sim",
      taskType: "data_cleaning",
      mandateId: "cmw3wnef900qzvfns8xusplhn",
      description: "Clean the CSV",
    },
    hash: "d5a49bee805a8db4cd2e361fc8f245c7459760025e10d16b2bf5a2c173f78f5c",
  },
  {
    name: "two deterministic criteria, one with array params",
    terms: {
      price: "25.00",
      criteria: [
        { id: "dupes", text: "No duplicates", type: "deterministic", params: {}, weight: 30, required: false, validator: "no_duplicate_rows" },
        { id: "schema", text: "Columns match", type: "deterministic", params: { columns: ["id"] }, weight: 70, required: true, validator: "csv_schema_matches" },
      ],
      currency: "USD",
      deadline: "2029-01-01T00:00:00.000Z",
      sellerId: "seller-sim",
      taskType: "data_cleaning",
      mandateId: "cmw3vgu6x000avfycetfyj5pc",
      description: "Clean the CSV",
    },
    hash: "682cead3eeebe51d20b8af06a33d5dfea7941107a8e4ccc3b29fcdb02c39f7f1",
  },
]);
