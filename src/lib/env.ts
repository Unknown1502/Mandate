import { z } from "zod";

/** The only PayPal API host this application may ever talk to. */
export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

const notPlaceholder = (v: string) => !/^replace(_|-)?me|^replace_with/i.test(v);

const secret = (min: number) =>
  z.string().min(min, `must be at least ${min} characters`).refine(notPlaceholder, "placeholder value");

const coreSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1).refine(notPlaceholder, "placeholder value"),
  SESSION_SECRET: secret(32),
  PRINCIPAL_EMAIL: z.email(),
  PRINCIPAL_LOGIN_SECRET: secret(16),
});

/**
 * PayPal settings are validated separately so Phase 0 surfaces (health, auth) do not
 * require credentials. Anything that talks to PayPal must call parsePayPalEnv().
 * Sandbox is enforced by literals: any other value is a hard failure, never a fallback.
 */
const paypalSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox", { error: "PAYPAL_ENV must be exactly 'sandbox'" }),
  PAYPAL_BASE_URL: z.literal(SANDBOX_BASE_URL, {
    error: `PAYPAL_BASE_URL must be exactly ${SANDBOX_BASE_URL}`,
  }),
  PAYPAL_CLIENT_ID: secret(1),
  PAYPAL_CLIENT_SECRET: secret(1),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
});

type Source = Record<string, string | undefined>;

/** Fail if a secret-looking variable would be shipped to the browser bundle. */
function assertNoPublicSecrets(source: Source): void {
  const bad = Object.keys(source).filter(
    (k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|KEY|TOKEN|PASSWORD/i.test(k),
  );
  if (bad.length > 0) {
    throw new Error(`Secret-like variables must not use NEXT_PUBLIC_: ${bad.join(", ")}`);
  }
}

function fail(label: string, error: z.ZodError): never {
  // Report variable names and reasons only; never echo values.
  const lines = error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`Invalid ${label} environment:\n${lines.join("\n")}`);
}

export function parseEnv(source: Source) {
  assertNoPublicSecrets(source);
  const r = coreSchema.safeParse(source);
  if (!r.success) fail("application", r.error);
  return r.data;
}

export function parsePayPalEnv(source: Source) {
  assertNoPublicSecrets(source);
  const r = paypalSchema.safeParse(source);
  if (!r.success) fail("PayPal", r.error);
  return r.data;
}

let cached: ReturnType<typeof parseEnv> | undefined;
export function getEnv() {
  cached ??= parseEnv(process.env);
  return cached;
}
