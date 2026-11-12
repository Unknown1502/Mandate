/**
 * Confusable-character handling for the pre-model defence (final QA, Stage B1). PURE: no I/O.
 *
 * THE PROBLEM. An English override instruction ("Ignore all previous instructions") written with Cyrillic or Greek look-alike letters ("Ignоre ...") does not match
 * a pattern written for Latin text, and a classifier that tests language by stop-words sees mostly-Latin prose.
 *
 * STRATEGY (documented, not a phrase list). Two structural checks that do NOT depend on which words the attacker chose, plus one re-screen:
 *   1. MIXED-SCRIPT TOKEN (UTS #39 "mixed-script" restriction): a single word whose letters come from more than one of Latin, Cyrillic, Greek, Armenian, Cherokee. Real words
 *      are written in one script; a word that is not is a visual-spoofing signal. -> UNCERTAIN (fails closed: UNVERIFIABLE + human review, never PASS).
 *   2. WHOLE-SCRIPT CONFUSABLE TOKEN: a word entirely in a non-Latin script whose skeleton is entirely ASCII letters, inside a text that also contains Latin letters (the
 *      pattern "pар" for "pap"). Real Cyrillic / Greek words virtually always contain letters with no Latin look-alike; short exceptions are blocked too (fail closed).
 *   3. SKELETON RE-SCREEN: the text is reduced to its UTS #39-style skeleton (compatibility-normalised, combining marks removed, confusables mapped to their Latin
 *      prototypes, confusable punctuation and spaces mapped) and the ordinary override rules are run on it as well as on the original, so a combining-mark or fullwidth
 *      variant that survives the other checks still matches.
 * The skeleton is used ONLY to screen. The original text is what is stored, hashed, quoted and cited as evidence; nothing in this module rewrites content.
 *
 * LIMITS, stated plainly. The table is a CURATED SUBSET of the Unicode confusables data (Latin targets only; the common Cyrillic, Greek, Armenian and typographic
 * look-alikes), not the full confusables.txt; it is part of the detector's vocabulary hash, so extending it is a reviewed, versioned change. Paraphrases ("pay no attention
 * to what came before"), letter-spaced words ("i g n o r e"), languages outside the supported set and look-alikes outside the table are NOT detected here: for those the
 * protection is structural (unsupported / uncertain text is never sent to a model, and a model's output cannot move money).
 */

/** curated subset of UTS #39 confusables -> Latin prototype. Keys are single code points. */
export const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic lower case
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ѵ": "v", "ө": "o", "ґ": "r", "г": "r", "к": "k",
  // Cyrillic upper case
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
  "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S", "Ӏ": "I", "Ѵ": "V",
  // Greek lower case
  "ο": "o", "ν": "v", "α": "a", "ρ": "p", "υ": "u", "ι": "i", "κ": "k", "γ": "y", "χ": "x",
  // Greek upper case
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O",
  "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  // Armenian / Cherokee / other letters commonly used for spoofing
  "օ": "o", "ո": "n", "ռ": "n", "հ": "h", "զ": "q", "ց": "g", "Տ": "S", "Օ": "O", "Ꭺ": "A", "Ꭲ": "R", "Ꮮ": "O",
  // Latin-script look-alikes (IPA, small caps, long s, dotless i)
  "ı": "i", "ſ": "s", "ɑ": "a", "ɡ": "g", "ɪ": "i", "ʟ": "l", "ᴀ": "a", "ᴄ": "c", "ᴇ": "e", "ᴏ": "o", "ɩ": "i",
  // typographic punctuation and spaces
  "‘": "'", "’": "'", "‚": ",", "‛": "'", "′": "'", "´": "'", "`": "'", "ʼ": "'", "ʹ": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "﹣": "-",
  "․": ".", "‧": ".", "։": ":", "∶": ":", ";": ";", "∕": "/", "⁄": "/",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", " ": " ", " ": " ", " ": " ", "　": " ",
});

const COMBINING = /\p{M}/gu;
/** default-ignorable and format characters (zero-width, bidi controls, soft hyphen, tag characters ...), written as escapes so the source is reviewable */
const INVISIBLE = new RegExp("[\u200b-\u200f\u2060-\u2064\ufeff\u202a-\u202e\u2066-\u2069\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e]|[\u{e0000}-\u{e007f}]", "gu");
const ASCII_ONLY = /^[\x00-\x7f]*$/;

let lastIn = "";
let lastOut = "";
/** the UTS #39-style skeleton used for SCREENING only: never stored, never shown to a model, never used as evidence. A one-entry cache makes the six rules that screen one cell cost one pass. */
export function skeleton(text: string): string {
  if (ASCII_ONLY.test(text)) return text;
  if (text === lastIn) return lastOut;
  const r = skeletonOf(text);
  lastIn = text;
  lastOut = r;
  return r;
}
function skeletonOf(text: string): string {
  const nf = text.normalize("NFKC").replace(INVISIBLE, "");
  const noMarks = nf.normalize("NFD").replace(COMBINING, "").normalize("NFC");
  let out = "";
  for (const ch of noMarks) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/\s+/g, " ");
}

