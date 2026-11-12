/**
 * PayPal SANDBOX gateway built on the official PayPal Server SDK (@paypal/paypal-server-sdk). This is the ONLY module that imports the SDK; no business logic sees SDK classes.
 * It implements the same PayPalGateway interface as MockPayPal, so the Settlement Engine does not know which one it talks to.
 *
 * Safety properties (all enforced here, all tested with fake controllers, none exercised against PayPal yet):
 *  - Sandbox only: the SDK client is built with Environment.Sandbox, a literal. There is no parameter, environment variable or code path that selects Production.
 *  - It never runs unless the composition root builds it, and the composition root wraps it in SandboxWriteLock (writes refused unless PAYPAL_SANDBOX_WRITES=authorized).
 *  - Every write carries the caller's stable request id as PayPal-Request-Id (idempotency), so a retry of the same operation cannot create a second order, authorization or capture.
 *  - Each operation accepts only its own exact path shape with a strict id pattern: a forged or traversal path is refused before anything is sent.
 *  - Result classification keeps the engine's invariant: "rejected" ONLY when the response (or a pre-send check) proves PayPal did not apply the write; every timeout, abort, network
 *    failure, 5xx/429 or unreadable response is "unknown" (the engine then reconciles with a GET and never assumes success).
 *  - SDK retries are off (the engine owns retry policy) and the SDK logger is the SDK's null logger; error objects (which carry the request, including its bearer token) are never
 *    stored or logged, only their status code, debug id and parsed body.
 *  - Response bodies are the SDK's RAW JSON, so the engine's own zod schemas validate exactly what PayPal sent (nothing is "trusted" because the SDK typed it).
 */
import { AbortError, ApiError, ArgumentsValidationError, Client, Environment, OAuthAuthorizationController, OrdersController, PaymentsController, ResponseValidationError } from "@paypal/paypal-server-sdk";
import { classifyHttpError, isDefinitiveRejection } from "./errors";
import type { GwResult, PayPalGateway, WriteType } from "./gateway";

/** the part of an SDK response the gateway reads */
export interface SdkResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}
type Opts = { abortSignal?: AbortSignal };
/** the subset of the SDK controllers the gateway calls; the real controllers satisfy it, tests pass fakes */
export interface OrdersApi {
  createOrder(a: { body: unknown; paypalRequestId?: string; prefer?: string }, o?: Opts): Promise<SdkResponse>;
  getOrder(a: { id: string }, o?: Opts): Promise<SdkResponse>;
  authorizeOrder(a: { id: string; paypalRequestId?: string; prefer?: string }, o?: Opts): Promise<SdkResponse>;
}
export interface PaymentsApi {
  getAuthorizedPayment(a: { authorizationId: string }, o?: Opts): Promise<SdkResponse>;
  captureAuthorizedPayment(a: { authorizationId: string; paypalRequestId?: string; prefer?: string; body?: unknown }, o?: Opts): Promise<SdkResponse>;
  voidPayment(a: { authorizationId: string; paypalRequestId?: string; prefer?: string }, o?: Opts): Promise<SdkResponse>;
  reauthorizePayment(a: { authorizationId: string; paypalRequestId?: string; prefer?: string; body?: unknown }, o?: Opts): Promise<SdkResponse>;
  getCapturedPayment(a: { captureId: string }, o?: Opts): Promise<SdkResponse>;
}

const ID = "[A-Za-z0-9_-]{1,64}";
const PATHS: Record<WriteType, RegExp> = {
  CREATE_ORDER: /^\/v2\/checkout\/orders$/,
  AUTHORIZE: new RegExp(`^/v2/checkout/orders/(${ID})/authorize$`),
  CAPTURE: new RegExp(`^/v2/payments/authorizations/(${ID})/capture$`),
  VOID: new RegExp(`^/v2/payments/authorizations/(${ID})/void$`),
  REAUTHORIZE: new RegExp(`^/v2/payments/authorizations/(${ID})/reauthorize$`),
};
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,108}$/;
const DEFAULT_WRITE_TIMEOUT_MS = 20_000;

/** snake_case REST keys -> the camelCase the SDK's typed models use (the engine builds REST-shaped payloads; see payloads.ts) */
export function camelize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()), camelize(x)]));
  return v;
}

function parseBody(b: unknown): unknown {
  if (b === null || b === undefined || b === "") return null;
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return undefined; // present but not JSON
    }
  }
  return typeof b === "object" ? b : undefined;
}
const header = (h: Record<string, string> | undefined, name: string) => {
  const k = Object.keys(h ?? {}).find((x) => x.toLowerCase() === name);
  return k ? h![k] : undefined;
};
const rejectedBeforeSend = (message: string): GwResult => ({ kind: "rejected", status: 0, code: "PAYPAL_VALIDATION", body: { message } });

