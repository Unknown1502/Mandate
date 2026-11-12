/**
 * Process-level outbound request allow-list with counters, used by the one-off PayPal Sandbox stage scripts. It is installed BEFORE any PayPal code runs and enforces, at the
 * network entry points, exactly which requests may leave the process and how many of each. A request that is not on the list, or that exceeds its count, is refused BEFORE it is
 * sent (it throws, so the caller sees a network failure and nothing reaches the wire). Loopback is allowed (the local database proxy and the seller simulator); every other host is
 * refused. The log records method, host and path only: never headers, bodies, tokens or credentials.
 */
import http from "node:http";
import https from "node:https";

export interface AllowRule {
  /** a label for the report */
  name: string;
  method: string;
  host: string;
  path: RegExp;
  max: number;
  /** this rule only applies after the named rule has been used at least once (enforces the ORDER of the permitted requests) */
  after?: string;
}
export interface GuardEntry {
  method: string;
  host: string;
  path: string;
  allowed: boolean;
  rule?: string;
}
export interface Guard {
  log: GuardEntry[];
  counts: () => Record<string, number>;
  blocked: () => GuardEntry[];
  uninstall: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

type Target = { method: string; host: string; path: string };
function targetOf(args: unknown[]): Target {
  const [a, b] = args as [unknown, unknown];
  let host = "";
  let path = "/";
  let method = "GET";
  const fromOpts = (o: Record<string, unknown>) => {
    host = String(o.hostname ?? o.host ?? host).replace(/:\d+$/, "");
    if (typeof o.path === "string") path = o.path;
    if (typeof o.method === "string") method = o.method.toUpperCase();
  };
  if (typeof a === "string" || a instanceof URL) {
    const u = new URL(String(a));
    host = u.hostname;
    path = u.pathname + u.search;
    if (b && typeof b === "object") fromOpts(b as Record<string, unknown>);
  } else if (a && typeof a === "object") {
    fromOpts(a as Record<string, unknown>);
  }
  return { method, host, path: path.split("?")[0]! };
}

export function installOutboundGuard(rules: AllowRule[]): Guard {
  const log: GuardEntry[] = [];
  const used = new Map<string, number>(rules.map((r) => [r.name, 0]));
  const originals = { httpsRequest: https.request, httpsGet: https.get, httpRequest: http.request, httpGet: http.get, fetch: globalThis.fetch };

  const decide = (t: Target): GuardEntry => {
    if (LOOPBACK.has(t.host)) return { ...t, allowed: true, rule: "loopback" };
    const matching = rules.filter((r) => r.method === t.method && r.host === t.host && r.path.test(t.path));
    if (matching.length === 0) return { ...t, allowed: false };
    // the first matching rule that still has capacity AND whose predecessor (if any) has already been used
    const rule = matching.find((r) => (used.get(r.name) ?? 0) < r.max && (!r.after || (used.get(r.after) ?? 0) >= 1));
    if (!rule) return { ...t, allowed: false, rule: `${matching.map((r) => r.name).join("/")} (limit reached or out of order)` };
    used.set(rule.name, (used.get(rule.name) ?? 0) + 1);
    return { ...t, allowed: true, rule: rule.name };
  };
  const guarded = (orig: (...a: any[]) => any) =>
    function (this: unknown, ...args: unknown[]) {
      const e = decide(targetOf(args));
      log.push(e);
      if (!e.allowed) throw new Error(`outbound request refused by the stage guard: ${e.method} ${e.host}${e.path}${e.rule ? ` [${e.rule}]` : ""}`);
      return orig.apply(this, args);
    };
  (https as any).request = guarded(originals.httpsRequest);
  (https as any).get = guarded(originals.httpsGet);
  (http as any).request = guarded(originals.httpRequest);
  (http as any).get = guarded(originals.httpGet);
  (globalThis as any).fetch = async (input: unknown, init?: { method?: string }) => {
    const e = decide(targetOf([input, { method: init?.method ?? "GET" }]));
    log.push(e);
    if (!e.allowed) throw new Error(`outbound request refused by the stage guard: ${e.method} ${e.host}${e.path}${e.rule ? ` [${e.rule}]` : ""}`);
    return originals.fetch(input as never, init as never);
  };

  return {
    log,
    counts: () => Object.fromEntries(used),
    blocked: () => log.filter((e) => !e.allowed),
    uninstall: () => {
      (https as any).request = originals.httpsRequest;
      (https as any).get = originals.httpsGet;
      (http as any).request = originals.httpRequest;
      (http as any).get = originals.httpGet;
      (globalThis as any).fetch = originals.fetch;
    },
  };
}
