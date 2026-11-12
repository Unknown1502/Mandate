/**
 * A V2 release gate for TESTS. It is not an override: it is an ordinary signed release record issued with an EPHEMERAL test key and verified against a registry that holds
 * only that key, so it can never open the gate of a registry that holds a production key.
 */
import { evaluateV2Gate, issueReleaseRecord, type V2GateOpen } from "@/domain/v2-release-gate";
import type { KeyRegistry } from "@/domain/key-registry";
import type { SigningKeys } from "@/domain/signing";

const sha = (c: string) => c.repeat(64);
export const TEST_SOURCE_DIGEST = sha("a");

export function testReleaseRecord(keys: SigningKeys, over: { issuedAt?: Date; days?: number } = {}) {
  const issued = over.issuedAt ?? new Date(Date.now() - 60_000);
  const v = { status: "PASS" as const, evidenceSha256: sha("b") };
  return issueReleaseRecord(
    { sourceDigest: TEST_SOURCE_DIGEST, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + (over.days ?? 7) * 86_400_000).toISOString(), validations: { P2: v, P3: v, P4: v, P5: v, P7: v, SECURITY_REGRESSION: v }, securitySuites: ["test-suites"] },
    keys,
  );
}

export function openTestGate(keys: SigningKeys, registry: KeyRegistry): V2GateOpen {
  const d = evaluateV2Gate({ optedIn: true, record: testReleaseRecord(keys), registry, now: new Date(), runtimeSourceDigest: TEST_SOURCE_DIGEST });
  if (!d.open) throw new Error(`test gate did not open: ${d.reasons.join(",")}`);
  return d.gate;
}
