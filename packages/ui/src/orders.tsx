import type { CustomerOrder, OrderOperationStatus } from "@gospaza/contracts";

export const orderStatusLabel: Record<OrderOperationStatus, string> = {
  PENDING_ACCEPTANCE: "Awaiting merchant confirmation",
  ACCEPTED: "Accepted by the store",
  REJECTED: "Merchant cannot fulfill this order",
};
export const orderMoney = (minor: number) => new Intl.NumberFormat("en-ZA", {
  style: "currency", currency: "ZAR",
}).format(minor / 100);
export const orderTime = (value: string) => new Date(value).toLocaleString("en-ZA");

export function OrderSummary({ order }: { order: Pick<CustomerOrder, "items" | "totals" | "delivery"> }) {
  return <div className="order-columns">
    <section aria-label="Order items">
      <h2>Items</h2>
      <ul className="order-items">{order.items.map((item) => <li key={item.id}>
        <strong>{item.title}</strong>
        {item.variant_title && <span>{item.variant_title}</span>}
        <span>Quantity: {item.quantity} · Unit price: {orderMoney(item.unit_price_minor)}</span>
        <span>Line total: {orderMoney(item.total_minor)}</span>
      </li>)}</ul>
    </section>
    <section aria-label="Order details">
      <h2>Delivery window</h2>
      <p>{orderTime(order.delivery.starts_at)} – {orderTime(order.delivery.ends_at)}</p>
      <p>{order.delivery.shipping_name}</p>
      <h2>Order total</h2>
      <dl><dt>Subtotal</dt><dd>{orderMoney(order.totals.subtotal_minor)}</dd>
        <dt>Discount</dt><dd>{orderMoney(order.totals.discount_total_minor)}</dd>
        <dt>Tax</dt><dd>{orderMoney(order.totals.tax_total_minor)}</dd>
        <dt>Delivery</dt><dd>{orderMoney(order.totals.shipping_total_minor)}</dd>
        <dt>Total</dt><dd><strong>{orderMoney(order.totals.total_minor)}</strong></dd>
      </dl>
    </section>
  </div>;
}
