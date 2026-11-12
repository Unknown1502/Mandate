"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, explain, setCsrf, type ApiResult, type Status } from "./api";
import { paypalLifecycle, settlementBasis } from "@/paypal/lifecycle";
import { PayPalCheckout } from "./paypal-checkout";
import { actorLabel, challengeWindowView, formatInstant, ledgerLine, protectionFacts, reasonText, workflowStages, type Stage } from "./presentation";

type Any = Record<string, any>;
type Notice = { kind: "ok" | "error" | "info"; text: string } | null;

const TERMINAL = new Set(["CAPTURED", "PARTIALLY_CAPTURED", "VOIDED", "EXPIRED", "FAILED", "BLOCKED"]);
const STATE_LABEL: Record<string, string> = {
  PROPOSED: "Proposed",
  NEGOTIATING: "Negotiating",
  TERMS_LOCKED: "Terms locked",
  POLICY_CHECKED: "Policy checked",
  BLOCKED: "Blocked",
  NEEDS_HUMAN: "Needs your decision",
  ORDER_CREATED: "PayPal order created",
  AWAITING_BUYER_APPROVAL: "Waiting for buyer PayPal approval",
  AUTHORIZED: "Authorized (a hold, not captured)",
  AWAITING_DELIVERY: "Authorized, waiting for delivery",
  DELIVERED: "Delivered",
  VERIFYING: "Verified, challenge window",
  SETTLEMENT_REVIEW: "Challenge under review",
  SETTLING: "Settling",
  SETTLEMENT_PENDING: "Settlement pending at PayPal",
  CAPTURED: "Paid (captured)",
  PARTIALLY_CAPTURED: "Partly paid",
  VOIDED: "Voided (not paid)",
  EXPIRED: "Expired",
  FAILED: "Failed",
};

// ---------------------------------------------------------------------------------------------------------------- small UI parts
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
function Card({ title, subtitle, right, children, id }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {subtitle && <p className="text-xs text-slate-600 dark:text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
type Tone = "green" | "amber" | "red" | "blue" | "slate" | "violet";
const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800",
  amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800",
  red: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800",
  blue: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800",
  slate: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700",
  violet: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800",
};
function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>{children}</span>;
}
function Chip({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
      <span className="text-[11px] uppercase tracking-wide text-slate-600 dark:text-slate-400">{label}</span>
      <Badge tone={tone}>{value}</Badge>
    </div>
  );
}
function Btn({ children, onClick, disabled, tone = "primary", type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: "primary" | "ghost" | "danger" | "amber"; type?: "button" | "submit" }) {
  const base = "rounded-lg px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
  const t = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    ghost: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    amber: "bg-amber-700 text-white hover:bg-amber-800",
  }[tone];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cx(base, t)}>
      {children}
    </button>
  );
}
const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="flex flex-col gap-1 text-sm">
    <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
    {children}
    {hint && <span className="text-xs text-slate-600 dark:text-slate-400">{hint}</span>}
  </label>
);
const inputCls = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
const Mono = ({ children }: { children: ReactNode }) => <code className="break-all rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{children}</code>;
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500 dark:border-slate-700">{children}</p>;
const money = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? "-" : `$${Number(v).toFixed(2)}`);
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "-");

