import { describe, expect, it } from "vitest";
import { SANDBOX_BASE_URL, parseEnv, parsePayPalEnv } from "@/lib/env";

const goodCore = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://u:p@localhost:5432/mandate",
  SESSION_SECRET: "x".repeat(32),
  PRINCIPAL_EMAIL: "owner@example.com",
  PRINCIPAL_LOGIN_SECRET: "y".repeat(16),
};

const goodPaypal = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_BASE_URL: SANDBOX_BASE_URL,
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
};

describe("parseEnv", () => {
  it("accepts a valid core environment", () => {
    expect(parseEnv(goodCore).APP_URL).toBe("http://localhost:3000");
  });

  it("rejects placeholder and short secrets", () => {
    expect(() => parseEnv({ ...goodCore, SESSION_SECRET: "replace_me" })).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv({ ...goodCore, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv({ ...goodCore, DATABASE_URL: "postgresql://USER:replace_me@h/db" })).not.toThrow();
    expect(() => parseEnv({ ...goodCore, DATABASE_URL: "replace_me" })).toThrow(/DATABASE_URL/);
  });

  it("rejects NEXT_PUBLIC_ variables that look like secrets", () => {
    expect(() => parseEnv({ ...goodCore, NEXT_PUBLIC_PAYPAL_CLIENT_SECRET: "z" })).toThrow(/NEXT_PUBLIC_/);
  });

  it("never echoes secret values in the error", () => {
    try {
      parseEnv({ ...goodCore, SESSION_SECRET: "tooshort-secret-value" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).not.toContain("tooshort-secret-value");
    }
  });
});

describe("parsePayPalEnv (Sandbox safety)", () => {
  it("accepts the Sandbox configuration", () => {
    expect(parsePayPalEnv(goodPaypal).PAYPAL_BASE_URL).toBe(SANDBOX_BASE_URL);
  });

  it("refuses PAYPAL_ENV=live / production", () => {
    expect(() => parsePayPalEnv({ ...goodPaypal, PAYPAL_ENV: "live" })).toThrow(/PAYPAL_ENV/);
    expect(() => parsePayPalEnv({ ...goodPaypal, PAYPAL_ENV: "production" })).toThrow(/PAYPAL_ENV/);
  });

  it("refuses the production base URL and any other host", () => {
    for (const url of [
      "https://api-m.paypal.com",
      "https://api.paypal.com",
      "https://api-m.sandbox.paypal.com.evil.test",
      "http://api-m.sandbox.paypal.com",
      "https://api-m.sandbox.paypal.com/",
    ]) {
      expect(() => parsePayPalEnv({ ...goodPaypal, PAYPAL_BASE_URL: url })).toThrow(/PAYPAL_BASE_URL/);
    }
  });

  it("does not fall back to Sandbox when values are missing", () => {
    expect(() => parsePayPalEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" })).toThrow();
  });

  it("rejects placeholder credentials", () => {
    expect(() => parsePayPalEnv({ ...goodPaypal, PAYPAL_CLIENT_ID: "replace_me" })).toThrow(/PAYPAL_CLIENT_ID/);
  });
});
