/**
 * V2 RELEASE GATE (final directive, part 7). V2 mandates, V2 terms and every V2 read are DISABLED unless a valid gate decision is supplied. There is no flag, environment
 * variable or code path that opens the gate by itself: it opens only for a RELEASE RECORD that
 *   - is signed with the application key under the key registry (purpose "v2-release-gate"),
 *   - states PASS for P2 (verifier available), P3, P4, P5 and P7 AND for the security regression suites, each with the sha256 of the evidence it rests on,
 *   - names the sha256 of the source tree it was issued for, which must equal the digest of the code that is actually running,
 *   - has not expired (a record is valid for at most 30 days, forcing the QA campaign to be repeated),
 * and, in addition, the deployment must explicitly opt in (MANDATE_V2_ENABLED=true is read by the loader, never here).
 *
 * "Test-only override": none exists. Tests build their own registry with an ephemeral key and sign their own record, which can never verify against a production registry.
 * This module is PURE (no file, environment or network access); the loader in src/lib/v2-gate-loader.ts reads the files.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { parseStrictJson } from "../lib/strict-json";
import { publicKeyFingerprint, type KeyRegistry } from "./key-registry";
import { signMessage, verifyMessage, type SigningKeys } from "./signing";

export const GATE_PURPOSE = "v2-release-gate";
export const GATE_MAX_VALIDITY_MS = 30 * 86_400_000;
export const GATE_REQUIREMENTS = ["P2", "P3", "P4", "P5", "P7", "SECURITY_REGRESSION"] as const;
export type GateRequirement = (typeof GATE_REQUIREMENTS)[number];

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime();
const validation = z.strictObject({ status: z.literal("PASS"), evidenceSha256: sha });

export const releaseRecordPayloadSchema = z.strictObject({
  purpose: z.literal(GATE_PURPOSE),
  keyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  sourceDigest: sha,
  issuedAt: instant,
  expiresAt: instant,
  validations: z.strictObject({ P2: validation, P3: validation, P4: validation, P5: validation, P7: validation, SECURITY_REGRESSION: validation }),
  /** names of the suites the security-regression PASS covers (recorded, not interpreted) */
  securitySuites: z.array(z.string().max(80)).min(1).max(40),
});
export type ReleaseRecordPayload = z.infer<typeof releaseRecordPayloadSchema>;

export const releaseRecordSchema = z.strictObject({ payloadJson: z.string().min(2).max(16_384), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) });
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

/** Issue (sign) a record. Used ONLY by the QA release tool after the campaign; production code never calls it. */
export function issueReleaseRecord(payload: Omit<ReleaseRecordPayload, "purpose" | "keyVersion">, keys: SigningKeys): ReleaseRecord {
  const full = releaseRecordPayloadSchema.parse({ purpose: GATE_PURPOSE, keyVersion: keys.keyVersion, ...payload });
  if (new Date(full.expiresAt).getTime() - new Date(full.issuedAt).getTime() > GATE_MAX_VALIDITY_MS) throw new Error("release record validity exceeds 30 days");
  const payloadJson = canonicalJson(full);
  return { payloadJson, signature: signMessage(payloadJson, keys.privateKeyB64) };
}

export const GATE_CLOSED_REASONS = [
  "NOT_OPTED_IN",
  "NO_RECORD",
  "RECORD_MALFORMED",
  "RECORD_NON_CANONICAL",
  "KEY_NOT_TRUSTED",
  "SIGNATURE_INVALID",
  "RECORD_EXPIRED",
  "RECORD_NOT_YET_VALID",
  "RECORD_VALIDITY_TOO_LONG",
  "SOURCE_DIGEST_MISMATCH",
  "SOURCE_DIGEST_UNAVAILABLE",
] as const;
export type GateClosedReason = (typeof GATE_CLOSED_REASONS)[number];

const OPEN = new WeakSet<object>();
export interface V2GateOpen {
  readonly kind: "V2GateOpen";
  readonly sourceDigest: string;
  readonly expiresAt: string;
  readonly requirements: readonly GateRequirement[];
}
export type V2GateDecision = { open: true; gate: V2GateOpen } | { open: false; reasons: GateClosedReason[] };

/** the only constructor of a V2GateOpen: a value that was NOT returned by evaluateV2Gate is rejected by isV2GateOpen */
export const isV2GateOpen = (g: unknown): g is V2GateOpen => typeof g === "object" && g !== null && OPEN.has(g);

/** a gate that still holds a decision made earlier is re-checked against the clock at every use */
export const gateStillValid = (g: V2GateOpen | undefined, now: Date): g is V2GateOpen => isV2GateOpen(g) && new Date(g.expiresAt).getTime() > now.getTime();

export function evaluateV2Gate(i: { optedIn: boolean; record: unknown; registry: KeyRegistry; now: Date; runtimeSourceDigest: string | null }): V2GateDecision {
  const closed = (...reasons: GateClosedReason[]): V2GateDecision => ({ open: false, reasons });
  try {
    if (!i.optedIn) return closed("NOT_OPTED_IN");
    if (i.record === null || i.record === undefined) return closed("NO_RECORD");
    const rec = releaseRecordSchema.safeParse(i.record);
    if (!rec.success) return closed("RECORD_MALFORMED");
    const json = parseStrictJson(rec.data.payloadJson, { maxBytes: 16_384 });
    if (!json.ok) return closed("RECORD_MALFORMED");
    const p = releaseRecordPayloadSchema.safeParse(json.value);
    if (!p.success) return closed("RECORD_MALFORMED");
    if (canonicalJson(p.data) !== rec.data.payloadJson) return closed("RECORD_NON_CANONICAL");
    const key = i.registry.lookup(p.data.keyVersion);
    if (!key || key.status !== "ACTIVE" || key.algorithm !== "ed25519" || publicKeyFingerprint(key.publicKeyB64) !== key.fingerprint) return closed("KEY_NOT_TRUSTED");
    if (!verifyMessage(rec.data.payloadJson, rec.data.signature, key.publicKeyB64)) return closed("SIGNATURE_INVALID");
    const issued = new Date(p.data.issuedAt).getTime();
    const expires = new Date(p.data.expiresAt).getTime();
    if (expires - issued > GATE_MAX_VALIDITY_MS) return closed("RECORD_VALIDITY_TOO_LONG");
    if (issued > i.now.getTime()) return closed("RECORD_NOT_YET_VALID");
    if (expires <= i.now.getTime()) return closed("RECORD_EXPIRED");
    if (i.runtimeSourceDigest === null) return closed("SOURCE_DIGEST_UNAVAILABLE");
    if (i.runtimeSourceDigest !== p.data.sourceDigest) return closed("SOURCE_DIGEST_MISMATCH");
    const gate: V2GateOpen = Object.freeze({ kind: "V2GateOpen" as const, sourceDigest: p.data.sourceDigest, expiresAt: p.data.expiresAt, requirements: Object.freeze([...GATE_REQUIREMENTS]) });
    OPEN.add(gate);
    return { open: true, gate };
  } catch {
    return closed("RECORD_MALFORMED");
  }
}

/** digest of a list of "path  sha256" lines, the form both the issuing tool and the loader compute */
export const digestOfLines = (lines: readonly string[]): string => sha256Hex([...lines].sort().join("\n"));