export class SdkPayPalGateway implements PayPalGateway {
  constructor(private readonly orders: OrdersApi, private readonly payments: PaymentsApi) {}

  private async call(f: (o: Opts) => Promise<SdkResponse>, timeoutMs: number): Promise<GwResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f({ abortSignal: ac.signal });
      const body = parseBody(res.body);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (body === undefined) return { kind: "unknown", code: "PAYPAL_UNKNOWN", message: "2xx response with an unreadable body", status: res.statusCode, debugId: header(res.headers, "paypal-debug-id") };
        return { kind: "ok", status: res.statusCode, debugId: header(res.headers, "paypal-debug-id"), body };
      }
      return this.byStatus(res.statusCode, body, header(res.headers, "paypal-debug-id"));
    } catch (e) {
      return this.fail(e);
    } finally {
      clearTimeout(timer);
    }
  }

  private byStatus(status: number, body: unknown, debugId?: string): GwResult {
    const code = classifyHttpError(status, body ?? {});
    return isDefinitiveRejection(status) ? { kind: "rejected", status, debugId, code, body: body ?? {} } : { kind: "unknown", code, message: `HTTP ${status}`, status, debugId };
  }

  /** Only status code, debug id and parsed body are read from an SDK error: it also carries the request (with the bearer token), which must never be stored or logged. */
  private fail(e: unknown): GwResult {
    if (e instanceof ApiError) return this.byStatus(e.statusCode, parseBody(e.body) ?? {}, header(e.headers, "paypal-debug-id"));
    if (e instanceof ArgumentsValidationError) return rejectedBeforeSend("the SDK refused the request before sending it");
    if (e instanceof AbortError) return { kind: "unknown", code: "PAYPAL_TIMEOUT", message: "request aborted or timed out" };
    if (e instanceof ResponseValidationError) return { kind: "unknown", code: "PAYPAL_UNKNOWN", message: "response failed the SDK's own validation" };
    return { kind: "unknown", code: "PAYPAL_UNAVAILABLE", message: "network or SDK failure" };
  }

  write(type: WriteType, a: { requestId: string; path: string; body?: unknown; timeoutMs?: number }): Promise<GwResult> {
    const m = PATHS[type]?.exec(a.path);
    if (!m) return Promise.resolve(rejectedBeforeSend("path does not match the operation"));
    if (!REQUEST_ID.test(a.requestId)) return Promise.resolve(rejectedBeforeSend("request id is not acceptable"));
    const id = m[1] as string;
    const common = { paypalRequestId: a.requestId, prefer: "return=representation" };
    const t = a.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    switch (type) {
      case "CREATE_ORDER":
        if (a.body === undefined) return Promise.resolve(rejectedBeforeSend("create order needs a body"));
        return this.call((o) => this.orders.createOrder({ body: camelize(a.body), ...common }, o), t);
      case "AUTHORIZE":
        return this.call((o) => this.orders.authorizeOrder({ id, ...common }, o), t);
      case "CAPTURE":
        return this.call((o) => this.payments.captureAuthorizedPayment({ authorizationId: id, ...common, body: camelize(a.body) }, o), t);
      case "VOID":
        return this.call((o) => this.payments.voidPayment({ authorizationId: id, paypalRequestId: a.requestId }, o), t);
      case "REAUTHORIZE":
        return this.call((o) => this.payments.reauthorizePayment({ authorizationId: id, ...common, body: camelize(a.body) }, o), t);
    }
  }

  private read(id: string, f: (o: Opts) => Promise<SdkResponse>) {
    return new RegExp(`^${ID}$`).test(id) ? this.call(f, DEFAULT_WRITE_TIMEOUT_MS) : Promise.resolve(rejectedBeforeSend("id is not acceptable"));
  }
  getOrder(id: string) {
    return this.read(id, (o) => this.orders.getOrder({ id }, o));
  }
  getAuthorization(id: string) {
    return this.read(id, (o) => this.payments.getAuthorizedPayment({ authorizationId: id }, o));
  }
  getCapture(id: string) {
    return this.read(id, (o) => this.payments.getCapturedPayment({ captureId: id }, o));
  }
}

/**
 * Build the Sandbox gateway from credentials the caller already validated. Constructing it performs NO network request (the SDK fetches its OAuth token lazily, on the first
 * operation). Production is not selectable: the environment is the literal Environment.Sandbox.
 */
