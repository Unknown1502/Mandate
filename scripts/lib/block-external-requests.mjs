/**
 * Preload for a LOCAL server process (node --import scripts/lib/block-external-requests.mjs ...): refuses EVERY outbound request that is not to loopback, before it is sent, and
 * logs each refusal to stderr (method, host, path only). Used to run the MANDATE app next to a PayPal Sandbox test without any possibility of an unplanned PayPal request:
 * the dashboard can be opened and clicked, the database and the loopback seller work, and anything aimed at PayPal (or anywhere else) fails locally and visibly.
 */
import http from "node:http";
import https from "node:https";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function target(args) {
  const [a, b] = args;
  let host = "";
  let path = "/";
  let method = "GET";
  const fromOpts = (o) => {
    host = String(o.hostname ?? o.host ?? host).replace(/:\d+$/, "");
    if (typeof o.path === "string") path = o.path;
    if (typeof o.method === "string") method = o.method.toUpperCase();
  };
  if (typeof a === "string" || a instanceof URL) {
    const u = new URL(String(a));
    host = u.hostname;
    path = u.pathname;
    if (b && typeof b === "object") fromOpts(b);
  } else if (a && typeof a === "object") fromOpts(a);
  return { method, host, path: path.split("?")[0] };
}
function check(args) {
  const t = target(args);
  if (LOOPBACK.has(t.host)) return;
  console.error(`[net-guard] REFUSED outbound ${t.method} ${t.host}${t.path}`);
  throw new Error(`outbound request refused by the local net guard: ${t.method} ${t.host}${t.path}`);
}
for (const [mod, name] of [[https, "request"], [https, "get"], [http, "request"], [http, "get"]]) {
  const orig = mod[name];
  mod[name] = function (...args) {
    check(args);
    return orig.apply(this, args);
  };
}
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  check([typeof input === "string" || input instanceof URL ? input : (input?.url ?? ""), { method: init?.method ?? "GET" }]);
  return origFetch(input, init);
};
console.error("[net-guard] active: every non-loopback outbound request is refused");
