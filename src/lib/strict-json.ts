/**
 * Strict JSON reader for AUTHORIZATION-BEARING text payloads (sealed mandate documents, session tokens).
 *
 * `JSON.parse` accepts duplicate object keys and silently keeps the LAST value, so `{"budgetTotal":"1.00","budgetTotal":"999999.00"}`
 * reads as 999999.00 while a human or an auditor looking at the first occurrence sees 1.00. This reader rejects the ambiguity
 * instead of picking a winner. It accepts exactly RFC 8259 JSON and additionally rejects:
 *   - a duplicate key at ANY nesting level (compared after escape decoding, so "a" and "a" collide),
 *   - the key "__proto__" (prototype-pollution ambiguity),
 *   - nesting deeper than `maxDepth` and text larger than `maxBytes` (resource bounds).
 * It never throws; the result is a closed-enum code. It builds plain objects/arrays and nothing else (no revivers, no BigInt).
 *
 * A JSONB column cannot be checked here: PostgreSQL has already collapsed duplicate keys before the application sees the value.
 * That is why this reader guards TEXT payloads (Mandate.canonicalJson, session tokens) and why JSON-column values are validated by strict schemas instead.
 */
export type StrictJsonErrorCode = "MALFORMED_JSON" | "DUPLICATE_KEY" | "FORBIDDEN_KEY" | "TOO_DEEP" | "TOO_LARGE";
export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; code: StrictJsonErrorCode };

export interface StrictJsonLimits {
  maxBytes?: number;
  maxDepth?: number;
}

export const STRICT_JSON_DEFAULTS = { maxBytes: 256 * 1024, maxDepth: 32 } as const;

class Fail extends Error {
  constructor(readonly code: StrictJsonErrorCode) {
    super(code);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function parseStrictJson(text: unknown, limits: StrictJsonLimits = {}): StrictJsonResult {
  if (typeof text !== "string") return { ok: false, code: "MALFORMED_JSON" };
  const maxBytes = limits.maxBytes ?? STRICT_JSON_DEFAULTS.maxBytes;
  const maxDepth = limits.maxDepth ?? STRICT_JSON_DEFAULTS.maxDepth;
  if (text.length > maxBytes || Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, code: "TOO_LARGE" };

  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const bad = (): never => {
    throw new Fail("MALFORMED_JSON");
  };

  const str = (): string => {
    if (text[i] !== '"') bad();
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) bad();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) bad();
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === undefined) bad();
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e !== undefined && Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
          out += ESCAPES[e];
          i += 2;
        } else bad();
      } else {
        out += text[i];
        i++;
      }
    }
  };

  const value = (depth: number): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      if (depth + 1 > maxDepth) throw new Fail("TOO_DEEP");
      i++;
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = str();
        if (key === "__proto__") throw new Fail("FORBIDDEN_KEY");
        if (seen.has(key)) throw new Fail("DUPLICATE_KEY");
        seen.add(key);
        ws();
        if (text[i] !== ":") bad();
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        bad();
      }
    }
    if (c === "[") {
      if (depth + 1 > maxDepth) throw new Fail("TOO_DEEP");
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        bad();
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return bad();
    i += m[0].length;
    return Number(m[0]);
  };

  try {
    const v = value(0);
    ws();
    if (i !== text.length) bad();
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code };
    return { ok: false, code: "MALFORMED_JSON" };
  }
}
