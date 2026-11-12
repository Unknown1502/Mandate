/**
 * Mode selection and configuration of the PayPal side of the composition root. No PayPal call is made: building the runtime constructs the SDK client but performs no request
 * (checked with spies on every Node HTTP entry point). Secrets used here are obvious fakes.
 *  - PAYPAL_MODE=mock (default) never builds the SDK gateway; PAYPAL_MODE=sandbox always does, and an incomplete or non-Sandbox configuration is an ERROR, never a silent switch
 *    to the mock; there is no production mode.
 */
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRuntime } from "@/lib/runtime";

const SECRET = "fake-secret-value-must-never-be-printed";
const good = { ...process.env, PAYPAL_MODE: "sandbox", PAYPAL_ENV: "sandbox", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "fake-public-client-id", PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_SANDBOX_WRITES: undefined, LLM_PROVIDER: undefined };
const spies: ReturnType<typeof vi.spyOn>[] = [];
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
});
const watchNetwork = () => spies.push(vi.spyOn(http, "request"), vi.spyOn(https, "request"), vi.spyOn(globalThis, "fetch"));

describe("Sandbox mode builds the SDK gateway and fails closed", () => {
  it("a complete Sandbox configuration builds a runtime wired to the SDK gateway, with writes LOCKED by default and NO network request", () => {
    watchNetwork();
    const rt = buildRuntime(good);
    expect(rt.info).toMatchObject({ paypal: "sandbox-live", paypalGateway: "sandbox-sdk", sandboxWritesAuthorized: false, v2: "disabled" });
    expect(rt.mockPayPal).toBeUndefined(); // no mock object exists in Sandbox mode: nothing to fall back to
    expect(rt.checkout).toEqual({ clientId: "fake-public-client-id", sdkUrl: "https://www.sandbox.paypal.com/web-sdk/v6/core" });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it("writes become authorized only by the exact value 'authorized'", () => {
    expect(buildRuntime({ ...good, PAYPAL_SANDBOX_WRITES: "authorized" }).info.sandboxWritesAuthorized).toBe(true);
    for (const v of ["true", "1", "yes", "AUTHORIZED", "authorised", ""]) expect(buildRuntime({ ...good, PAYPAL_SANDBOX_WRITES: v }).info.sandboxWritesAuthorized, v).toBe(false);
  });
  it.each([
    ["no client id", { PAYPAL_CLIENT_ID: undefined }, /PAYPAL_CLIENT_ID/],
    ["no client secret", { PAYPAL_CLIENT_SECRET: undefined }, /PAYPAL_CLIENT_SECRET/],
    ["placeholder client id", { PAYPAL_CLIENT_ID: "replace_me" }, /PAYPAL_CLIENT_ID/],
    ["placeholder client secret", { PAYPAL_CLIENT_SECRET: "replace_me" }, /PAYPAL_CLIENT_SECRET/],
    ["PAYPAL_ENV is not sandbox", { PAYPAL_ENV: "live" }, /PAYPAL_ENV/],
    ["PAYPAL_ENV production", { PAYPAL_ENV: "production" }, /PAYPAL_ENV/],
    ["PAYPAL_ENV missing", { PAYPAL_ENV: undefined }, /PAYPAL_ENV/],
    ["the production API host", { PAYPAL_BASE_URL: "https://api-m.paypal.com" }, /PAYPAL_BASE_URL/],
    ["a look-alike host", { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com.evil.example" }, /PAYPAL_BASE_URL/],
    ["no base url", { PAYPAL_BASE_URL: undefined }, /PAYPAL_BASE_URL/],
  ])("%s: building the runtime THROWS (no fallback to the mock) and the error never contains a secret", (_label, over, pattern) => {
    let err: unknown;
    try {
      buildRuntime({ ...good, ...over });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(pattern);
    expect((err as Error).message).not.toContain(SECRET);
  });
  it("there is no production mode: any PAYPAL_MODE other than mock or sandbox is an error", () => {
    for (const m of ["production", "live", "prod", "Sandbox", "SANDBOX"]) expect(() => buildRuntime({ ...good, PAYPAL_MODE: m }), m).toThrow(/PAYPAL_MODE must be mock or sandbox/);
  });
  it("the runtime's public information never contains the client secret", () => {
    const rt = buildRuntime(good);
    expect(JSON.stringify(rt.info)).not.toContain(SECRET);
    expect(JSON.stringify(rt.checkout)).not.toContain(SECRET);
  });
});

describe("mock mode (the default) is explicit and separate", () => {
  it("without PAYPAL_MODE the runtime is the in-memory mock; it never builds the SDK gateway or a checkout configuration, even if Sandbox credentials are present", () => {
    watchNetwork();
    const rt = buildRuntime({ ...good, PAYPAL_MODE: undefined });
    expect(rt.info).toMatchObject({ paypal: "mock", paypalGateway: "mock-in-memory" });
    expect(rt.mockPayPal).toBeDefined();
    expect(rt.checkout).toBeUndefined();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it("mock mode with garbage Sandbox settings still works (they are ignored, not validated, not used)", () => {
    expect(buildRuntime({ ...good, PAYPAL_MODE: "mock", PAYPAL_ENV: "live", PAYPAL_BASE_URL: "https://api-m.paypal.com" }).info.paypal).toBe("mock");
  });
});
