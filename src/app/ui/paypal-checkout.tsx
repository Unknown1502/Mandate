"use client";

/**
 * The buyer's PayPal SANDBOX checkout button (PayPal JavaScript SDK v6). It renders only when THE SERVER says the deal is eligible (GET /api/deals/:id/checkout: Sandbox mode,
 * configured client id, Sandbox writes unlocked, deal awaiting buyer approval, order and locked price on record). The browser supplies no amount, currency, order or buyer: the
 * order id it hands to PayPal's session is the one the server read from the deal record, and the amount shown is the server's. When the buyer approves, the browser's only action
 * is to ask OUR server to advance the deal; the server then re-reads the order from PayPal and authorizes (never captures). A browser "approved" callback is therefore reported as
 * "PayPal reported approval; asking PayPal for the real status", never as a payment.
 */
import { createElement, useEffect, useRef, useState } from "react";
import { PAYPAL_JS_SDK_V6_SANDBOX_URL } from "@/paypal/checkout";
import { api, explain } from "./api";

type Any = Record<string, any>;

function loadSdk(src: string): Promise<void> {
  // the server names the script URL, but the browser still refuses anything except the one allow-listed Sandbox origin
  if (src !== PAYPAL_JS_SDK_V6_SANDBOX_URL) return Promise.reject(new Error("unexpected SDK URL"));
  if ((window as Any).paypal?.createInstance) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.appendChild(s);
  });
}

type View = Any | null;
export function PayPalCheckout({ dealId, onAdvanced }: { dealId: string; onAdvanced: (message: string) => void }) {
  const [view, setView] = useState<View>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "working">("loading"); // the parent keys this component by deal and state, so it remounts instead of re-loading
  const [note, setNote] = useState<string>("");
  const btn = useRef<HTMLElement | null>(null);
  const sdk = useRef<Any | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const r = await api(`/api/deals/${dealId}/checkout`);
      if (dead) return;
      if (!r.ok) {
        setNote(explain(r));
        return setPhase("unavailable");
      }
      setView(r.data);
      if (!r.data.eligible) return setPhase("unavailable");
      try {
        await loadSdk(r.data.sdkUrl);
        const instance = await (window as Any).paypal.createInstance({ clientId: r.data.clientId, components: ["paypal-payments"], pageType: "checkout" });
        const methods = await instance.findEligibleMethods({ currencyCode: r.data.currency });
        if (dead) return;
        if (!methods.isEligible("paypal")) {
          setNote("PayPal reports that this checkout is not available for this browser or currency.");
          return setPhase("unavailable");
        }
        sdk.current = instance;
        setPhase("ready");
      } catch {
        if (!dead) {
          setNote("The PayPal checkout script could not be started (it may be blocked by the browser or a content policy).");
          setPhase("unavailable");
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [dealId]);

  useEffect(() => {
    const el = btn.current;
    if (phase !== "ready" || !el || !view?.eligible) return;
    const start = async () => {
      setPhase("working");
      setNote("");
      try {
        const session = sdk.current!.createPayPalOneTimePaymentSession({
          async onApprove(data: Any) {
            // never trust the callback: the id must be ours, and the SERVER decides what happened by asking PayPal
            if (data?.orderId !== view.orderId) {
              setNote("PayPal returned an unexpected order id; nothing was authorized.");
              return;
            }
            setNote("PayPal reported approval. Asking PayPal for the real status (not yet authorized until PayPal confirms)…");
            const r = await api(`/api/deals/${dealId}/advance`, { body: {} });
            onAdvanced(r.ok ? `PayPal approval received; the server checked PayPal and the deal is now ${r.data.state}${r.data.reason ? ` (${r.data.reason})` : ""}.` : explain(r));
          },
          onCancel() {
            setNote("Checkout was cancelled. Nothing was authorized and no money moved.");
          },
          onError() {
            setNote("PayPal reported an error during checkout. Nothing was authorized by this step; use “check PayPal” to see the real status.");
          },
        });
        await session.start({ presentationMode: "auto" }, Promise.resolve({ orderId: view.orderId }));
      } catch {
        setNote("Checkout could not be started. Nothing was authorized.");
      } finally {
        setPhase("ready");
      }
    };
    el.addEventListener("click", start);
    return () => el.removeEventListener("click", start);
  }, [phase, view, dealId, onAdvanced]);

  if (phase === "loading") return <p className="text-xs text-slate-600 dark:text-slate-400">Checking whether PayPal Sandbox checkout is available…</p>;
  if (phase === "unavailable") {
    const reason = String(view?.reason ?? "");
    return (
      <p className="text-xs text-slate-600 dark:text-slate-300" role="status">
        {reason === "SANDBOX_WRITES_LOCKED"
          ? "PayPal Sandbox checkout is not available: the operator has not unlocked Sandbox writes (PAYPAL_SANDBOX_WRITES), so nothing would be authorized."
          : reason === "SANDBOX_NOT_CONFIGURED"
            ? "PayPal Sandbox checkout is not available: Sandbox credentials are not configured on the server."
            : note || `PayPal Sandbox checkout is not available right now (${reason || "unknown"}).`}
      </p>
    );
  }
  return (
    <div>
      <p className="mb-2 text-xs text-slate-600 dark:text-slate-300">
        Approve <b>{view?.amount} {view?.currency}</b> on PayPal Sandbox. This creates an <b>authorization</b> (a hold) only: nothing is captured until delivery is verified and the settlement engine permits it.
      </p>
      {createElement("paypal-button", { ref: btn, type: "pay", "aria-label": "Approve payment with PayPal Sandbox" })}
      {phase === "working" && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">PayPal checkout is open…</p>}
      {note && <p className="mt-2 text-xs text-slate-600 dark:text-slate-300" role="status">{note}</p>}
    </div>
  );
}
