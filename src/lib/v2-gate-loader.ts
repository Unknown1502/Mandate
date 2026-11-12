/**
 * Loader for the V2 release gate (composition root only). Reads the deployment opt-in, the signed release record and the running source tree, then asks the PURE gate
 * (src/domain/v2-release-gate.ts) for a decision. Nothing here can open the gate by itself: a missing opt-in, record, key or digest keeps V2 closed.
 *
 *   MANDATE_V2_ENABLED=true            deployment opt-in (necessary, never sufficient)
 *   MANDATE_V2_RELEASE_RECORD=<path>   the signed release record produced by scripts/issue-v2-release.ts after the QA campaign
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { KeyRegistry } from "../domain/key-registry";
import { digestOfLines, evaluateV2Gate, type V2GateDecision } from "../domain/v2-release-gate";
import { parseStrictJson } from "./strict-json";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

/** digest of the source tree that is running (the same function the issuing tool uses); null when the tree is not present */
export function computeSourceDigest(root: string = process.cwd()): string | null {
  const src = resolve(root, "src");
  if (!existsSync(src)) return null;
  return digestOfLines(walk(src).map((f) => `${relative(root, f).replace(/\\/g, "/")}  ${createHash("sha256").update(readFileSync(f)).digest("hex")}`));
}

export function loadV2Gate(env: Record<string, string | undefined>, registry: KeyRegistry, now: Date = new Date(), root: string = process.cwd()): V2GateDecision {
  const path = env.MANDATE_V2_RELEASE_RECORD;
  let record: unknown = null;
  if (path && existsSync(path)) {
    const parsed = parseStrictJson(readFileSync(path, "utf8"), { maxBytes: 32_768 });
    record = parsed.ok ? parsed.value : "unparseable";
  }
  return evaluateV2Gate({ optedIn: env.MANDATE_V2_ENABLED === "true", record, registry, now, runtimeSourceDigest: computeSourceDigest(root) });
}
