import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PayPalError, isDefinitiveRejection } from "../../src/paypal/errors";
import type { PayPalClient, PayPalResponse } from "../../src/paypal/client";

/**
 * Phase 1 spike persistence (local JSON). Phase 2 replaces this with the PayPalOperation table.
 * Holds only PayPal resource ids, deterministic request bodies and request ids: no secrets.
 */
export const STATE_PATH = process.env.SPIKE_STATE_PATH ?? ".spike/state.json";

export type OpType = "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID";
export type OpStatus = "PLANNED" | "SENT" | "CONFIRMED" | "FAILED" | "UNKNOWN";

export interface Op {
  key: string;
  type: OpType;
  scenario: string;
  requestId: string;
  method: "POST";
  path: string;
  body?: unknown;
  bodyHash: string;
  prefer?: "return=representation" | "return=minimal";
  status: OpStatus;
  attempts: number;
  httpStatus?: number;
  debugId?: string;
  resourceId?: string;
  error?: string;
  updatedAt: string;
}

export interface Scenario {
  name: string;
  amount: string;
  orderId?: string;
  approvalUrl?: string;
  approvalRel?: string;
  authId?: string;
}

export interface State {
  runId: string;
  scenarios: Record<string, Scenario>;
  ops: Record<string, Op>;
}

export function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const runId = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return { runId, scenarios: {}, ops: {} };
}

export function saveState(st: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + "\n");
}

export interface WriteSpec {
  key: string;
  type: OpType;
  scenario: string;
  path: string;
  body?: unknown;
  prefer?: Op["prefer"];
}

export const requestIdFor = (st: State, key: string) => `mandate-spike-${st.runId}-${key.replace(/:/g, "-")}`;

function idOf(body: unknown): string | undefined {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Persist the operation (status SENT) BEFORE the network call, using the stable request id.
 * Outcomes: 2xx -> CONFIRMED; definitive 4xx -> FAILED; 429/5xx/timeout/network -> UNKNOWN
 * (UNKNOWN must be reconciled by reading the PayPal resource; never re-issued under a new id).
 */
export async function sendOp(
  client: PayPalClient,
  st: State,
  op: Op,
  timeoutMs?: number,
): Promise<{ response?: PayPalResponse; error?: PayPalError }> {
  await client.getAccessToken(); // token failures happen before anything is marked as sent
  op.status = "SENT";
  op.attempts += 1;
  op.updatedAt = new Date().toISOString();
  saveState(st);
  try {
    const res = await client.request({
      method: op.method,
      path: op.path,
      body: op.body,
      requestId: op.requestId,
      prefer: op.prefer,
      timeoutMs,
    });
    op.httpStatus = res.status;
    op.debugId = res.debugId;
    if (res.ok) {
      op.status = "CONFIRMED";
      op.resourceId = idOf(res.body);
      op.error = undefined;
    } else if (isDefinitiveRejection(res.status)) {
      op.status = "FAILED";
      op.error = `HTTP ${res.status}`;
    } else {
      op.status = "UNKNOWN";
      op.error = `HTTP ${res.status}`;
    }
    return { response: res };
  } catch (e) {
    if (!(e instanceof PayPalError)) throw e;
    op.status = "UNKNOWN";
    op.error = e.code;
    return { error: e };
  } finally {
    op.updatedAt = new Date().toISOString();
    saveState(st);
  }
}

export class UnreconciledOperationError extends Error {}

/** Create-or-reuse an operation. A non-terminal existing operation can only be reconciled, never replaced. */
export async function executeWrite(
  client: PayPalClient,
  st: State,
  spec: WriteSpec,
  timeoutMs?: number,
): Promise<{ op: Op; skipped: boolean; response?: PayPalResponse; error?: PayPalError }> {
  const existing = st.ops[spec.key];
  if (existing) {
    if (existing.status === "CONFIRMED" || existing.status === "FAILED") return { op: existing, skipped: true };
    throw new UnreconciledOperationError(
      `Operation ${spec.key} is ${existing.status}. Run 'reconcile' (fresh GET first); it will never be re-issued under a new request id.`,
    );
  }
  const op: Op = {
    key: spec.key,
    type: spec.type,
    scenario: spec.scenario,
    requestId: requestIdFor(st, spec.key),
    method: "POST",
    path: spec.path,
    body: spec.body,
    bodyHash: createHash("sha256").update(JSON.stringify(spec.body ?? null)).digest("hex"),
    prefer: spec.prefer,
    status: "PLANNED",
    attempts: 0,
    updatedAt: new Date().toISOString(),
  };
  st.ops[spec.key] = op;
  saveState(st); // PLANNED persisted before anything else
  const r = await sendOp(client, st, op, timeoutMs);
  return { op, skipped: false, ...r };
}
