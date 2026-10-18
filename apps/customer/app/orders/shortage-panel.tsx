"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CustomerOrder, OrderShortages, OrderShortagePreference, ShortageResolution } from "@gospaza/contracts";
import { createCustomerOrderClient, OrderError } from "@gospaza/api-client";

const client = createCustomerOrderClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const labels = {
  CONTACT_ME: "Ask me before leaving an unavailable item out.",
  NO_SUBSTITUTION: "If an item is unavailable, leave it out rather than replacing it.",
};
type Action = { kind: "preference"; value: OrderShortagePreference } | { kind: "omit"; item: ShortageResolution };
export default function ShortagePanel({ order }: { order: CustomerOrder }) {
  const preferenceId = useId();
  const [data, setData] = useState<OrderShortages | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<OrderShortagePreference>("CONTACT_ME");
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const actions = useRef<{ read(): void; write(action: Action): void } | null>(null);
  useEffect(() => {
    let active = true, writing = false, generation = 0;
    let current: OrderShortages | null = null;
    const alive = (version: number) => active && version === generation;
    async function read() {
      const version = ++generation;
      try {
        const result = await client.shortages(order.id);
        if (!alive(version)) return;
        current = result; setData(result); setChoice(result.preference.preference); setError(""); setConfirmation(null);
      } catch (cause) {
        if (!alive(version)) return;
        current = null; setData(null); setConfirmation(null);
        setError(cause instanceof OrderError && [401,403,404].includes(cause.status)
          ? "Order unavailable. Sign in to the account that placed it."
          : "Shortage information is unavailable. Refresh before making a decision.");
      } finally { if (alive(version)) setLoading(false); }
    }
    async function write(action: Action) {
      const snapshot = current;
      if (!active || writing || !snapshot) return;
      if (action.kind === "preference" && snapshot.preference.frozen_at) return;
      if (action.kind === "omit" && !snapshot.shortages.some((item) => item.id === action.item.id
        && item.revision === action.item.revision && item.status === "CUSTOMER_DECISION_REQUIRED" && item.preference === "CONTACT_ME")) return;
      writing = true; ++generation; setBusy(true); setNotice(""); setConfirmation(null);
      try {
        if (action.kind === "preference") await client.updatePreference(order.id, {
          preference: action.value, expected_revision: snapshot.preference.revision,
        });
        else await client.omit(order.id, action.item.id, { expected_revision: action.item.revision, confirmed: true });
        if (active) setNotice("Saved. Showing the latest order information.");
      } catch (cause) {
        if (active) setNotice(cause instanceof OrderError && cause.status === 409
          ? "The order changed. Review the updated quantities and preference before deciding again."
          : "Your decision could not be confirmed. Review the refreshed state before trying again.");
      } finally {
        if (active) {
          current = null; setData(null); setLoading(true);
          await read(); // Refetch only. Never replay consent against a new quantity.
          writing = false; if (active) setBusy(false);
        }
      }
    }
    const reload = () => {
      if (active && !writing) { current = null; setLoading(true); setConfirmation(null); void read(); }
    };
    actions.current = { read: reload, write: (action) => { void write(action); } };
    const foreground = () => { if (document.visibilityState === "visible") reload(); };
    void read();
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
    return () => { active = false; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [order.id]);
  const disabled = loading || busy || !!error;
  return <section className="shortage-panel" aria-label="Unavailable items" aria-busy={loading || busy}>
    <h2>Unavailable items</h2>
    <button disabled={busy} onClick={() => actions.current?.read()}>Refresh shortages</button>
    {loading && <p role="status">Loading shortage information…</p>}
    {busy && <p role="status">Saving your decision…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <h3>Your order preference</h3>
      <p>{labels[data.preference.preference]}</p>
      {!data.preference.chosen_at && <p>This is the default; you have not explicitly selected a preference.</p>}
      {data.preference.frozen_at ? <p>The preference is fixed for this order because a shortage has been recorded.</p> :
        <form onSubmit={(event) => { event.preventDefault(); if (!disabled) actions.current?.write({ kind: "preference", value: choice }); }}>
          <fieldset disabled={disabled}><legend>Choose how unavailable items are handled</legend>
            <label htmlFor={preferenceId}>Unavailable item preference</label>
            <select id={preferenceId} value={choice} onChange={(event) => {
              const value = event.target.value;
              if (value === "CONTACT_ME" || value === "NO_SUBSTITUTION") setChoice(value);
            }}><option value="CONTACT_ME">Ask me first</option><option value="NO_SUBSTITUTION">Leave unavailable items out</option></select>
            <p>{labels[choice]}</p>
            <button type="submit">Save preference</button>
          </fieldset>
        </form>}
      {!data.shortages.length && <p>No unavailable items are awaiting a decision.</p>}
      {data.shortages.map((item) => <article className="shortage-card" key={item.id} aria-label={order.items.find((line) => line.id === item.line_id)?.title ?? "Unavailable item"}>
        <h3>{order.items.find((line) => line.id === item.line_id)?.title ?? "Unavailable item"}</h3>
        <dl className="shortage-counts"><div><dt>Ordered</dt><dd>{item.ordered_quantity}</dd></div>
          <div><dt>Physically picked</dt><dd>{item.picked_quantity}</dd></div>
          <div><dt>Unavailable and unresolved</dt><dd>{item.unresolved_quantity}</dd></div>
          <div><dt>Omitted</dt><dd>{item.omitted_quantity}</dd></div></dl>
        {item.status === "RESOLVED_OMITTED" ? <>
          <p>This quantity will not be supplied. Any payment adjustment has not yet been processed.</p>
          {item.preference === "NO_SUBSTITUTION" && <p>Your earlier order preference was used to leave this quantity out.</p>}
        </> : <>
          <p>These original items are unavailable. Picking can continue while you decide.</p>
          {item.preference === "CONTACT_ME" && (confirmation === item.id ? <>
            <p>Leave {item.unresolved_quantity} unavailable units out? Any payment adjustment has not yet been processed.</p>
            <button disabled={disabled} onClick={() => actions.current?.write({ kind: "omit", item })}>Confirm leaving these items out</button>
            <button disabled={busy} onClick={() => setConfirmation(null)}>Keep deciding</button>
          </> : <button disabled={disabled} onClick={() => setConfirmation(item.id)}>Leave unavailable quantity out</button>)}
        </>}
      </article>)}
    </>}
  </section>;
}
