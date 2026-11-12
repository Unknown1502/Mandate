/** P4: the runner re-checks the manifest of a genuinely branded input before any provider is touched. */
import { describe, expect, it, vi } from "vitest";
import { aiVerifierOutputSchema } from "@/verification/contracts";
import { ModelInputViolation, ModelRunner } from "@/verification/model-runner";
import * as real from "@/verification/model-input";
import { assessAndClear } from "@/verification/language-v2";
import { ScriptedLlm } from "../helpers/scripted";
import type { DealAuthorization } from "@/domain/authorization";
import { modelGroups, normalizeTermsV2 } from "@/domain/terms-v2";
import { fakeMandateId, llmTermsV2 } from "../helpers/v2Fixtures";

vi.mock("@/verification/model-input", async (orig) => {
  const mod = await orig<typeof import("@/verification/model-input")>();
  return { ...mod, manifestViolations: (i: unknown) => (globalThis as { __force?: string[] }).__force ?? mod.manifestViolations(i as never) };
});

describe("ModelRunner manifest guard", () => {
  it("a branded input whose manifest check reports a violation never reaches the provider", async () => {
    const t = normalizeTermsV2(llmTermsV2(fakeMandateId()));
    const fake = { deal: { id: "d" }, mandate: { version: 2, mandateDigest: "d".repeat(64), keyVersion: "k", doc: { mandateId: t.mandateId } }, terms: { version: 2, terms: t, termsHash: "e".repeat(64) }, attestation: { approvalNonce: "ab".repeat(16) } } as unknown as DealAuthorization;
    const d = real.deriveModelAuthorization(fake, undefined, modelGroups(t));
    if (!d.ok) throw new Error("fixture");
    const csv = { headers: ["description", "delivery_notes"], rows: [["The record was cleaned and merged", "The notes were checked by the team"]] };
    const b = real.buildModelInput({ authorization: d.authorization, groupKey: d.authorization.groups[0]!.key, role: "verifier", pass: 1, artifact: { csv, sha12: "a".repeat(12), sha256: "a".repeat(64), deliveryId: "x" }, deterministic: [] });
    if (!b.ok) throw new Error("fixture");
    expect(assessAndClear(b.input).blocked).toBe(false);
    const llm = new ScriptedLlm(["{}"]);
    (globalThis as { __force?: string[] }).__force = ["FORCED_VIOLATION"];
    try {
      await expect(new ModelRunner(llm, "m").run(b.input, aiVerifierOutputSchema)).rejects.toBeInstanceOf(ModelInputViolation);
      expect(llm.requests).toHaveLength(0);
    } finally {
      delete (globalThis as { __force?: string[] }).__force;
    }
    // and with no forced violation the very same input runs
    expect((await new ModelRunner(llm, "m").run(b.input, aiVerifierOutputSchema)).manifest.status).toBe("OUTPUT_INVALID");
    expect(llm.requests.length).toBeGreaterThan(0);
  });
});
