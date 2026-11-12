/**
 * Pure planning for `npm run gen-keys -- --write-env`: given the current text of .env.local, either refuse (a REAL signing key is already there, overwriting it would invalidate
 * every sealed mandate) or return the new text. The `replace_me` placeholders copied from .env.example count as "not set" and are replaced in place, so a fresh checkout works.
 */
const SIGNING_LINES = /^MANDATE_SIGNING_(PRIVATE_KEY|PUBLIC_KEY|KEY_VERSION)=.*(\r?\n|$)/gm;

export function planKeyWrite(current: string, keys: { privateKeyB64: string; publicKeyB64: string }): { ok: true; next: string } | { ok: false } {
  const existing = current.match(/^MANDATE_SIGNING_PRIVATE_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (existing !== "" && existing !== "replace_me") return { ok: false };
  const kept = current.replace(SIGNING_LINES, "");
  const sep = kept === "" || kept.endsWith("\n") ? "" : "\n";
  return { ok: true, next: `${kept}${sep}MANDATE_SIGNING_PRIVATE_KEY=${keys.privateKeyB64}\nMANDATE_SIGNING_PUBLIC_KEY=${keys.publicKeyB64}\nMANDATE_SIGNING_KEY_VERSION=v1\n` };
}