export function createSandboxSdkGateway(a: { clientId: string; clientSecret: string; timeoutMs?: number }): SdkPayPalGateway {
  if (!a.clientId || !a.clientSecret) throw new Error("PayPal Sandbox credentials are required");
  const client = new Client({
    environment: Environment.Sandbox,
    timeout: a.timeoutMs ?? 25_000,
    clientCredentialsAuthCredentials: { oAuthClientId: a.clientId, oAuthClientSecret: a.clientSecret },
  });
  return new SdkPayPalGateway(new OrdersController(client) as unknown as OrdersApi, new PaymentsController(client) as unknown as PaymentsApi);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// OAuth-only connectivity check. It requests ONE client-credentials token from the Sandbox and reports what PayPal said ABOUT it. It creates no order, authorizes, captures and
// voids nothing, and the access token itself is never returned, stored or printed: the result type has no field that could carry it. It makes a real network request, so the only
// caller is scripts/paypal-oauth-check.ts, which refuses to run without the owner's explicit per-run approval flag.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface OAuthCheckSummary {
  ok: boolean;
  httpStatus?: number;
  debugId?: string;
  tokenType?: string;
  expiresInSeconds?: number;
  /** PayPal's identifier of the application the credentials belong to (not a secret); compare it with the app shown in the Sandbox dashboard */
  appId?: string;
  scopes?: string[];
  /** a short, fixed-vocabulary reason; never a response body */
  failure?: "CREDENTIALS_REJECTED" | "UNEXPECTED_STATUS" | "UNREADABLE_RESPONSE" | "NETWORK_OR_TIMEOUT";
  /** PayPal's OAuth error code (for example invalid_client), only when it is a short plain token */
  oauthError?: string;
}
/** the one HTTP exchange, injectable for tests: receives the Basic authorization value, returns status, headers and the raw body */
export type TokenRequest = (authorization: string, signal: AbortSignal) => Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }>;

export async function checkSandboxOAuth(a: { clientId: string; clientSecret: string; timeoutMs?: number }, requestToken?: TokenRequest): Promise<OAuthCheckSummary> {
  if (!a.clientId || !a.clientSecret) throw new Error("PayPal Sandbox credentials are required");
  const timeoutMs = a.timeoutMs ?? 15_000;
  const send: TokenRequest =
    requestToken ??
    (async (authorization, signal) => {
      // Environment.Sandbox is a literal here too; the client holds no credentials (the Basic value is supplied for this single request)
      const res = await new OAuthAuthorizationController(new Client({ environment: Environment.Sandbox, timeout: timeoutMs })).requestToken({ authorization }, undefined, { abortSignal: signal });
      return { statusCode: res.statusCode, headers: res.headers, body: res.body };
    });
  const authorization = `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const summarize = (status: number, headers: Record<string, string>, body: unknown): OAuthCheckSummary => {
    const debugId = header(headers, "paypal-debug-id");
    const parsed = parseBody(body) as Record<string, unknown> | null | undefined;
    if (status >= 200 && status < 300) {
      if (!parsed || typeof parsed !== "object" || typeof parsed.access_token !== "string") return { ok: false, httpStatus: status, debugId, failure: "UNREADABLE_RESPONSE" };
      const scopes = typeof parsed.scope === "string" ? parsed.scope.split(" ").filter(Boolean).sort() : [];
      // only these named fields are copied out: the access_token is deliberately not among them
      return {
        ok: true,
        httpStatus: status,
        debugId,
        tokenType: typeof parsed.token_type === "string" ? parsed.token_type : undefined,
        expiresInSeconds: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
        appId: typeof parsed.app_id === "string" ? parsed.app_id : undefined,
        scopes,
      };
    }
    const code = parsed && typeof parsed === "object" && typeof parsed.error === "string" && /^[a-z_]{1,40}$/.test(parsed.error) ? parsed.error : undefined;
    return { ok: false, httpStatus: status, debugId, failure: status === 401 || status === 400 || status === 403 ? "CREDENTIALS_REJECTED" : "UNEXPECTED_STATUS", oauthError: code };
  };
  try {
    const res = await send(authorization, ac.signal);
    return summarize(res.statusCode, res.headers, res.body);
  } catch (e) {
    // an SDK ApiError carries the response (status, headers, body) AND the request with the Basic credentials: only the response fields are read, never the request
    if (e instanceof ApiError) return summarize(e.statusCode, e.headers, e.body);
    return { ok: false, failure: "NETWORK_OR_TIMEOUT" };
  } finally {
    clearTimeout(timer);
  }
}
