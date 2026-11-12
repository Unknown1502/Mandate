/** P1: the strict JSON reader used for authorization-bearing text payloads. Pure; no database, no network. */
import { describe, expect, it } from "vitest";
import { parseStrictJson } from "@/lib/strict-json";

const ok = (t: string) => {
  const r = parseStrictJson(t);
  if (!r.ok) throw new Error(`expected ok, got ${r.code} for ${t}`);
  return r.value;
};
const code = (t: unknown) => {
  const r = parseStrictJson(t);
  return r.ok ? "OK" : r.code;
};

describe("the hazard being closed: JSON.parse keeps the LAST of a duplicated key", () => {
  it("JSON.parse reads 999999.00 where the first occurrence says 1.00 (documented behaviour, not ours)", () => {
    expect((JSON.parse('{"budgetTotal":"1.00","budgetTotal":"999999.00"}') as { budgetTotal: string }).budgetTotal).toBe("999999.00");
  });
  it("the strict reader rejects it instead of choosing a winner", () => {
    expect(code('{"budgetTotal":"1.00","budgetTotal":"999999.00"}')).toBe("DUPLICATE_KEY");
  });
  it("and rejects it whichever value comes first (the later value must not win, the earlier must not win either)", () => {
    expect(code('{"perDealMax":"999999.00","perDealMax":"1.00"}')).toBe("DUPLICATE_KEY");
    expect(code('{"requireHumanAbove":null,"requireHumanAbove":"1.00"}')).toBe("DUPLICATE_KEY");
    expect(code('{"allowPreDeliveryCancellation":false,"allowPreDeliveryCancellation":true}')).toBe("DUPLICATE_KEY");
  });
});

describe("duplicate keys are rejected wherever and however they are written", () => {
  for (const [name, text] of [
    ["top level", '{"a":1,"b":2,"a":3}'],
    ["nested object", '{"x":{"a":1,"a":2}}'],
    ["inside an array of objects", '{"x":[{"a":1},{"b":1,"b":2}]}'],
    ["adjacent", '{"a":1,"a":1}'],
    ["after escape decoding (a vs \\u0061)", '{"a":1,"\\u0061":2}'],
    ["after escape decoding (slash)", '{"a\\/b":1,"a/b":2}'],
    ["identical unicode written two ways", '{"\\u00e9":1,"\u00e9":2}'],
    ["deeply nested", '{"a":{"b":{"c":{"d":1,"d":2}}}}'],
  ] as const) {
    it(name, () => expect(code(text)).toBe("DUPLICATE_KEY"));
  }
  it("different keys, same value, and the same key in sibling objects are fine", () => {
    expect(ok('{"a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":2}]}')).toEqual({ a: { k: 1 }, b: { k: 1 }, c: [{ k: 1 }, { k: 2 }] });
    expect(code('{"a":1,"A":2}')).toBe("OK");
  });
});

describe("prototype-pollution ambiguity", () => {
  it("rejects __proto__ as a key at any depth, including as an escape", () => {
    expect(code('{"__proto__":{"polluted":true}}')).toBe("FORBIDDEN_KEY");
    expect(code('{"a":{"__proto__":1}}')).toBe("FORBIDDEN_KEY");
    expect(code('{"\\u005f\\u005fproto\\u005f\\u005f":1}')).toBe("FORBIDDEN_KEY");
  });
  it("allows ordinary keys that merely look special", () => {
    const v = ok('{"constructor":1,"toString":2,"hasOwnProperty":3}') as Record<string, number>;
    expect(v.constructor).toBe(1);
    expect(Object.keys(v)).toEqual(["constructor", "toString", "hasOwnProperty"]);
  });
});

describe("malformed input is rejected, never repaired", () => {
  for (const [name, text] of [
    ["empty", ""],
    ["whitespace only", "   "],
    ["trailing comma in object", '{"a":1,}'],
    ["trailing comma in array", "[1,2,]"],
    ["leading comma", '{,"a":1}'],
    ["single quotes", "{'a':1}"],
    ["unquoted key", "{a:1}"],
    ["missing colon", '{"a" 1}'],
    ["missing value", '{"a":}'],
    ["unterminated string", '{"a":"b}'],
    ["unterminated object", '{"a":1'],
    ["extra closing brace", '{"a":1}}'],
    ["trailing garbage", '{"a":1} x'],
    ["two documents", '{"a":1}{"b":2}'],
    ["raw control character in a string", '{"a":"x\ty"}'],
    ["bad escape", '{"a":"\\q"}'],
    ["short unicode escape", '{"a":"\\u12"}'],
    ["leading zero number", '{"a":01}'],
    ["plus sign number", '{"a":+1}'],
    ["NaN", '{"a":NaN}'],
    ["Infinity", '{"a":Infinity}'],
    ["comment", '{"a":1}/*x*/'],
    ["byte order mark", '\uFEFF{"a":1}'],
    ["bare word", "undefined"],
  ] as const) {
    it(name, () => expect(code(text)).toBe("MALFORMED_JSON"));
  }
  it("a non-string input is MALFORMED_JSON, not a crash", () => {
    for (const v of [undefined, null, 1, {}, []]) expect(code(v)).toBe("MALFORMED_JSON");
  });
});

describe("resource bounds", () => {
  it("rejects nesting deeper than the limit and accepts the limit itself", () => {
    expect(code("[".repeat(33) + "]".repeat(33))).toBe("TOO_DEEP");
    expect(code("[".repeat(32) + "]".repeat(32))).toBe("OK");
    expect(parseStrictJson("[[[1]]]", { maxDepth: 2 })).toEqual({ ok: false, code: "TOO_DEEP" });
  });
  it("rejects text larger than the limit (bytes, not characters)", () => {
    expect(parseStrictJson('{"a":"' + "x".repeat(100) + '"}', { maxBytes: 50 })).toEqual({ ok: false, code: "TOO_LARGE" });
    expect(parseStrictJson('{"a":"\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9"}', { maxBytes: 12 })).toEqual({ ok: false, code: "TOO_LARGE" });
  });
});

describe("agreement with JSON.parse on everything that is unambiguous", () => {
  const samples = [
    "null", "true", "false", "0", "-0", "1.5", "-12e3", "1E+2", '"s"', '"\\u00e9\\n\\"\\\\"', "[]", "{}", "[1,[2,[3]]]", ' { "a" : [ 1 , 2 , { "b" : null } ] } ',
    '{"allowedTaskTypes":["data_cleaning"],"budgetTotal":"100.00","requireHumanAbove":null,"allowPartialSettlement":false}',
    '{"emoji":"\\ud83d\\ude00","raw":"\u00e9"}',
  ];
  for (const s of samples) it(s.slice(0, 60), () => expect(ok(s)).toEqual(JSON.parse(s)));

  it("property: for 500 random duplicate-free documents the result equals JSON.parse", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const gen = (d: number): unknown => {
      const r = rnd();
      if (d > 3 || r < 0.3) return [null, true, false, Math.floor(rnd() * 1000) - 500, "s" + Math.floor(rnd() * 99), "\u00e9\"\\"][Math.floor(rnd() * 6)];
      if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => [`k${k}`, gen(d + 1)]));
    };
    for (let n = 0; n < 500; n++) {
      const text = JSON.stringify(gen(0));
      expect(ok(text)).toEqual(JSON.parse(text));
    }
  });
});
