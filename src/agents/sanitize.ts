/**
 * Handling of UNTRUSTED counterparty text and the outbound leak guard. Pure functions, no imports.
 * This reduces but does not eliminate prompt-injection risk; the real protection is that nothing an LLM
 * says can change state without passing deterministic validation (see src/domain/negotiation.ts).
 */
export interface Sanitized {
  text: string;
  flags: string[];
}

const ZERO_WIDTH = /[​-‏⁠-⁤﻿]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeUntrusted(input: string, maxLen = 1000): Sanitized {
  const flags: string[] = [];
  let t = String(input).normalize("NFKC");
  if (ZERO_WIDTH.test(t) || TAG_CHARS.test(t)) flags.push("HIDDEN_TEXT");
  if (BIDI.test(t)) flags.push("BIDI_CONTROL");
  if (CONTROL.test(t)) flags.push("CONTROL_CHARS");
  t = t.replace(ZERO_WIDTH, "").replace(TAG_CHARS, "").replace(BIDI, "").replace(CONTROL, "");
  if (/[<>]/.test(t)) {
    flags.push("MARKUP_NEUTRALIZED");
    // Angle brackets can never appear in untrusted text, so it cannot forge or close our delimiter tags.
    t = t.replace(/</g, "‹").replace(/>/g, "›");
  }
  if (t.length > maxLen) {
    flags.push("TRUNCATED");
    t = t.slice(0, maxLen);
  }
  return { text: t, flags };
}

/** The only way counterparty text enters a prompt. The id is ours, never the counterparty's. */
export function wrapUntrusted(tag: string, id: string, text: string): string {
  return `<untrusted_${tag} id="${id}">\n${text}\n</untrusted_${tag}>`;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/,
  /[A-Za-z0-9+/_-]{40,}={0,2}/, // long base64/base64url-looking blob
  /(client[_-]?secret|api[_-]?key|access[_-]?token|private[_-]?key|PAYPAL_[A-Z_]+|MANDATE_SIGNING|SESSION_SECRET|DATABASE_URL)/i,
];

export interface OutboundCheck {
  ok: boolean;
  violations: string[];
}

/** numeric-aware match so "100" is caught but "1000" or "rows: 100000" are not confused with "100.00" */
function numberPattern(v: string): RegExp | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const int = m[1]!;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  const body = frac ? `${int}\\.${frac}0*` : `${int}(?:\\.0+)?`;
  return new RegExp(`(?<![\\d.,])${body}(?![\\d]|\\.\\d)`);
}

/**
 * Check free text the BUYER is about to send to the counterparty. `protectedValues` are the mandate limits, ceilings,
 * identifiers and the system-prompt canary that must never leave the building.
 */
export function checkOutbound(text: string | undefined, protectedValues: string[]): OutboundCheck {
  if (!text) return { ok: true, violations: [] };
  const violations: string[] = [];
  for (const v of protectedValues) {
    if (!v) continue;
    const num = numberPattern(v);
    if (num ? num.test(text) : text.toLowerCase().includes(v.toLowerCase())) violations.push("PROTECTED_VALUE");
  }
  for (const re of SECRET_PATTERNS) if (re.test(text)) violations.push("SECRET_PATTERN");
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
