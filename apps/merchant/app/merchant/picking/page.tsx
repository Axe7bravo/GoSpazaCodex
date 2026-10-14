"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PickingList, PickingStatus } from "@gospaza/contracts";
import { PickingError } from "@gospaza/api-client";
import { orderTime } from "@gospaza/ui/orders";
import { pickingClient, pickingError, pickingLabels, assigneeLabel } from "../../picking-client";
import { useMerchant } from "../shell";

const filters = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"] as const;
function Queue() {
  const { tenant, refresh } = useMerchant();
  const [data, setData] = useState<PickingList | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<PickingStatus | undefined>();
  const [offset, setOffset] = useState(0);
  const reload = useRef<(() => void) | null>(null);
  useEffect(() => {
    let active = true, generation = 0;
    async function read() {
      const version = ++generation;
      try {
        const result = await pickingClient.list({ limit: 20, offset, status });
        if (active && version === generation) { setData(result); setError(""); }
      } catch (cause) {
        if (!active || version !== generation) return;
        setData(null); setError(pickingError(cause));
        if (cause instanceof PickingError && [401, 403].includes(cause.status)) void refresh();
      }
    }
    const reloadNow = () => { if (active) { setData(null); setError(""); void read(); } };
    reload.current = reloadNow;
    const foreground = () => { if (document.visibilityState === "visible") reloadNow(); };
    void read();
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => { active = false; window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [offset, status, refresh]);
  return <div className="application-content picking-page">
    <h1>Picking</h1>
    <p>Accepted orders ready for store-floor picking.</p>
    <div className="picking-toolbar">
      <label>Picking status<select value={status ?? ""} onChange={(event) => {
        setData(null); setError(""); setOffset(0); setStatus(filters.find((value) => value === event.target.value));
      }}><option value="">All picking states</option>{filters.map((value) => <option key={value} value={value}>{pickingLabels[value]}</option>)}</select></label>
      <button onClick={() => reload.current?.()}>Refresh picking queue</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading picking queue…</p>}
    {data && !data.orders.length && <p>No picking orders found.</p>}
    <div className="picking-cards">{data?.orders.map((order) => <article className="picking-card" key={order.id}>
      <h2><Link href={"/merchant/picking/" + encodeURIComponent(order.id)}>Pick order #{order.display_id}</Link></h2>
      <p>Placed {orderTime(order.created_at)}</p>
      <p>{pickingLabels[order.status]}</p>
      <p>Assignee: {assigneeLabel(order.assigned_member_id, tenant.membership.id)}</p>
      <p>{order.lines.filter((line) => line.unresolved_quantity === 0 && !line.shortage_recorded).length} of {order.lines.length} lines fully picked</p>
    </article>)}</div>
    {data && <nav aria-label="Picking pages">
      <button disabled={data.offset === 0} onClick={() => { setData(null); setOffset(Math.max(0, data.offset - data.limit)); }}>Previous</button>
      <span>{data.count} picking orders</span>
      <button disabled={data.offset + data.limit >= data.count || data.offset + data.limit > 10000}
        onClick={() => { setData(null); setOffset(data.offset + data.limit); }}>Next</button>
    </nav>}
  </div>;
}
export default function PickingQueue() {
  const { tenant } = useMerchant();
  return tenant.membership.capabilities.includes("MERCHANT_PICKING_VIEW") ? <Queue key={tenant.membership.id} /> : <h1>Picking access unavailable</h1>;
}
