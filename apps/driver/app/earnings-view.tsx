"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { createDriverFinanceClient } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { DriverFeedback } from "@gospaza/ui/drivers";
import { DriverEarningCard, DriverPaymentCard, driverFinanceMoney as orderMoney } from "@gospaza/ui/driver-finance";
const client = createDriverFinanceClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
function PaymentHistory() {
  const [after, setAfter] = useState<string>();
  const load = useCallback(() => client.payments(after), [after]); const r = useDriverResource(load, denied);
  return <section aria-label="Payment history"><h2>External payment history</h2><DriverFeedback error={r.error} loading={!r.data && !r.error}/>
    <button onClick={() => void r.refresh()}>Refresh payments</button>
    {r.data && <>{!r.data.items.length && <p>No external payments recorded on this page.</p>}
      {r.data.items.map(row => <DriverPaymentCard key={row.id} item={row}/>)}
      <button disabled={!after} onClick={() => setAfter(undefined)}>First payments</button>
      <button disabled={!r.data.next_after} onClick={() => setAfter(r.data?.next_after ?? undefined)}>Next payments</button></>}
  </section>;
}
export default function EarningsView() {
  const [after, setAfter] = useState<string>();
  const load = useCallback(() => client.own(after), [after]);
  const r = useDriverResource(load, denied);
  return <main className="driver-workspace driver-mobile"><Link href="/">Driver portal</Link><h1>Earnings and payments</h1>
    <DriverFeedback error={r.error} loading={!r.data && !r.error}/><button onClick={() => void r.refresh()}>Refresh earnings</button>
    {r.data && <><section className="driver-card" aria-label="Earning totals"><p>Unpaid and available: {orderMoney(r.data.unpaid_minor)}</p>
      <p>Payment under review: {orderMoney(r.data.reserved_minor)}</p>
      <p>Work without a resolved earning, including historical review, is not included as unpaid debt.</p></section>
      {!r.data.items.length && <p>No recorded earnings on this page.</p>}
      {r.data.items.map(item => <div key={item.id}><DriverEarningCard item={item}/><Link href={"/driver/earnings/" + encodeURIComponent(item.id)}>View earning {item.delivery_reference}</Link></div>)}
      {r.data.reviews.map(row => <p key={row.delivery_reference}>{row.delivery_reference}: Earning under review. No payable amount has been established.</p>)}
      <button disabled={!after} onClick={() => setAfter(undefined)}>First page</button>
      <button disabled={!r.data.next_after} onClick={() => { if (r.data?.next_after) setAfter(r.data.next_after); }}>Next earnings</button>
    </>}
    <PaymentHistory/>
  </main>;
}
export function EarningDetail({ id }: { id: string }) {
  const load = useCallback(() => client.earning(id), [id]);
  const r = useDriverResource(load, denied);
  return <main className="driver-workspace driver-mobile"><Link href="/driver/earnings">Earnings and payments</Link><h1>Earning detail</h1>
    <DriverFeedback error={r.error} loading={!r.data && !r.error}/><button onClick={() => void r.refresh()}>Refresh earning</button>
    {r.data && <><DriverEarningCard item={r.data}/><p>Order {r.data.order_reference}</p>{r.data.payment && <DriverPaymentCard item={r.data.payment}/>}</>}
  </main>;
}
