"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CustomerOrder, OrderOperationStatus } from "@gospaza/contracts";
import { createCustomerOrderClient, OrderError } from "@gospaza/api-client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { OrderSummary, orderStatusLabel, orderTime } from "@gospaza/ui/orders";
import { authClient } from "../auth-client";

const client = createCustomerOrderClient(process.env.NEXT_PUBLIC_API_URL!, process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
const copy: Record<OrderOperationStatus, string> = {
  PENDING_ACCEPTANCE: "Your order has been received and is awaiting merchant confirmation.",
  ACCEPTED: "The merchant has accepted your order.",
  REJECTED: "This order will not be fulfilled. Payment resolution is still pending.",
};
function Content({ id }: { id: string }) {
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    let active = true, generation = 0;
    async function read() {
      const version = ++generation;
      try {
        const result = await client.detail(id);
        if (active && generation === version) { setOrder(result.order); setError(""); }
      } catch (cause) {
        if (active && generation === version) {
          setOrder(null);
          setError(cause instanceof OrderError ? cause.message : "Order information is unavailable. Please refresh.");
        }
      } finally { if (active && generation === version) setLoading(false); }
    }
    refresh.current = () => { if (active) { setLoading(true); void read(); } };
    const foreground = () => { if (document.visibilityState === "visible") refresh.current?.(); };
    void read();
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [id]);
  return <section className="order-page" aria-busy={loading}>
    <nav className="shop-nav"><Link href="/stores">Stores</Link><Link href="/account">Account</Link></nav>
    <h2>{order ? "Order #" + order.display_id : "Order details"}</h2>
    <button onClick={() => refresh.current?.()}>Refresh order</button>
    {loading && <p role="status">Loading order…</p>}
    {error && <p role="alert" className="shop-error">{error}</p>}
    {order && <>
      <h2>{orderStatusLabel[order.operational_status]}</h2>
      <p>{copy[order.operational_status]}</p>
      <p>{order.store.name} · Placed {orderTime(order.created_at)}</p>
      <OrderSummary order={order} />
    </>}
  </section>;
}
export default function CustomerOrderView({ id }: { id: string }) {
  return <main className="storefront"><SessionBoundary client={authClient} title="Your order">
    {(_identity, customer) => <Content key={customer?.id} id={id} />}
  </SessionBoundary></main>;
}
