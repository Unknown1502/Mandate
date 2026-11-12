/** `gen-keys --write-env` planning: placeholders from .env.example are replaced, a real key is never overwritten. */
import { describe, expect, it } from "vitest";
import { planKeyWrite } from "../../scripts/lib/env-keys";

const keys = { privateKeyB64: "NEWPRIVATE", publicKeyB64: "NEWPUBLIC" };

describe("planKeyWrite", () => {
  it("a fresh copy of .env.example (placeholders) gets real keys in place, with no duplicate lines and the other settings untouched", () => {
    const current = "APP_URL=http://localhost:3000\nMANDATE_SIGNING_PRIVATE_KEY=replace_me\nMANDATE_SIGNING_PUBLIC_KEY=replace_me\nMANDATE_SIGNING_KEY_VERSION=v1\nMAX_NEGOTIATION_ROUNDS=4\n";
    const r = planKeyWrite(current, keys);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next).toContain("APP_URL=http://localhost:3000\n");
    expect(r.next).toContain("MAX_NEGOTIATION_ROUNDS=4\n");
    expect(r.next.match(/^MANDATE_SIGNING_PRIVATE_KEY=/gm)).toHaveLength(1);
    expect(r.next.match(/^MANDATE_SIGNING_PUBLIC_KEY=/gm)).toHaveLength(1);
    expect(r.next.match(/^MANDATE_SIGNING_KEY_VERSION=/gm)).toHaveLength(1);
    expect(r.next).toContain("MANDATE_SIGNING_PRIVATE_KEY=NEWPRIVATE\n");
    expect(r.next).not.toContain("replace_me");
  });
  it("an empty file or a file without signing lines gets them appended", () => {
    expect(planKeyWrite("", keys)).toEqual({ ok: true, next: "MANDATE_SIGNING_PRIVATE_KEY=NEWPRIVATE\nMANDATE_SIGNING_PUBLIC_KEY=NEWPUBLIC\nMANDATE_SIGNING_KEY_VERSION=v1\n" });
    const r = planKeyWrite("A=1", keys);
    expect(r.ok && r.next).toBe("A=1\nMANDATE_SIGNING_PRIVATE_KEY=NEWPRIVATE\nMANDATE_SIGNING_PUBLIC_KEY=NEWPUBLIC\nMANDATE_SIGNING_KEY_VERSION=v1\n");
  });
  it("a REAL existing private key (quoted or not, any value other than empty or replace_me) is never overwritten", () => {
    expect(planKeyWrite("MANDATE_SIGNING_PRIVATE_KEY=abc123realkey\n", keys)).toEqual({ ok: false });
    expect(planKeyWrite('MANDATE_SIGNING_PRIVATE_KEY="abc123realkey"\n', keys)).toEqual({ ok: false });
    expect(planKeyWrite("X=1\nMANDATE_SIGNING_PRIVATE_KEY=abc\nMANDATE_SIGNING_PUBLIC_KEY=def\n", keys)).toEqual({ ok: false });
  });
  it("CRLF files are handled and an empty value counts as unset", () => {
    const r = planKeyWrite("A=1\r\nMANDATE_SIGNING_PRIVATE_KEY=\r\nMANDATE_SIGNING_PUBLIC_KEY=\r\n", keys);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.match(/^MANDATE_SIGNING_PRIVATE_KEY=/gm)).toHaveLength(1);
  });
});
