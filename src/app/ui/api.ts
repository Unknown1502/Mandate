/** Browser-side API client. The CSRF token lives only in memory; the session cookie is HttpOnly and never readable here. */

export interface ApiResult<T = Record<string, any>> {
  status: number;
  ok: boolean;
  data: T;
}

let csrfToken = "";
export const setCsrf = (t: string) => {
  csrfToken = t;
};

export async function api<T = Record<string, any>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  try {
    const res = await fetch(path, { method, headers, credentials: "same-origin", body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    let data: unknown = {};
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, ok: res.ok, data: data as T };
  } catch {
    return { status: 0, ok: false, data: { error: "NETWORK_ERROR" } as T };
  }
}

export interface Status {
  principal: string;
  paypal: "mock" | "sandbox-live";
  paypalGateway?: "mock-in-memory" | "sandbox-sdk";
  sandboxWritesAuthorized: boolean;
  buyerBrain: "llm" | "rule-based";
  llmVendor: string | null;
  llmConfig: "not_requested" | "configured" | "incomplete";
  llmConfigNote: string | null;
  llmModel: string | null;
  sellerConfigured: boolean;
  challengeWindowSeconds: number;
  v2: "disabled";
}

/** a short, honest message for a refusal or failure coming back from the server */
export function explain(r: ApiResult): string {
  const d = r.data as Record<string, any>;
  if (r.status === 0) return "Could not reach the server.";
  if (r.status === 401) return "Your session has ended. Please sign in again.";
  if (r.status === 403) return "The request was refused (origin or CSRF check). Reload the page and try again.";
  if (r.status === 404) return "Not found (or not yours).";
  if (r.status === 429) return "Too many requests. Wait a moment.";
  const parts = [d.error, d.reason, d.detail].filter((x) => typeof x === "string") as string[];
  if (Array.isArray(d.issues) && d.issues.length) parts.push(d.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; "));
  return parts.length ? parts.join(" – ") : `Request failed (${r.status}).`;
}