type Script = "Latin" | "Cyrillic" | "Greek" | "Armenian" | "Cherokee" | "Other";
/** script of a LETTER by code-point range (fast path); the confusable-prone scripts only, everything else is "Other" */
function scriptOf(cp: number): Script {
  if (cp < 0x250 || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2c60 && cp <= 0x2c7f) || (cp >= 0xa720 && cp <= 0xa7ff) || (cp >= 0x1d00 && cp <= 0x1d7f)) return "Latin";
  if (cp >= 0x370 && cp <= 0x3ff) return "Greek";
  if (cp >= 0x1f00 && cp <= 0x1fff) return "Greek";
  if ((cp >= 0x400 && cp <= 0x52f) || (cp >= 0x1c80 && cp <= 0x1c8f) || (cp >= 0x2de0 && cp <= 0x2dff) || (cp >= 0xa640 && cp <= 0xa69f)) return "Cyrillic";
  if (cp >= 0x530 && cp <= 0x58f) return "Armenian";
  if (cp >= 0x13a0 && cp <= 0x13ff) return "Cherokee";
  return "Other";
}
const TOKEN = new RegExp("[\\p{L}\\p{M}\\p{N}]+", "gu");
const LETTER = new RegExp("\\p{L}", "u");
const CHUNK = new RegExp("\\S+", "gu");
const ASCII_LETTER = /[A-Za-z]/;
const CYRILLIC = new RegExp("\\p{Script=Cyrillic}", "u");
const GREEK = new RegExp("\\p{Script=Greek}", "u");
/** a chunk with exactly one letter and at least one digit (the shape of a spoofed identifier such as "c-1" + a Cyrillic "a" + "042") */
const DIGIT_SINGLE_LETTER = new RegExp("(?:^|\\s)(?=\\S*\\d)[^\\s\\p{L}]*\\p{L}[^\\s\\p{L}]*(?=\\s|$)", "u");

/**
 * Cheap test (no allocation): does the text contain a run of 4+ characters that are ASCII letters or have a Latin look-alike? Only such text can spell a Latin word
 * after skeletonisation; ordinary Cyrillic / Greek / CJK prose cannot, so it skips the re-screen.
 */
let lookIn = "";
let lookOut = false;
export function hasLookalikeRun(text: string): boolean {
  if (text === lookIn) return lookOut; // one-entry cache: the six pattern rules screen the same cell back to back
  lookOut = hasLookalikeRunOf(text);
  lookIn = text;
  return lookOut;
}
function hasLookalikeRunOf(text: string): boolean {
  let run = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x300 && cp <= 0x36f) continue;
    if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || CONFUSABLES[ch] !== undefined) {
      if (++run >= 4) return true;
    } else run = 0;
  }
  return false;
}

export interface ConfusableFinding {
  kind: "MIXED_SCRIPT_TOKEN" | "WHOLE_SCRIPT_CONFUSABLE";
  /** the offending token, truncated (the finding is metadata; the original text stays untouched elsewhere) */
  token: string;
}

/** Structural findings for one text. Empty = nothing suspicious. Never throws; bounded to the first 20 findings; linear in the text (no per-token rescan). */
export function confusableFindings(text: string): ConfusableFinding[] {
  if (ASCII_ONLY.test(text)) return [];
  const t = text.normalize("NFKC").replace(INVISIBLE, "");
  // text with no Latin letter can only be spoofed by mixing Cyrillic with Greek, or by one look-alike letter inside a number / identifier
  if (!ASCII_LETTER.test(t) && !(CYRILLIC.test(t) && GREEK.test(t)) && !DIGIT_SINGLE_LETTER.test(t)) return [];
  const out: ConfusableFinding[] = [];
  const nonLatinOnly: string[] = [];
  let latinOnlyChunks = 0;
  // whitespace-separated chunks, not letter runs: "c-1а042" is ONE identifier and its letters come from two scripts
  for (const m of t.matchAll(CHUNK)) {
    const chunk = m[0];
    const scripts = new Set<Script>();
    let letters = 0;
    let lettersStr = "";
    let asciiAlnum = false;
    let confusableLetter = false;
    for (const ch of chunk.normalize("NFD")) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x300 && cp <= 0x36f) continue; // combining marks are not letters
      if (cp < 0x80) {
        if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) {
          letters++;
          lettersStr += ch;
          scripts.add("Latin");
          asciiAlnum = true;
        } else if (cp >= 48 && cp <= 57) asciiAlnum = true;
        continue;
      }
      if (!LETTER.test(ch)) continue;
      letters++;
      lettersStr += ch;
      const sc = scriptOf(cp);
      if (sc !== "Other") scripts.add(sc);
      if (CONFUSABLES[ch] !== undefined) confusableLetter = true;
    }
    const nonLatin = [...scripts].filter((x) => x !== "Latin");
    if (scripts.size > 1 && letters >= 2) {
      if (out.length < 20) out.push({ kind: "MIXED_SCRIPT_TOKEN", token: chunk.slice(0, 40) });
    } else if (nonLatin.length === 1 && scripts.size === 1 && letters === 1 && asciiAlnum && confusableLetter) {
      // a single look-alike letter inside an otherwise ASCII identifier / number ("c-1а042")
      if (out.length < 20) out.push({ kind: "MIXED_SCRIPT_TOKEN", token: chunk.slice(0, 40) });
    } else if (scripts.size === 1 && letters >= 2) {
      if (scripts.has("Latin")) latinOnlyChunks++;
      else nonLatinOnly.push(lettersStr);
    }
  }
  // a look-alike word is only suspicious inside text that also has Latin words
  if (latinOnlyChunks > 0) for (const w of nonLatinOnly) if (out.length < 20 && /^[A-Za-z]+$/.test(skeleton(w))) out.push({ kind: "WHOLE_SCRIPT_CONFUSABLE", token: w.slice(0, 40) });
  return out;
}

export const hasConfusableFinding = (text: string): boolean => confusableFindings(text).length > 0;
