const REDACT_KEYS = new Set(
  [
    "access_token",
    "id_token",
    "refresh_token",
    "client_secret",
    "nonce",
    "email_address",
    "given_name",
    "surname",
    "full_name",
    "payer_id",
    "merchant_id",
    "account_id",
    "address_line_1",
    "address_line_2",
    "admin_area_1",
    "admin_area_2",
    "postal_code",
    "phone_number",
    "national_number",
  ].map((k) => k.toLowerCase()),
);

/** Deep-copy `value` replacing secrets and personal data with "[REDACTED]". */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        REDACT_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v),
      ]),
    );
  }
  return value;
}
