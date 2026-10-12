"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { MerchantOrderList, OrderOperationStatus } from "@gospaza/contracts";
import { orderMoney, orderStatusLabel, orderTime } from "@gospaza/ui/orders";
import { orderClient, orderError } from "../../order-client";
import { useMerchant } from "../shell";

const filters = ["PENDING_ACCEPTANCE", "ACCEPTED", "REJECTED"] as const;
function OrderList() {
  const [data, setData] = useState<MerchantOrderList | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<OrderOperationStatus | undefined>();
  const [offset, setOffset] = useState(0);
  const reload = useRef<(() => void) | null>(null);
  useEffect(() => {
    let active = true, generation = 0;
    async function read() {
      const version = ++generation;
      try {
        const result = await orderClient.list({ limit: 20, offset, status });
        if (active && version === generation) { setData(result); setError(""); }
      } catch (cause) {
        if (active && version === generation) { setData(null); setError(orderError(cause)); }
      }
    }
    reload.current = () => { setData(null); void read(); };
    const foreground = () => { if (document.visibilityState === "visible") reload.current?.(); };
    void read();
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [offset, status]);
  return <div className="application-content">
    <h1>Orders</h1>
    <label>Order status<select value={status ?? ""} onChange={(event) => {
      setData(null); setError(""); setOffset(0);
      setStatus(filters.find((value) => value === event.target.value));
    }}>
      <option value="">All statuses</option>
      {filters.map((value) => <option key={value} value={value}>{orderStatusLabel[value]}</option>)}
    </select></label>
    <button onClick={() => reload.current?.()}>Refresh orders</button>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {!data && !error && <p role="status">Loading orders…</p>}
    {data && !data.orders.length && <p>No orders found.</p>}
    {data && data.orders.length > 0 && <div className="table-scroll"><table>
      <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Delivery / pickup</th><th>Status</th><th>Total</th></tr></thead>
      <tbody>{data.orders.map((order) => <tr key={order.id}>
        <td><Link href={"/merchant/orders/" + encodeURIComponent(order.id)}>Order #{order.display_id}</Link><p>{orderTime(order.created_at)}</p></td>
        <td>{order.customer.first_name} {order.customer.last_name}<p>{order.customer.city}</p></td>
        <td>{order.items.map((item) => <p key={item.id}>{item.quantity} × {item.title}</p>)}</td>
        <td>{order.pickup.store_name}<p>{orderTime(order.delivery.starts_at)} – {orderTime(order.delivery.ends_at)}</p></td>
        <td>{orderStatusLabel[order.operational_status]}</td><td>{orderMoney(order.totals.total_minor)}</td>
      </tr>)}</tbody>
    </table></div>}
    {data && <nav aria-label="Order pages">
      <button disabled={data.offset === 0} onClick={() => { setData(null); setOffset(Math.max(0, data.offset - data.limit)); }}>Previous</button>
      <span>{data.count} orders</span>
      <button disabled={data.offset + data.limit >= data.count || data.offset + data.limit > 10000}
        onClick={() => { setData(null); setOffset(data.offset + data.limit); }}>Next</button>
    </nav>}
  </div>;
}
export default function Orders() {
  const { tenant } = useMerchant();
  return tenant.membership.capabilities.includes("MERCHANT_ORDER_VIEW")
    ? <OrderList key={tenant.membership.id} />
    : <h1>Order access unavailable</h1>;
}
