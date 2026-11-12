import { describe, expect, it } from "vitest";
import { createSession, safeEqual, verifyCsrf, verifyOrigin, verifySession } from "@/lib/session";

const SECRET = "s".repeat(40);
const user = { id: "u1", email: "owner@example.com" };

describe("session", () => {
  it("round-trips a valid session", () => {
    const { token, payload } = createSession(user, SECRET, 1000);
    expect(verifySession(token, SECRET, 1001)).toEqual(payload);
  });

  it("rejects a tampered payload", () => {
    const { token } = createSession(user, SECRET, 1000);
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), uid: "admin" })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET, 1001)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = createSession(user, "other-secret-other-secret-other-secret", 1000);
    expect(verifySession(token, SECRET, 1001)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const { token, payload } = createSession(user, SECRET, 1000);
    expect(verifySession(token, SECRET, payload.exp)).toBeNull();
    expect(verifySession(token, SECRET, payload.exp + 1)).toBeNull();
  });

  it("rejects missing or malformed tokens", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession("a.b.c", SECRET)).toBeNull();
    expect(verifySession("garbage", SECRET)).toBeNull();
  });
});

describe("csrf", () => {
  const { payload } = createSession(user, SECRET, 1000);

  it("accepts the session-bound token", () => {
    expect(verifyCsrf(payload, payload.csrf)).toBe(true);
  });

  it("rejects missing, empty and wrong tokens", () => {
    expect(verifyCsrf(payload, undefined)).toBe(false);
    expect(verifyCsrf(payload, null)).toBe(false);
    expect(verifyCsrf(payload, "")).toBe(false);
    expect(verifyCsrf(payload, "nope")).toBe(false);
  });

  it("does not accept another session's token", () => {
    const other = createSession(user, SECRET, 1000).payload;
    expect(verifyCsrf(payload, other.csrf)).toBe(false);
  });
});

describe("origin check", () => {
  it("accepts the app origin only", () => {
    expect(verifyOrigin("http://localhost:3000", "http://localhost:3000")).toBe(true);
    expect(verifyOrigin("https://evil.test", "http://localhost:3000")).toBe(false);
    expect(verifyOrigin("http://localhost:3001", "http://localhost:3000")).toBe(false);
  });

  it("rejects a missing or malformed Origin", () => {
    expect(verifyOrigin(null, "http://localhost:3000")).toBe(false);
    expect(verifyOrigin("not a url", "http://localhost:3000")).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares strings of different lengths without throwing", () => {
    expect(safeEqual("a", "abc")).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
  });
});
