import type { TermsV1 } from "@/domain/terms";

export const goodTerms = (over: Partial<TermsV1> = {}): TermsV1 => ({
  taskType: "data_cleaning",
  description: "Clean the customer CSV",
  criteria: [
    { id: "schema", text: "Columns match", type: "deterministic", validator: "csv_schema_matches", params: { columns: ["id", "email"] }, required: true, weight: 50 },
    { id: "dupes", text: "No duplicates", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: false, weight: 30 },
    { id: "tidy", text: "Reads cleanly", type: "llm_judged", required: false, weight: 20 },
  ],
  price: "20.00",
  currency: "USD",
  deadline: "2029-01-01T00:00:00.000Z",
  sellerId: "seller-sim",
  mandateId: "m1",
  ...over,
});
