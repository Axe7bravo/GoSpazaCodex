"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { MerchantOrder } from "@gospaza/contracts";
import { OrderSummary, orderStatusLabel, orderTime } from "@gospaza/ui/orders";
import { OrderError } from "@gospaza/api-client";
import { orderClient, orderError } from "../../order-client";
import { useMerchant } from "../shell";

function Detail({ id, mayDecide }: { id: string; mayDecide: boolean }) {
  const [order, setOrder] = useState<MerchantOrder | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"accept" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const actions = useRef<{ refresh(): void; decide(action: "accept" | "reject", reason: string): void } | null>(null);
  useEffect(() => {
    let active = true, writing = false, generation = 0;
    let current: MerchantOrder | null = null;
    const alive = (version: number) => active && generation === version;
    async function read() {
      const version = ++generation;
      try {
        const result = await orderClient.detail(id);
        if (!alive(version)) return;
        current = result.order; setOrder(result.order); setError("");
        if (result.order.operational_status !== "PENDING_ACCEPTANCE") setConfirmation(null);
      } catch (cause) {
        if (!alive(version)) return;
        current = null; setOrder(null); setConfirmation(null); setError(orderError(cause));
      } finally { if (alive(version)) setLoading(false); }
    }
    async function decide(action: "accept" | "reject", reason: string) {
      const snapshot = current;
      if (!active || writing || !mayDecide || snapshot?.operational_status !== "PENDING_ACCEPTANCE") return;
      writing = true;
      const version = ++generation;
      setBusy(true); setNotice(""); setError("");
      try {
        const input = { expected_revision: snapshot.revision, confirmed: true as const };
        const result = action === "accept" ? await orderClient.accept(id, input)
          : await orderClient.reject(id, { ...input, reason });
        if (!alive(version)) return;
        current = { ...snapshot, ...result.decision };
        setOrder(current); setConfirmation(null); setReason("");
        await read();
      } catch (cause) {
        if (!alive(version)) return;
        setConfirmation(null);
        setNotice(cause instanceof OrderError && cause.status === 409
          ? "Another decision may already be recorded. Review the refreshed order."
          : "The decision could not be confirmed. Review the refreshed order before taking another action.");
        current = null; setOrder(null);
        await read(); // Read only: never retry a decision automatically.
      } finally { writing = false; if (active) setBusy(false); }
    }
    actions.current = {
      refresh: () => { if (active && !writing) { setLoading(true); void read(); } },
      decide: (action, reason) => { void decide(action, reason); },
    };
    const foreground = () => { if (document.visibilityState === "visible") actions.current?.refresh(); };
    void read();
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [id, mayDecide]);
  const disabled = loading || busy || !!error;
  return <div className="application-content order-page" aria-busy={loading || busy}>
    <Link href="/merchant/orders">All orders</Link>
    <h1>{order ? "Order #" + order.display_id : "Order details"}</h1>
    <button disabled={busy} onClick={() => actions.current?.refresh()}>Refresh order</button>
    {loading && <p role="status">Loading order…</p>}
    {busy && <p role="status">Recording decision…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="auth-error">{error}</p>}
    {order && <>
      <h2>{orderStatusLabel[order.operational_status]}</h2>
      <p>Placed {orderTime(order.created_at)}</p>
      <p>{order.customer.first_name} {order.customer.last_name} · {order.customer.city}</p>
      <p>Pickup: {order.pickup.store_name}, {order.pickup.address_line_1}, {order.pickup.city}</p>
      {order.operational_status === "REJECTED" && <>
        <p>This order will not be fulfilled.</p>
        {order.rejection_reason && <p>Rejection reason: {order.rejection_reason}</p>}
      </>}
      <OrderSummary order={order} />
      {mayDecide && order.operational_status === "PENDING_ACCEPTANCE" && <section aria-label="Order decision">
        {!confirmation ? <div className="order-actions">
          <button disabled={disabled} onClick={() => setConfirmation("accept")}>Accept</button>
          <button className="order-secondary" disabled={disabled} onClick={() => setConfirmation("reject")}>Reject</button>
        </div> : <form onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) actions.current?.decide(confirmation, reason);
        }}>
          <h2>{confirmation === "accept" ? "Accept this order?" : "Reject this order?"}</h2>
          {confirmation === "reject" && <>
            <p>This order will not be fulfilled. This decision cannot be reversed.</p>
            <label htmlFor="rejection-reason">Rejection reason (optional)</label>
            <textarea id="rejection-reason" maxLength={500} value={reason} disabled={disabled}
              onChange={(event) => setReason(event.target.value)} />
            <p>Up to 500 characters.</p>
          </>}
          <div className="order-actions">
            <button type="submit" disabled={disabled}>{confirmation === "accept" ? "Confirm acceptance" : "Confirm rejection"}</button>
            <button type="button" className="order-secondary" disabled={disabled} onClick={() => setConfirmation(null)}>Keep reviewing</button>
          </div>
        </form>}
      </section>}
    </>}
  </div>;
}
export default function OrderDetail({ id }: { id: string }) {
  const { tenant } = useMerchant();
  if (!tenant.membership.capabilities.includes("MERCHANT_ORDER_VIEW")) return <h1>Order access unavailable</h1>;
  return <Detail key={tenant.membership.id} id={id} mayDecide={tenant.membership.capabilities.includes("MERCHANT_ORDER_DECIDE")} />;
}
