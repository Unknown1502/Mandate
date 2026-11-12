/**
 * Language policy strictness lattice (P3; docs/15 sections 15.3.3 and 15.6.2). PURE: no I/O.
 *
 *   A is "at least as strict as" B  iff  A permits nothing B forbids:
 *     - A's supported languages are a subset of B's;
 *     - each behaviour in A is at least as strict as in B   (REJECT_DELIVERY > UNVERIFIABLE_HUMAN_REVIEW; there is no "allow" value);
 *     - human review required in B  =>  required in A;
 *     - every criterion B scopes is scoped by A too;
 *     - the detector is IDENTICAL (id, version and vocabulary hash). Detectors are never compared by name or ranked: a "successor" detector is a different
 *       detector and needs a new approval (strictest reading of docs/15 15.6.2; a registered-successor rule is NOT implemented).
 *
 * The signed mandate carries the FLOOR; the locked terms carry a policy that must be at least as strict; a deployment floor may tighten further and can never loosen.
 */
import { canonicalJson, sha256Hex } from "./canonical";
import type { languagePolicyV1Schema } from "./mandate-v2";
import type { z } from "zod";

export type LanguagePolicy = z.infer<typeof languagePolicyV1Schema>;
export type Language = LanguagePolicy["supportedLanguages"][number];
export type Behaviour = LanguagePolicy["unsupportedBehavior"];

const RANK: Record<Behaviour, number> = { UNVERIFIABLE_HUMAN_REVIEW: 1, REJECT_DELIVERY: 2 };
const strictest = (a: Behaviour, b: Behaviour): Behaviour => (RANK[a] >= RANK[b] ? a : b);

export const languagePolicyHash = (p: LanguagePolicy): string => sha256Hex(canonicalJson(p));

export const sameDetector = (a: LanguagePolicy["detector"], b: LanguagePolicy["detector"]): boolean =>
  a.id === b.id && a.version === b.version && a.vocabularyHash === b.vocabularyHash;

export type StrictnessFailure =
  | "LANGUAGE_WIDENED"
  | "UNSUPPORTED_BEHAVIOUR_WEAKER"
  | "UNCERTAIN_BEHAVIOUR_WEAKER"
  | "INCOMPLETE_SCAN_BEHAVIOUR_WEAKER"
  | "HUMAN_REVIEW_WEAKER"
  | "SCOPE_NARROWED"
  | "DETECTOR_DIFFERS";

/** All dimensions in which `a` is weaker than `b` (empty = a is at least as strict as b). */
export function strictnessFailures(a: LanguagePolicy, b: LanguagePolicy): StrictnessFailure[] {
  const out: StrictnessFailure[] = [];
  const bLangs = new Set<string>(b.supportedLanguages);
  if (a.supportedLanguages.some((l) => !bLangs.has(l))) out.push("LANGUAGE_WIDENED");
  if (RANK[a.unsupportedBehavior] < RANK[b.unsupportedBehavior]) out.push("UNSUPPORTED_BEHAVIOUR_WEAKER");
  if (RANK[a.uncertainBehavior] < RANK[b.uncertainBehavior]) out.push("UNCERTAIN_BEHAVIOUR_WEAKER");
  if (RANK[a.incompleteScanBehavior] < RANK[b.incompleteScanBehavior]) out.push("INCOMPLETE_SCAN_BEHAVIOUR_WEAKER");
  if (b.humanReview.required && !a.humanReview.required) out.push("HUMAN_REVIEW_WEAKER");
  const aScope = new Set(a.criterionScope.map((s) => s.criterionId));
  if (b.criterionScope.some((s) => !aScope.has(s.criterionId))) out.push("SCOPE_NARROWED");
  if (!sameDetector(a.detector, b.detector)) out.push("DETECTOR_DIFFERS");
  return out;
}

export const isAtLeastAsStrict = (a: LanguagePolicy, b: LanguagePolicy): boolean => strictnessFailures(a, b).length === 0;

/** A deployment may only tighten. Every field is optional; an absent field constrains nothing. */
export interface DeploymentFloor {
  supportedLanguages?: readonly Language[];
  unsupportedBehavior?: Behaviour;
  uncertainBehavior?: Behaviour;
  incompleteScanBehavior?: Behaviour;
  humanReviewRequired?: boolean;
  /** extra field ids the deployment declares opaque (union with nothing else: it can only withhold more) */
  opaqueOverlay?: readonly string[];
}

/** The policy actually enforced at verification time. supportedLanguages may be EMPTY here (then every text is unsupported); that is stricter, never an error. */
export interface EffectiveLanguagePolicy extends Omit<LanguagePolicy, "supportedLanguages"> {
  supportedLanguages: Language[];
  opaqueOverlay: string[];
}

/**
 * stricterOf(P, F): intersection of languages, strictest behaviours, OR of human review, union of opaque overlays. The detector is always P's (a deployment cannot change it).
 * Properties (property-tested): effective is at least as strict as P in every dimension for every F; idempotent; F absent => P unchanged.
 */
export function stricterOf(p: LanguagePolicy, f: DeploymentFloor | undefined): EffectiveLanguagePolicy {
  const floorLangs = f?.supportedLanguages ? new Set<string>(f.supportedLanguages) : null;
  return {
    ...p,
    supportedLanguages: p.supportedLanguages.filter((l) => (floorLangs ? floorLangs.has(l) : true)),
    unsupportedBehavior: f?.unsupportedBehavior ? strictest(p.unsupportedBehavior, f.unsupportedBehavior) : p.unsupportedBehavior,
    uncertainBehavior: f?.uncertainBehavior ? strictest(p.uncertainBehavior, f.uncertainBehavior) : p.uncertainBehavior,
    incompleteScanBehavior: f?.incompleteScanBehavior ? strictest(p.incompleteScanBehavior, f.incompleteScanBehavior) : p.incompleteScanBehavior,
    humanReview: { required: p.humanReview.required || f?.humanReviewRequired === true },
    opaqueOverlay: [...new Set(f?.opaqueOverlay ?? [])].sort(),
  };
}

export const effectivePolicyHash = (e: EffectiveLanguagePolicy): string => sha256Hex(canonicalJson(e));

/** Dimensions in which a deployment floor is WEAKER than the signed policy (recorded in the result, never silent; the signed value wins in every one of them). */
export function weakerDimensions(p: LanguagePolicy, f: DeploymentFloor | undefined): string[] {
  if (!f) return [];
  const out: string[] = [];
  if (f.supportedLanguages && f.supportedLanguages.some((l) => !p.supportedLanguages.includes(l))) out.push("supportedLanguages");
  if (f.unsupportedBehavior && RANK[f.unsupportedBehavior] < RANK[p.unsupportedBehavior]) out.push("unsupportedBehavior");
  if (f.uncertainBehavior && RANK[f.uncertainBehavior] < RANK[p.uncertainBehavior]) out.push("uncertainBehavior");
  if (f.incompleteScanBehavior && RANK[f.incompleteScanBehavior] < RANK[p.incompleteScanBehavior]) out.push("incompleteScanBehavior");
  if (f.humanReviewRequired === false && p.humanReview.required) out.push("humanReview");
  return out;
}