// ---------------------------------------------------------------------------------------------------------------- main component
export default function Dashboard() {
  const [phase, setPhase] = useState<"loading" | "anon" | "ready">("loading");
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mandates, setMandates] = useState<Any[] | null>(null);
  const [deals, setDeals] = useState<Any[] | null>(null);
  const [selMandate, setSelMandate] = useState<string>("");
  const [selDeal, setSelDeal] = useState<string>("");
  const [detail, setDetail] = useState<Any | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** server clock minus browser clock at the moment the deal was last loaded: lets the challenge-window countdown follow the SERVER's time */
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const takeDetail = useCallback((data: Any) => {
    setDetail(data);
    const t = Date.parse(String(data.serverTime ?? ""));
    if (!Number.isNaN(t)) setClockOffsetMs(t - Date.now());
  }, []);

  const loadAll = useCallback(async () => {
    const [s, m, d] = await Promise.all([api<Any>("/api/status"), api<Any>("/api/mandates"), api<Any>("/api/deals")]);
    if (s.status === 401 || m.status === 401) {
      setPhase("anon");
      return;
    }
    if (s.ok) {
      setStatus(s.data as unknown as Status);
      setStatusError(null);
    } else {
      setStatus(null);
      setStatusError(explain(s));
    }
    setMandates(m.ok ? (m.data.mandates as Any[]) : []);
    setDeals(d.ok ? (d.data.deals as Any[]) : []);
    if (m.ok && (m.data.mandates as Any[]).length > 0) setSelMandate((cur) => cur || String((m.data.mandates as Any[])[0]?.id ?? ""));
  }, []);

  // the deal that is selected NOW: a slow answer for a deal that is no longer selected must never overwrite the screen
  const selRef = useRef("");
  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    const r = await api<Any>(`/api/deals/${id}`);
    if (selRef.current !== id) return;
    if (r.ok) {
      takeDetail(r.data);
      setDetailError(null);
    } else {
      setDetailError(explain(r));
    }
  }, [takeDetail]);

  // session restore
  useEffect(() => {
    (async () => {
      const r = await api<Any>("/api/auth/session");
      if (r.ok) {
        setCsrf(String(r.data.csrfToken));
        setPhase("ready");
        await loadAll();
      } else setPhase("anon");
    })();
  }, [loadAll]);

  useEffect(() => {
    selRef.current = selDeal;
    if (phase !== "ready" || !selDeal) return;
    let cancelled = false;
    (async () => {
      const r = await api<Any>(`/api/deals/${selDeal}`);
      if (cancelled) return;
      if (r.ok) {
        takeDetail(r.data);
        setDetailError(null);
        if (window.innerWidth < 1024) requestAnimationFrame(() => document.getElementById("deal-detail")?.scrollIntoView({ block: "start" }));
      } else setDetailError(explain(r));
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, selDeal, takeDetail]);

  // poll an active deal (read-only: polling never advances a payment)
  const activeState = detail?.deal?.state as string | undefined;
  useEffect(() => {
    if (phase !== "ready" || !selDeal || !activeState || TERMINAL.has(activeState)) return;
    const t = setInterval(() => void loadDetail(selDeal), 4000);
    return () => clearInterval(t);
  }, [phase, selDeal, activeState, loadDetail]);

  const refresh = useCallback(async () => {
    await loadAll();
    if (selRef.current) await loadDetail(selRef.current);
  }, [loadAll, loadDetail]);

  /** run a server action; the message shown comes from the SERVER's answer, and the screen is then reloaded from the server */
  async function act(label: string, fn: () => Promise<ApiResult>, okText: (r: ApiResult) => string): Promise<ApiResult> {
    setBusy(label);
    setNotice(null);
    const r = await fn();
    setNotice(r.ok ? { kind: "info", text: okText(r) } : { kind: "error", text: `${label}: ${explain(r)}` });
    await refresh();
    setBusy(null);
    return r;
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    setCsrf("");
    setPhase("anon");
    setDetail(null);
    setMandates(null);
    setDeals(null);
    setSelDeal("");
  }

  if (phase === "loading") return <Shell><p className="py-24 text-center text-slate-600 dark:text-slate-400">Loading…</p></Shell>;
  if (phase === "anon") return <Shell><Login onDone={async () => { setPhase("ready"); await loadAll(); }} /></Shell>;

  const deal = detail?.deal?.id === selDeal ? (detail?.deal as Any) : undefined; // never show another deal's data while this one loads
  const mandate = mandates?.find((m) => m.id === (deal?.mandateId ?? selMandate));
  const lifeMandate = deal ? mandate : mandates?.find((m) => m.id === selMandate);
  const stages = workflowStages({
    mandate: lifeMandate ? { sealVerified: !!lifeMandate.sealVerified } : null,
    deal: deal ? { state: deal.state, termsHash: deal.termsHash } : null,
    hasDelivery: !!detail?.delivery && !!deal,
    verificationOverall: deal ? (detail?.verification?.result?.overall as string | undefined) ?? null : null,
    verificationFlagged: !!(deal && (detail?.verification?.result?.skeptic?.flags as Any[] | undefined)?.length),
    settlement: deal && detail?.settlement ? { decision: String(detail.settlement.decision) } : null,
  });

  return (
    <Shell
      right={
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-slate-600 dark:text-slate-400 sm:inline">{status?.principal ?? ""}</span>
          <Btn tone="ghost" onClick={() => void refresh()} disabled={!!busy}>Refresh</Btn>
          <Btn tone="ghost" onClick={() => void logout()}>Sign out</Btn>
        </div>
      }
    >
      <StatusBar status={status} error={statusError} />
      <Intro mandate={lifeMandate} expanded={!selDeal} key={selDeal ? "deal" : "none"} />
      <Workflow stages={stages} paypal={deal ? paypalLifecycle(deal.state, status?.paypal === "mock", (detail?.paypalOperations as { status: string }[]) ?? []).label : null} />
      {notice && (
        <div role="status" className={cx("mt-4 rounded-lg border px-4 py-2 text-sm", notice.kind === "error" ? "border-rose-300 bg-rose-50 text-rose-900" : "border-sky-300 bg-sky-50 text-sky-900")}>
          {notice.text}
        </div>
      )}
      {busy && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Working: {busy}…</p>}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-4">
          <MandateCard mandates={mandates} selected={selMandate} onSelect={setSelMandate} onCreated={async (id) => { setSelMandate(id); await refresh(); }} setNotice={setNotice} />
          <NewDealCard mandate={mandates?.find((m) => m.id === selMandate)} status={status} busy={!!busy} onOpen={(brief) =>
            act("Open deal and negotiate", () => api("/api/deals", { body: { mandateId: selMandate, sellerId: "seller-sim", brief } }), (r) => {
              const n = (r.data.negotiation ?? {}) as Any;
              if (r.data.dealId) setSelDeal(String(r.data.dealId));
              return n.outcome === "LOCKED" ? `Negotiation finished: terms locked at ${money(n.price)} after ${n.rounds} round(s).` : `Negotiation ended without a deal: ${n.outcome ?? "unknown"}${n.reason ? ` (${n.reason})` : ""}.`;
            })
          } />
          <DealList deals={deals} selected={selDeal} onSelect={setSelDeal} />
        </div>

        <div className="min-w-0 space-y-5 lg:col-span-8">
          {!selDeal && <Card title="Deal"><Empty>Create a mandate, then open a deal. Everything that happens to it appears here.</Empty></Card>}
          {selDeal && detailError && <Card title="Deal"><p className="text-sm text-rose-700">{detailError}</p></Card>}
          {selDeal && !deal && !detailError && <Card title="Deal"><p className="text-sm text-slate-600 dark:text-slate-400">Loading deal…</p></Card>}
          {detail && deal && (
            <>
              <DealHeader detail={detail} mandate={mandate} />
              <Negotiation detail={detail} status={status} />
              <PayPalCard
                detail={detail}
                status={status}
                busy={!!busy}
                onCreateOrder={() => act("Create PayPal order", () => api(`/api/deals/${deal.id}/advance`, { body: {} }), (r) => `Engine answered: ${r.data.status ?? "?"}${r.data.reason ? ` (${r.data.reason})` : ""} – deal is now ${r.data.state}.`)}
                onMockApprove={() => act("Simulate buyer checkout (MOCK)", () => api(`/api/deals/${deal.id}/mock-approval`, { body: {} }), (r) => `Mock checkout recorded; deal is now ${r.data.state}.`)}
                onRefreshApproval={() => act("Check PayPal approval", () => api(`/api/deals/${deal.id}/advance`, { body: {} }), (r) => `Deal is now ${r.data.state}${r.data.reason ? ` (${r.data.reason})` : ""}.`)}
                onCheckoutAdvanced={(text) => { setNotice({ kind: "info", text }); void refresh(); }}
              />
              <DeliveryCard
                detail={detail}
                status={status}
                busy={!!busy}
                onDeliver={(quality) => act("Seller simulator delivers", () => api(`/api/deals/${deal.id}/delivery`, { body: { quality } }), (r) => `Delivery ${String(r.data.delivery?.status ?? "?").toLowerCase()}${r.data.delivery?.reason ? ` (${r.data.delivery.reason})` : ""}; deal is now ${r.data.advance?.state ?? "?"}.`)}
              />
              <DecisionCard
                detail={detail}
                clockOffsetMs={clockOffsetMs}
                busy={!!busy}
                onAccept={() => act("Accept delivery", () => api(`/api/deals/${deal.id}/accept`, { body: {} }), (r) => `Accept: ${r.data.accept?.status ?? "?"}${r.data.accept?.reason ? ` (${r.data.accept.reason})` : ""}; deal is now ${r.data.advance?.state ?? "?"}.`)}
                onSettleCheck={() => act("Check settlement", () => api(`/api/deals/${deal.id}/advance`, { body: {} }), (r) => `Deal is now ${r.data.state}${r.data.reason ? ` (${r.data.reason})` : ""}.`)}
                onChallenge={(criterionId, reason) =>
                  act("Request review", () => api(`/api/deals/${deal.id}/challenge`, { body: { criterionId, reason, evidenceRefs: [`delivery:${detail.delivery?.id}`] } }), (r) => `Review request: ${r.data.challenge?.status ?? "?"}${r.data.challenge?.reason ? ` (${r.data.challenge.reason})` : ""}.`)
                }
                onReview={(body) => act("Submit decision", () => api(`/api/deals/${deal.id}/review`, { body }), (r) => `Decision: ${r.data.review?.status ?? "?"}${r.data.review?.reason ? ` (${r.data.review.reason})` : ""}; deal is now ${r.data.advance?.state ?? "?"}.`)}
                onPreAuth={(decision) => act("Pre-authorization decision", () => api(`/api/deals/${deal.id}/decision`, { body: { decision } }), (r) => `Deal is now ${r.data.state}${r.data.reason ? ` (${r.data.reason})` : ""}.`)}
              />
              <ActivityCard events={detail.events as Any[]} />
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------------------------- shell, login, status
function Shell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight">MANDATE</h1>
            <p className="text-xs text-slate-600 dark:text-slate-400">Human-authorized purchasing with independently verifiable delivery · PayPal Sandbox only</p>
          </div>
          {right}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-5">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-slate-600 dark:text-slate-400">
        Hackathon demo. Sandbox only – no real money. Production release and V2 are not enabled. The seller is a local simulator (a separate process, not an OS sandbox).
      </footer>
    </div>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    const r = await api<Any>("/api/auth/login", { body: { email, secret } });
    setPending(false);
    if (!r.ok) {
      setErr(r.status === 401 ? "Wrong email or password." : explain(r));
      return;
    }
    setCsrf(String(r.data.csrfToken));
    await onDone();
  }
  return (
    <div className="mx-auto mt-6 max-w-3xl">
      <Intro expanded />
      <div className="mx-auto mt-6 max-w-md">
      <Card title="Sign in as the buyer" subtitle="The principal is derived from this authenticated session on the server – never from request data.">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Email"><input className={inputCls} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Login secret" hint="Set locally as PRINCIPAL_LOGIN_SECRET in .env.local."><input className={inputCls} type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} required /></Field>
          {err && <p role="alert" className="text-sm text-rose-700">{err}</p>}
          <Btn type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Btn>
        </form>
      </Card>
      </div>
    </div>
  );
}

function StatusBar({ status, error }: { status: Status | null; error: string | null }) {
  if (error) return <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Server runtime is not ready: {error}. Check .env.local (see README).</div>;
  if (!status) return <p className="text-sm text-slate-600 dark:text-slate-400">Loading integration status…</p>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Chip label="Buyer Agent for new deals" value={status.buyerBrain === "llm" ? `Live AI · ${status.llmVendor} · ${status.llmModel}` : status.llmConfig === "incomplete" ? "Rule-based (AI NOT configured)" : "Rule-based (no AI)"} tone={status.buyerBrain === "llm" ? "violet" : status.llmConfig === "incomplete" ? "amber" : "slate"} />
      <Chip label="Seller" value={status.sellerConfigured ? "Local simulator" : "Not running"} tone={status.sellerConfigured ? "blue" : "red"} />
      <Chip label="Verification" value="Deterministic + human review" tone="green" />
      <Chip label="PayPal" value={status.paypal === "mock" ? "MOCK (in memory)" : status.sandboxWritesAuthorized ? "Sandbox (writes authorized)" : "Sandbox (writes LOCKED)"} tone={status.paypal === "mock" ? "amber" : status.sandboxWritesAuthorized ? "green" : "amber"} />
      <Chip label="Challenge window" value={`${status.challengeWindowSeconds}s`} tone="slate" />
      <Chip label="V2" value="Disabled" tone="slate" />
    </div>
  );
}

/** Short, plain statement of what this product does and what the buyer has authorized (live values when a mandate exists). */
function Intro({ mandate, expanded }: { mandate?: Any; expanded: boolean }) {
  return (
    <details open={expanded} className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950" data-testid="intro">
      <summary className="cursor-pointer rounded text-sm font-semibold text-indigo-950 dark:text-indigo-100">
        Your AI agent can negotiate the deal. MANDATE makes sure the agreement, not the AI&apos;s opinion, controls payment.
      </summary>
      <ol className="mt-3 grid gap-3 text-sm text-slate-800 dark:text-slate-200 md:grid-cols-3">
        <li>
          <p className="font-semibold">1. You set the authority</p>
          <p>
            {mandate
              ? `A signed mandate: ${money(mandate.budgetTotal)} budget, ${money(mandate.perDealMax)} per deal, you decide above ${money(mandate.requireHumanAbove)}.`
              : "You sign a mandate: a total budget, a per-deal limit and who the agent may deal with."}{" "}
            The agent cannot go beyond it.
          </p>
        </li>
        <li>
          <p className="font-semibold">2. The AI negotiates the price only</p>
          <p>Plain code checks every offer against your limit. The agent cannot change the task, the criteria or the amount.</p>
        </li>
        <li>
          <p className="font-semibold">3. Code decides whether payment proceeds</p>
          <p>The delivery is checked against the locked criteria by deterministic code, not by an AI. PayPal holds the funds until then. Sandbox only, no real money.</p>
        </li>
      </ol>
    </details>
  );
}

/** Why THIS deal is protected: every line is computed from the deal's own recorded values (see protectionFacts). Always visible inside the Deal card, never inside a collapsed panel. */
function ProtectionPanel({ deal, mandate }: { deal: Any; mandate?: Any }) {
  const t = deal.terms as Any | null | undefined;
  const facts = protectionFacts({
    mandate: mandate ? { perDealMax: String(mandate.perDealMax), sealVerified: !!mandate.sealVerified } : null,
    termsHash: deal.termsHash,
    terms: t ? { price: String(t.price), criteria: t.criteria as { type: string; required: boolean }[] } : null,
  });
  if (facts.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-900 dark:bg-indigo-950" data-testid="protection-facts">
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Why this deal is protected</p>
      <ul className="mt-1 space-y-1 text-sm text-slate-800 dark:text-slate-200">
        {facts.map((f, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className={f.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>{f.ok ? "✓" : "✕"}</span>
            <span><span className="sr-only">{f.ok ? "Confirmed: " : "Problem: "}</span>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STAGE_STYLE: Record<Stage["status"], { box: string; mark: string; word: string }> = {
  done: { box: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100", mark: "✓", word: "done" },
  current: { box: "border-indigo-500 bg-white text-slate-900 ring-2 ring-indigo-500 dark:bg-slate-900 dark:text-slate-100", mark: "●", word: "in progress" },
  attention: { box: "border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100", mark: "!", word: "needs you" },
  failed: { box: "border-rose-400 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100", mark: "✕", word: "stopped" },
  pending: { box: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", mark: "○", word: "not reached" },
};
/** Five accountability stages, each derived from recorded state (see presentation.ts). Nothing is marked done before it happened. */
function Workflow({ stages, paypal }: { stages: Stage[]; paypal: string | null }) {
  return (
    <div className="mt-4" data-testid="workflow">
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5" aria-label="Deal progress">
        {stages.map((s, i) => {
          const st = STAGE_STYLE[s.status];
          return (
            <li key={s.key} data-stage={s.key} data-status={s.status} aria-current={s.status === "current" ? "step" : undefined} className={cx("rounded-lg border px-3 py-2 text-xs", st.box)}>
              <p className="flex items-center gap-1.5 font-semibold">
                <span aria-hidden>{st.mark}</span>
                <span>{i + 1}. {s.label}</span>
              </p>
              <p className="mt-0.5"><span className="sr-only">{st.word}. </span>{s.note}</p>
            </li>
          );
        })}
      </ol>
      {paypal && <p className="mt-2 text-xs text-slate-700 dark:text-slate-300" data-testid="workflow-payment"><b>Payment:</b> {paypal}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- mandate
function MandateCard({ mandates, selected, onSelect, onCreated, setNotice }: { mandates: Any[] | null; selected: string; onSelect: (id: string) => void; onCreated: (id: string) => Promise<void>; setNotice: (n: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ budgetTotal: "100.00", perDealMax: "60.00", requireHumanAbove: "50.00", days: "30" });
  const [preview, setPreview] = useState<Any | null>(null);
  const [draft, setDraft] = useState<Any | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function buildDraft() {
    return {
      currency: "USD",
      budgetTotal: f.budgetTotal,
      perDealMax: f.perDealMax,
      requireHumanAbove: f.requireHumanAbove || undefined,
      allowedTaskTypes: ["data_cleaning"],
      counterparties: ["seller-sim"],
      injectionPolicy: "HUMAN_REVIEW",
      expiresAt: new Date(Date.now() + Number(f.days || "30") * 86_400_000).toISOString(),
    };
  }
  async function doPreview() {
    setPending(true);
    setErr(null);
    const d = buildDraft();
    const r = await api<Any>("/api/mandates/preview", { body: { draft: d } });
    setPending(false);
    if (!r.ok) return setErr(explain(r));
    setDraft(d);
    setPreview(r.data);
  }
  async function confirm() {
    if (!preview || !draft) return;
    setPending(true);
    const r = await api<Any>("/api/mandates", { body: { draft, confirmDigest: preview.digest } });
    setPending(false);
    if (!r.ok) return setErr(explain(r));
    setNotice({ kind: "info", text: `Mandate sealed (digest ${String(r.data.mandate.digest).slice(0, 12)}…). Seal verified: ${r.data.mandate.sealVerified ? "yes" : "NO"}.` });
    setPreview(null);
    setOpen(false);
    await onCreated(r.data.mandate.id);
  }

  return (
    <Card title="Buyer mandate" subtitle="Your signed spending authority. The agents cannot exceed it." right={<Btn tone="ghost" onClick={() => { setOpen((o) => !o); setPreview(null); setErr(null); }}>{open ? "Close" : "New mandate"}</Btn>}>
      {open && (
        <div className="mb-4 space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Total budget (USD)"><input className={inputCls} inputMode="decimal" value={f.budgetTotal} onChange={(e) => setF({ ...f, budgetTotal: e.target.value })} /></Field>
            <Field label="Max per deal (USD)"><input className={inputCls} inputMode="decimal" value={f.perDealMax} onChange={(e) => setF({ ...f, perDealMax: e.target.value })} /></Field>
            <Field label="Ask me above (USD)" hint="Deals above this need your approval."><input className={inputCls} inputMode="decimal" value={f.requireHumanAbove} onChange={(e) => setF({ ...f, requireHumanAbove: e.target.value })} /></Field>
            <Field label="Valid for (days)"><input className={inputCls} inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">Task: data cleaning · Counterparty: seller-sim · Currency: USD · Suspicious delivery text → human review.</p>
          {err && <p role="alert" className="text-sm text-rose-700">{err}</p>}
          {!preview ? (
            <Btn onClick={() => void doPreview()} disabled={pending}>{pending ? "Checking…" : "Preview"}</Btn>
          ) : (
            <div className="space-y-2 text-sm">
              <p>You are about to sign a mandate for <b>{money(preview.document.budgetTotal)}</b> total, <b>{money(preview.document.perDealMax)}</b> per deal, expiring {when(preview.document.expiresAt)}.</p>
              <p>Digest to confirm: <Mono>{preview.digest}</Mono></p>
              <div className="flex gap-2">
                <Btn onClick={() => void confirm()} disabled={pending}>{pending ? "Signing…" : "Confirm and sign"}</Btn>
                <Btn tone="ghost" onClick={() => setPreview(null)}>Edit</Btn>
              </div>
            </div>
          )}
        </div>
      )}
      {mandates === null ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">Loading…</p>
      ) : mandates.length === 0 ? (
        <Empty>No mandate yet. Create one to let an agent negotiate on your behalf.</Empty>
      ) : (
        <ul className="space-y-2">
          {mandates.map((m) => (
            <li key={m.id}>
              <button onClick={() => onSelect(m.id)} aria-current={selected === m.id ? "true" : undefined} className={cx("w-full rounded-lg border p-3 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500", selected === m.id ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950" : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800")}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{money(m.budgetTotal)} budget · {money(m.perDealMax)} per deal</span>
                  <Badge tone={m.sealVerified ? "green" : "red"}>{m.sealVerified ? "Seal verified" : "Seal INVALID"}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Ask above {money(m.requireHumanAbove)} · sellers: {m.counterparties.join(", ")} · expires {when(m.expiresAt)}</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Approved by {m.approvedBy} · <Mono>{String(m.digest).slice(0, 16)}…</Mono></p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- new deal
const PRESET_CRITERIA = [
  { id: "schema", text: "Columns are exactly id, email, joined", type: "deterministic", validator: "csv_schema_matches", params: { columns: ["id", "email", "joined"] }, required: true, weight: 40 },
  { id: "dupes", text: "No duplicate rows", type: "deterministic", validator: "no_duplicate_rows", params: {}, required: true, weight: 30 },
  { id: "dates", text: "The joined column uses YYYY-MM-DD", type: "deterministic", validator: "date_format_valid", params: { column: "joined", format: "YYYY-MM-DD" }, required: false, weight: 30 },
];
function NewDealCard({ mandate, status, busy, onOpen }: { mandate?: Any; status: Status | null; busy: boolean; onOpen: (brief: Any) => void }) {
  const [price, setPrice] = useState("20.00");
  const [desc, setDesc] = useState("Clean the customer CSV: unique rows, valid emails and dates (synthetic data)");
  const ready = !!mandate && !!status?.sellerConfigured;
  return (
    <Card title="New deal" subtitle="The Buyer Agent negotiates only the price. Criteria are fixed by you.">
      {!mandate ? (
        <Empty>Select or create a mandate first.</Empty>
      ) : (
        <div className="space-y-3">
          <Field label="Task"><textarea className={inputCls} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Field label="Target price (USD)" hint={`Ceiling is derived from your mandate (max ${money(mandate.perDealMax)}); the agent never sees it as authority.`}><input className={inputCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <div>
            <p className="mb-1 text-sm font-medium">Acceptance criteria (deterministic, locked into the terms)</p>
            <ul className="space-y-1 text-xs">
              {PRESET_CRITERIA.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 dark:border-slate-800">
                  <span>{c.text}</span>
                  <Badge tone={c.required ? "blue" : "slate"}>{c.required ? "required" : "optional"} · {c.weight}</Badge>
                </li>
              ))}
            </ul>
          </div>
          {!status?.sellerConfigured && <p className="text-xs text-rose-700">The seller simulator is not configured (SELLER_URL). Start it with <Mono>npm run seller</Mono>.</p>}
          <Btn disabled={!ready || busy} onClick={() => onOpen({ description: desc, criteria: PRESET_CRITERIA, deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(), targetPrice: price })}>Open deal &amp; negotiate</Btn>
        </div>
      )}
    </Card>
  );
}

function DealList({ deals, selected, onSelect }: { deals: Any[] | null; selected: string; onSelect: (id: string) => void }) {
  return (
    <Card title="Your deals">
      {deals === null ? <p className="text-sm text-slate-600 dark:text-slate-400">Loading…</p> : deals.length === 0 ? <Empty>No deals yet.</Empty> : (
        <ul className="space-y-1">
          {deals.map((d) => (
            <li key={d.id}>
              <button onClick={() => onSelect(d.id)} aria-current={selected === d.id ? "true" : undefined} className={cx("flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500", selected === d.id ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950" : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800")}>
                <span>{money(d.price)} · <span className="text-xs text-slate-600 dark:text-slate-400">{when(d.createdAt)}</span></span>
                <Badge tone={d.state === "CAPTURED" ? "green" : TERMINAL.has(d.state) ? "red" : d.state === "NEEDS_HUMAN" ? "amber" : "blue"}>{STATE_LABEL[d.state] ?? d.state}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- deal detail
function DealHeader({ detail, mandate }: { detail: Any; mandate?: Any }) {
  const d = detail.deal;
  const t = d.terms as Any | null;
  const tone: Tone = d.state === "CAPTURED" ? "green" : d.state === "NEEDS_HUMAN" ? "amber" : TERMINAL.has(d.state) ? "red" : "blue";
  return (
    <Card id="deal-detail" title="Deal" subtitle={`Seller ${d.sellerId} · opened ${when(d.createdAt)}`} right={<Badge tone={tone}>{STATE_LABEL[d.state] ?? d.state}</Badge>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Locked terms</p>
          {t ? (
            <>
              <p className="text-sm">{t.description}</p>
              <p className="mt-1 text-2xl font-semibold">{money(t.price)} <span className="text-xs font-normal text-slate-600 dark:text-slate-400">{t.currency}</span></p>
              <p className="text-xs text-slate-600 dark:text-slate-400">Terms hash <Mono>{String(d.termsHash).slice(0, 16)}…</Mono></p>
              <ul className="mt-2 space-y-1 text-xs">
                {(t.criteria as Any[]).map((c) => (
                  <li key={c.id} className="flex justify-between"><span>{c.text}</span><span className="text-slate-600 dark:text-slate-400">{c.required ? "required" : "optional"} · {c.weight}</span></li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">No terms locked yet.</p>
          )}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Mandate limits</p>
          {mandate ? (
            <ul className="mt-1 space-y-1 text-sm">
              <li>Budget {money(mandate.budgetTotal)} · per deal {money(mandate.perDealMax)}</li>
              <li>Ask me above {money(mandate.requireHumanAbove)}</li>
              <li>Seal: {mandate.sealVerified ? "verified" : "INVALID"} · <Mono>{String(mandate.digest).slice(0, 12)}…</Mono></li>
            </ul>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">-</p>
          )}
          {d.needsHumanReason && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">Needs you: {d.needsHumanReason}</p>}
        </div>
      </div>
      <ProtectionPanel deal={d} mandate={mandate} />
    </Card>
  );
}

function Negotiation({ detail, status }: { detail: Any; status: Status | null }) {
  const msgs = detail.negotiation as Any[];
  const runs = detail.modelRuns as Any[];
  const events = detail.events as Any[];
  const okRuns = runs.filter((r) => !(r.output as Any)?.failed);
  const failedRuns = runs.filter((r) => (r.output as Any)?.failed);
  const rejected = events.find((e) => e.type === "BUYER_OUTPUT_REJECTED");
  // truthful per deal: AI is claimed only if a model call for THIS deal succeeded; otherwise the buyer was the deterministic rule
  const usedAi = okRuns.length > 0;
  const buyerLabel = usedAi ? `Buyer Agent · ${status?.llmVendor ?? "AI"} · ${okRuns[0]?.model}` : "Buyer Agent · rule-based (no AI)";
  return (
    <Card title="Negotiation transcript" subtitle="The agents can only exchange typed price messages; the orchestrator checks every price against your mandate.">
      {msgs.length === 0 ? <Empty>No messages recorded.</Empty> : (
        <ul className="space-y-2">
          {msgs.map((m, i) => {
            const buyer = m.sender === "buyer";
            const p = m.payload as Any;
            return (
              <li key={i} className={cx("max-w-[85%] rounded-xl px-3 py-2 text-sm", buyer ? "ml-auto bg-indigo-50 dark:bg-indigo-950" : "bg-slate-100 dark:bg-slate-800")}>
                <p className="text-[11px] font-medium text-slate-600 dark:text-slate-400">Round {m.round} · {buyer ? buyerLabel : "Seller · local simulator"}</p>
                <p><b>{String(m.kind).replace("_", " ")}</b>{p?.price ? ` at ${money(p.price)}` : ""}</p>
                {p?.message && <p className="mt-1 text-slate-700 dark:text-slate-300">{String(p.message)}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {failedRuns[0] && (
        <div role="alert" className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
          <p className="font-medium">The AI provider failed – no fallback was used.</p>
          <p>The Buyer Agent ({failedRuns[0].model}) returned: {String((failedRuns[0].output as Any).error ?? "error")}{(failedRuns[0].output as Any).detail ? ` · ${String((failedRuns[0].output as Any).detail)}` : ""}. The negotiation was stopped instead of silently switching to the rule-based buyer.</p>
        </div>
      )}
      {failedRuns.length === 0 && rejected && (
        <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">The Buyer Agent&apos;s output was rejected: {String((rejected.payload as Any)?.error ?? "invalid")}. The negotiation was stopped.</div>
      )}
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">
        {runs.length > 0 ? (
          <>
            <p className="mb-1 font-medium text-violet-800 dark:text-violet-300">Model calls recorded for this deal: {runs.length} ({okRuns.length} succeeded, {failedRuns.length} failed)</p>
            <ul className="space-y-1">
              {runs.map((r, i) => (
                <li key={i}>
                  {r.role} · {r.model} · {r.latencyMs ?? "?"} ms · {(r.output as Any)?.failed ? <b className="text-rose-700">FAILED</b> : "ok"} · prompt <Mono>{String(r.promptHash).slice(0, 12)}…</Mono>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">
            No AI model was called for this deal: the Buyer Agent used its deterministic rule.
            {status?.llmConfig === "configured" ? ` (${status.llmVendor ?? "A model provider"} is configured on the server now, but this deal has no recorded call.)` : status?.llmConfig === "incomplete" ? ` ${status.llmConfigNote ?? "The model configuration is incomplete."}` : " A live model is used only when the server has a provider (Gemini or Groq), its key and a model configured."}
          </p>
        )}
      </div>
    </Card>
  );
}

function PayPalCard({ detail, status, busy, onCreateOrder, onMockApprove, onRefreshApproval, onCheckoutAdvanced }: { detail: Any; status: Status | null; busy: boolean; onCreateOrder: () => void; onMockApprove: () => void; onRefreshApproval: () => void; onCheckoutAdvanced: (text: string) => void }) {
  const d = detail.deal;
  const ops = detail.paypalOperations as Any[];
  const mock = status?.paypal === "mock";
  const life = paypalLifecycle(d.state, mock, ops as { status: string }[]);
  const label = mock ? "MOCK PayPal (in-memory simulation – no money, no PayPal call)" : status?.sandboxWritesAuthorized ? "PayPal Sandbox (writes authorized)" : "PayPal Sandbox (writes LOCKED – nothing is sent)";
  return (
    <Card title="PayPal payment" subtitle={label} right={<Badge tone={mock ? "amber" : "green"}>{mock ? "Mock" : "Sandbox"}</Badge>}>
      <p className="mb-3" data-testid="paypal-lifecycle"><Badge tone={life.tone}>{life.label}</Badge></p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Deal state</dt><dd>{STATE_LABEL[d.state] ?? d.state}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Order</dt><dd>{d.paypalOrderId ? <Mono>{d.paypalOrderId}</Mono> : "none yet"}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Authorization</dt><dd>{d.paypalAuthStatus ?? "-"}{d.paypalAuthId && <> <Mono>{d.paypalAuthId}</Mono></>}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Captured</dt><dd>{money(d.capturedAmount)}</dd></div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {["POLICY_CHECKED", "TERMS_LOCKED"].includes(d.state) && <Btn onClick={onCreateOrder} disabled={busy}>Create PayPal order</Btn>}
        {d.state === "AWAITING_BUYER_APPROVAL" && (
          <>
            {mock ? <Btn tone="amber" onClick={onMockApprove} disabled={busy}>Simulate buyer checkout (MOCK)</Btn> : <div className="w-full"><PayPalCheckout key={`${d.id}-${d.state}`} dealId={d.id} onAdvanced={onCheckoutAdvanced} />{d.approvalUrl && <a className="mt-2 inline-block text-xs text-indigo-700 underline" href={d.approvalUrl} target="_blank" rel="noreferrer">Fallback: open the PayPal Sandbox approval page</a>}</div>}
            {!mock && <Btn tone="ghost" onClick={onRefreshApproval} disabled={busy}>I approved – check PayPal</Btn>}
          </>
        )}
      </div>
      {d.state === "AWAITING_BUYER_APPROVAL" && !mock && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">You log in with the dedicated Sandbox buyer account on PayPal&apos;s page. This app learns the result only by asking PayPal (a fresh GET), never from a redirect.</p>}
      {ops.length > 0 && (
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="PayPal operations, scrollable table">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <caption className="sr-only">PayPal operations recorded for this deal</caption>
          <thead className="text-slate-600 dark:text-slate-400"><tr><th className="py-1">Operation</th><th>Status</th><th>PayPal resource</th><th>PayPal id</th><th>HTTP</th><th>When</th></tr></thead>
          <tbody>{ops.map((o, i) => <tr key={i} className="border-t border-slate-200 dark:border-slate-800"><td className="py-1">{o.type}</td><td>{o.status}</td><td>{o.resourceStatus ?? "-"}</td><td>{(o.type === "AUTHORIZE" ? d.paypalAuthId : o.resourceId) ? <Mono>{o.type === "AUTHORIZE" ? d.paypalAuthId : o.resourceId}</Mono> : "-"}</td><td>{o.responseStatus ?? "-"}</td><td>{when(o.createdAt)}</td></tr>)}</tbody>
        </table>
        </div>
      )}
      {ops.length === 0 && <p className="mt-3 text-xs text-slate-600 dark:text-slate-400">No PayPal operation has been attempted for this deal.</p>}
    </Card>
  );
}

function DeliveryCard({ detail, status, busy, onDeliver }: { detail: Any; status: Status | null; busy: boolean; onDeliver: (q: "good" | "duplicates" | "injection") => void }) {
  const d = detail.deal;
  const del = detail.delivery as Any | null;
  const ver = detail.verification as Any | null;
  const result = (ver?.result ?? null) as Any | null;
  const rows = useMemo(() => (del?.preview ? String(del.preview).trim().split("\n").map((l: string) => l.split(",")) : []), [del]);
  const canDeliver = d.state === "AWAITING_DELIVERY" && !del;
  const critText = new Map<string, string>(((d.terms?.criteria as Any[] | undefined) ?? []).map((c) => [String(c.id), String(c.text)]));
  return (
    <Card title="Seller delivery & evidence" subtitle="The delivery comes from the local seller simulator (synthetic data). Verification is deterministic code, not a model." right={<Badge tone="blue">Seller: local simulator</Badge>}>
      {canDeliver && (
        <div className="mb-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
          <p className="mb-2 text-sm font-medium">Ask the simulated seller to deliver:</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => onDeliver("good")} disabled={busy || !status?.sellerConfigured}>Clean delivery</Btn>
            <Btn tone="ghost" onClick={() => onDeliver("duplicates")} disabled={busy || !status?.sellerConfigured}>Delivery with duplicate rows</Btn>
            <Btn tone="ghost" onClick={() => onDeliver("injection")} disabled={busy || !status?.sellerConfigured}>Delivery with a hidden instruction</Btn>
          </div>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">These three behaviours show what the checks do: pay, refuse to pay, and stop for a human.</p>
        </div>
      )}
      {!del ? (
        <Empty>{d.state === "AWAITING_DELIVERY" ? "Waiting for the seller to deliver." : "Delivery is possible after the payment is authorized."}</Empty>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-400">{del.reference} · {del.size} bytes · submitted {when(del.submittedAt)} · sha256 <Mono>{String(del.sha256).slice(0, 16)}…</Mono></p>
          <div tabIndex={0} role="region" aria-label="Delivered file preview, scrollable table" className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">First rows of the delivered CSV file</caption>
              <thead className="bg-slate-50 dark:bg-slate-800">{rows[0] && <tr>{rows[0].map((h: string, i: number) => <th key={i} scope="col" className="px-2 py-1">{h}</th>)}</tr>}</thead>
              <tbody>{rows.slice(1).map((r: string[], i: number) => <tr key={i} className="border-t border-slate-200 dark:border-slate-800">{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {result ? (
            <div>
              <p className="mb-1 text-sm font-medium">
                Verification: <Badge tone={(result.skeptic?.flags as Any[] | undefined)?.length ? "amber" : result.overall === "ALL_REQUIRED_PASSED" ? "green" : result.overall === "REQUIRED_FAILED" ? "red" : "amber"}>{String(result.overall).replaceAll("_", " ").toLowerCase()}{(result.skeptic?.flags as Any[] | undefined)?.length ? " · FLAGGED for review" : ""}</Badge>
              </p>
              <ul className="space-y-1 text-sm">
                {(result.criteriaResults as Any[]).map((c) => (
                  <li key={c.criterionId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1 dark:border-slate-800">
                    <span>{critText.get(c.criterionId) ?? c.criterionId} <span className="text-xs text-slate-600 dark:text-slate-400">({c.criterionId}, {c.required ? "required" : "optional"}, {c.source})</span></span>
                    <span className="flex items-center gap-2 text-xs"><span className="text-slate-600 dark:text-slate-400">{c.actual}</span><Badge tone={c.status === "PASS" ? "green" : c.status === "FAIL" ? "red" : "amber"}>{c.status}</Badge></span>
                  </li>
                ))}
              </ul>
              {(result.skeptic?.flags as Any[] | undefined)?.length ? (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  <p className="font-medium">Flags raised by the scanner:</p>
                  <ul>{(result.skeptic.flags as Any[]).map((f, i) => <li key={i}>{f.code} · {f.severity}{f.severe ? " · severe" : ""} – {f.detail}</li>)}</ul>
                </div>
              ) : null}
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">AI assessment in this verification: {result.ai?.status === "NOT_CONFIGURED" ? "none (V1 deals never call a model)" : result.ai?.status}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">Verification has not produced a result yet.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/** The challenge window exactly as the server recorded it. The countdown follows the SERVER's clock and is display only: it never triggers or delays settlement. */
function WindowPanel({ detail, clockOffsetMs }: { detail: Any; clockOffsetMs: number }) {
  const d = detail.deal;
  const events = (detail.events as Any[]) ?? [];
  const [nowMs, setNowMs] = useState(() => Date.now());
  const counting = d.state === "VERIFYING" && !!d.challengeWindowEndsAt;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);
  const started = [...events].reverse().find((e) => e.type === "STATE_TRANSITION" && (e.payload as Any | null)?.to === "VERIFYING");
  const acceptedEarly = events.some((e) => e.type === "HUMAN_REVIEW_DECISION" && (e.payload as Any | null)?.decision === "accept" && (e.payload as Any | null)?.phase === "POST_AUTH");
  const v = challengeWindowView({ state: d.state, endsAt: d.challengeWindowEndsAt, reviewDeadline: d.reviewDeadline, startedAt: started?.createdAt ?? null, serverNowMs: nowMs + clockOffsetMs, acceptedEarly });
  if (!v) return null;
  const s = formatInstant(v.startedAt);
  const e = formatInstant(v.endsAt);
  const tone = v.phase === "open" ? "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100" : v.phase === "closed" ? "border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100";
  return (
    <div className={cx("mb-3 rounded-lg border p-3 text-sm", tone)} data-testid="challenge-window" data-phase={v.phase}>
      <p className="font-medium" role="timer">{v.headline}</p>
      <dl className="mt-1 grid grid-cols-1 gap-x-4 text-xs sm:grid-cols-2">
        {s && <div><dt className="inline font-medium">Started: </dt><dd className="inline"><time dateTime={s.utc} title={`UTC ${s.utc}`}>{s.local}</time></dd></div>}
        {e && <div><dt className="inline font-medium">{v.phase === "open" ? "Ends: " : "Ended: "}</dt><dd className="inline"><time dateTime={e.utc} title={`UTC ${e.utc}`}>{e.local}</time></dd></div>}
      </dl>
      <p className="mt-1 text-xs">{v.note}</p>
    </div>
  );
}

function DecisionCard({ detail, clockOffsetMs, busy, onAccept, onSettleCheck, onChallenge, onReview, onPreAuth }: { detail: Any; clockOffsetMs: number; busy: boolean; onAccept: () => void; onSettleCheck: () => void; onChallenge: (c: string, r: string) => void; onReview: (b: Any) => void; onPreAuth: (d: "approve" | "reject") => void }) {
  const d = detail.deal;
  const result = (detail.verification?.result ?? null) as Any | null;
  const crits = (result?.criteriaResults as Any[] | undefined) ?? [];
  const settlement = detail.settlement as Any | null;
  const [cid, setCid] = useState("");
  const [reason, setReason] = useState("");
  const unresolved = crits.filter((c) => c.status === "UNVERIFIABLE");
  const windowOpen = d.state === "VERIFYING";
  const needsPre = d.state === "NEEDS_HUMAN" && !detail.delivery;
  const needsPost = d.state === "NEEDS_HUMAN" && !!detail.delivery;
  const done = TERMINAL.has(d.state);
  const basis = settlement ? settlementBasis(d.state, (detail.events as { type: string; payload?: unknown }[] | undefined) ?? []) : null;
  return (
    <Card title="Your review & settlement" subtitle="Payment follows the signed mandate and the locked criteria. There is no unrestricted reject: the criteria decide.">
      <WindowPanel detail={detail} clockOffsetMs={clockOffsetMs} />
      {settlement && (
        <div className={cx("mb-3 rounded-lg border p-3 text-sm", d.state === "CAPTURED" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-slate-300 bg-slate-50 text-slate-900")}>
          <p className="font-medium">Settlement decision: {settlement.decision.replaceAll("_", " ").toLowerCase()} · {money(settlement.amount)}</p>
          <p className="text-xs">Reasons: {reasonText(settlement.reasonCodes)} · Deal state: {STATE_LABEL[d.state] ?? d.state}</p>
          {basis && <p className="mt-1 text-xs" data-testid="settlement-basis"><b>Basis:</b> {basis.text}</p>}
        </div>
      )}
      {!settlement && done && <p className="mb-3 text-sm text-slate-600">This deal ended as <b>{STATE_LABEL[d.state] ?? d.state}</b>; no settlement record exists.</p>}
      {needsPre && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-2">The price is above your approval threshold. Approve or reject before any PayPal order is created.</p>
          <div className="flex gap-2"><Btn onClick={() => onPreAuth("approve")} disabled={busy}>Approve this price</Btn><Btn tone="danger" onClick={() => onPreAuth("reject")} disabled={busy}>Reject</Btn></div>
        </div>
      )}
      {needsPost && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-1 font-medium">This delivery needs a human decision: {d.needsHumanReason ?? "flagged"}.</p>
          <p className="mb-2 text-xs">You may only give verdicts on criteria the machines could not resolve. Payment is still computed by the engine from the locked criteria; a flagged delivery stays blocked.</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => onReview({ kind: "approve" })} disabled={busy}>Submit decision (no extra verdicts)</Btn>
            {unresolved.map((c) => (
              <span key={c.criterionId} className="flex gap-1">
                <Btn tone="ghost" onClick={() => onReview({ kind: "approve", verdicts: [{ criterionId: c.criterionId, status: "met" }] })} disabled={busy}>{c.criterionId}: met</Btn>
                <Btn tone="ghost" onClick={() => onReview({ kind: "approve", verdicts: [{ criterionId: c.criterionId, status: "not_met" }] })} disabled={busy}>{c.criterionId}: not met</Btn>
              </span>
            ))}
          </div>
        </div>
      )}
      {windowOpen && (
        <div className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
          <p className="text-sm">The delivery passed verification. You can accept now, or wait for the challenge window to end (the deal then settles by itself when the server checks).</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400" data-testid="decision-explainer">
            <li><b>Accept now</b> only ends your own waiting period early. The amount still comes from the locked criteria.</li>
            <li><b>Do nothing</b>: if the window ends with no review request, the server settles under the <b>expired-window rule</b>. That is not recorded as an acceptance.</li>
            <li><b>Request review</b>: see below. Payment is paused while the same delivery is re-verified.</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={onAccept} disabled={busy}>Accept delivery</Btn>
            <Btn tone="ghost" onClick={onSettleCheck} disabled={busy}>Check settlement now</Btn>
          </div>
          <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
            <p className="mb-2 text-sm font-medium">Request review of one criterion</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <select className={inputCls} value={cid} onChange={(e) => setCid(e.target.value)} aria-label="Criterion"><option value="">Choose criterion…</option>{crits.map((c) => <option key={c.criterionId} value={c.criterionId}>{c.criterionId}</option>)}</select>
              <input className={cx(inputCls, "sm:col-span-2")} aria-label="Reason for the review request" placeholder="Why do you doubt it? (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="mt-2"><Btn tone="amber" disabled={busy || !cid || reason.trim().length < 10} onClick={() => onChallenge(cid, reason.trim())}>Request review</Btn></div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400" data-testid="review-explainer">A review request pauses payment and re-verifies the same delivery against the original locked terms. It cannot change the terms or the amount, and the window is not restarted: when re-verification finishes, the engine decides at once from the result (pay as the locked criteria dictate, or release the hold if required criteria fail). Up to 2 requests per deal, one per criterion. If a review is not completed within 72 hours, the deal goes to a human decision and nothing is captured or voided automatically.</p>
          </div>
        </div>
      )}
      {d.state === "SETTLEMENT_REVIEW" && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="review-in-progress">
          <p className="font-medium">Your review request is being processed. Payment is paused.</p>
          <p className="text-xs">The same delivery is re-verified against the original locked terms; the engine then decides from that result. If the review is not completed within 72 hours the deal goes to a human decision, and nothing is captured or voided automatically.</p>
        </div>
      )}
      {!windowOpen && !needsPre && !needsPost && !done && !settlement && <p className="text-sm text-slate-600 dark:text-slate-400">Nothing to decide yet.</p>}
      {done && !settlement && null}
    </Card>
  );
}

function ActivityCard({ events }: { events: Any[] }) {
  const [all, setAll] = useState(false);
  const [tech, setTech] = useState(false);
  const shown = all ? events : events.slice(-12);
  const toneCls = { neutral: "", good: "text-emerald-900 dark:text-emerald-200", attention: "text-amber-900 dark:text-amber-200", bad: "text-rose-900 dark:text-rose-200" } as const;
  return (
    <Card
      title="Activity & audit history"
      subtitle="Everything that happened to this deal, in order. The record is hash-chained, so it cannot be edited afterwards."
      right={
        <div className="flex gap-2">
          <Btn tone="ghost" onClick={() => setTech((t) => !t)}>{tech ? "Hide technical details" : "Show technical details"}</Btn>
          {events.length > 12 && <Btn tone="ghost" onClick={() => setAll((a) => !a)}>{all ? "Show latest" : `Show all ${events.length}`}</Btn>}
        </div>
      }
    >
      {events.length === 0 ? <Empty>No events.</Empty> : (
        <ol className="space-y-1 text-sm" data-testid="ledger">
          {shown.map((e) => {
            const line = ledgerLine(String(e.type), e.payload);
            return (
              <li key={e.seq} className="flex flex-wrap items-baseline gap-x-2 border-b border-slate-100 py-1.5 dark:border-slate-800">
                <span className="w-9 text-xs text-slate-600 dark:text-slate-400">#{e.seq}</span>
                <span className={cx("font-medium", toneCls[line.tone])}>{line.title}</span>
                <span className="ml-auto text-xs text-slate-600 dark:text-slate-400"><time dateTime={String(e.createdAt)} title={formatInstant(e.createdAt)?.utc}>{when(e.createdAt)}</time></span>
                {line.detail && <p className="w-full pl-11 text-xs text-slate-700 dark:text-slate-300">{line.detail}</p>}
                <p className="w-full pl-11 text-xs text-slate-600 dark:text-slate-400">
                  by {actorLabel(String(e.actor))}
                  {tech && <> · <Mono>{e.type}</Mono></>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
