import { parsePayPalEnv } from "@/lib/env";
import { PayPalError, classifyHttpError } from "./errors";
import { redact } from "./redact";

export interface PayPalResponse {
  ok: boolean;
  status: number;
  debugId?: string;
  requestId?: string;
  durationMs: number;
  body: unknown;
}

/** Sanitized record of one real HTTP exchange (no tokens, no PII). */
export interface CallRecord {
  at: string;
  method: "GET" | "POST";
  path: string;
  requestId?: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  outcome: "response" | "timeout" | "network_error";
  status?: number;
  debugId?: string;
  durationMs: number;
  responseBody?: unknown;
  error?: string;
}

export interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Required for POST writes. Callers must pass the SAME id when retrying the same logical operation. */
  requestId?: string;
  prefer?: "return=representation" | "return=minimal";
  timeoutMs?: number;
  /** Do not emit a CallRecord (used for polling loops). */
  quiet?: boolean;
}

export interface ClientOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onCall?: (record: CallRecord) => void;
  defaultTimeoutMs?: number;
}

/** Only relative PayPal REST paths are allowed; the host is fixed to the validated Sandbox base URL. */
const PATH_RE = /^\/v[12]\/[A-Za-z0-9/_.-]+$/;
const TOKEN_MARGIN_MS = 60_000;

export class PayPalClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onCall?: (r: CallRecord) => void;
  private readonly defaultTimeoutMs: number;
  private token?: { value: string; expiresAtMs: number };

  constructor(opts: ClientOptions = {}) {
    // Throws unless PAYPAL_ENV=sandbox and PAYPAL_BASE_URL is exactly the Sandbox host.
    const env = parsePayPalEnv(opts.env ?? process.env);
    this.baseUrl = env.PAYPAL_BASE_URL;
    this.clientId = env.PAYPAL_CLIENT_ID;
    this.clientSecret = env.PAYPAL_CLIENT_SECRET;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onCall = opts.onCall;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  /** Returns a cached token until shortly before expiry. */
  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAtMs - TOKEN_MARGIN_MS) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await this.send({
      method: "POST",
      path: "/v1/oauth2/token",
      rawBody: "grant_type=client_credentials",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      loggedRequestBody: "grant_type=client_credentials",
      loggedHeaders: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic [REDACTED]" },
      timeoutMs: this.defaultTimeoutMs,
    });
    const b = res.body as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof b?.access_token !== "string" || typeof b?.expires_in !== "number") {
      throw new PayPalError("PAYPAL_AUTH_FAILED", `OAuth token request failed (HTTP ${res.status})`, {
        status: res.status,
        debugId: res.debugId,
      });
    }
    this.token = { value: b.access_token, expiresAtMs: this.now() + b.expires_in * 1000 };
    return this.token.value;
  }

  /** Remaining token lifetime in seconds (for diagnostics only; never exposes the token). */
  tokenTtlSeconds(): number | undefined {
    return this.token ? Math.round((this.token.expiresAtMs - this.now()) / 1000) : undefined;
  }

  /** Non-2xx responses are RETURNED (ok=false), not thrown. Timeouts/network errors throw PayPalError. */
  async request(opts: RequestOptions): Promise<PayPalResponse> {
    if (!PATH_RE.test(opts.path) || opts.path.includes("..") || opts.path.includes("//")) throw new PayPalError("PAYPAL_VALIDATION", `Disallowed PayPal path: ${opts.path}`);
    if (opts.method === "POST" && !opts.requestId) {
      throw new PayPalError("PAYPAL_VALIDATION", "POST requires a PayPal-Request-Id");
    }
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const logged: Record<string, string> = { Accept: "application/json", Authorization: "Bearer [REDACTED]" };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      logged["Content-Type"] = "application/json";
    }
    if (opts.requestId) {
      headers["PayPal-Request-Id"] = opts.requestId;
      logged["PayPal-Request-Id"] = opts.requestId;
    }
    if (opts.prefer) {
      headers["Prefer"] = opts.prefer;
      logged["Prefer"] = opts.prefer;
    }
    return this.send({
      method: opts.method,
      path: opts.path,
      rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers,
      loggedHeaders: logged,
      loggedRequestBody: opts.body,
      requestId: opts.requestId,
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
      quiet: opts.quiet,
    });
  }

  private async send(p: {
    method: "GET" | "POST";
    path: string;
    rawBody?: string;
    headers: Record<string, string>;
    loggedHeaders: Record<string, string>;
    loggedRequestBody?: unknown;
    requestId?: string;
    timeoutMs: number;
    quiet?: boolean;
  }): Promise<PayPalResponse> {
    const started = this.now();
    const at = new Date(started).toISOString();
    const base: Omit<CallRecord, "outcome" | "durationMs"> = {
      at,
      method: p.method,
      path: p.path,
      requestId: p.requestId,
      requestHeaders: p.loggedHeaders,
      requestBody: p.loggedRequestBody === undefined ? undefined : redact(p.loggedRequestBody),
    };
    const emit = (r: CallRecord) => {
      if (!p.quiet) this.onCall?.(r);
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), p.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${p.path}`, {
        method: p.method,
        headers: p.headers,
        body: p.rawBody,
        signal: ac.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { unparsed: text.slice(0, 300) };
        }
      }
      const durationMs = this.now() - started;
      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      emit({ ...base, outcome: "response", status: res.status, debugId, durationMs, responseBody: redact(body) });
      return { ok: res.ok, status: res.status, debugId, requestId: p.requestId, durationMs, body };
    } catch (e) {
      const durationMs = this.now() - started;
      const aborted = e instanceof Error && e.name === "AbortError";
      emit({
        ...base,
        outcome: aborted ? "timeout" : "network_error",
        durationMs,
        error: aborted ? `aborted after ${p.timeoutMs}ms` : e instanceof Error ? e.name : "unknown",
      });
      throw new PayPalError(
        aborted ? "PAYPAL_TIMEOUT" : "PAYPAL_UNAVAILABLE",
        aborted ? `Request timed out after ${p.timeoutMs}ms; outcome UNKNOWN` : "Network error; outcome UNKNOWN",
        { requestId: p.requestId },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convert a non-ok response into a typed PayPalError. */
export function toPayPalError(res: PayPalResponse): PayPalError {
  const msg = (res.body as { message?: unknown } | null)?.message;
  return new PayPalError(
    classifyHttpError(res.status, res.body),
    `PayPal HTTP ${res.status}${typeof msg === "string" ? `: ${msg}` : ""}`,
    { status: res.status, debugId: res.debugId, requestId: res.requestId },
  );
}
