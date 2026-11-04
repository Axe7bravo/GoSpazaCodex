"use client";
import Link from "next/link";
import { OrderEconomicsPanel } from "@gospaza/ui/order-economics";
import { platformCommission } from "@gospaza/api-client";
import { useCallback, useState } from "react";
import { adminFinance } from "@gospaza/api-client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { AdminSettlementStatus, causeLabel, FinanceFeedback, reasonLabel } from "@gospaza/ui/financial";
import { orderMoney, orderTime } from "@gospaza/ui/orders";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { authClient } from "../../auth-client";

const client=adminFinance(process.env.NEXT_PUBLIC_API_URL!);
const economics=platformCommission(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/login");
const eventLabel:Record<string,string>={CREATED_FOR_REVIEW:"Submitted for review",AUTOMATICALLY_APPROVED:"Approved automatically",MANUALLY_APPROVED:"Approved by platform user"};
const components={MERCHANDISE:"Merchandise",TAX:"Tax",DELIVERY_FEE:"Delivery fee",GOODWILL:"Customer care"};
function Detail({order,id}:{order:string;id:string}) {
  const load=useCallback(()=>client.order(order),[order]);
  const r=useDriverResource(load,denied);
  const row=r.data?.adjustments.find(a=>a.id===id);
  return <section><h2>Adjustment detail</h2><FinanceFeedback loaded={!!r.data} error={r.error} refresh={()=>void r.refresh()}/>
    {row && <><h3>{reasonLabel[row.reason]}</h3><p>Order {row.order_id} · Attribution: {causeLabel[row.financial_cause]}</p>
      <p><AdminSettlementStatus row={row}/></p>
      {row.refund_operation_state && <p>Refund operation: {row.refund_operation_state.replaceAll("_"," ").toLowerCase()}</p>}
      {row.credit_operation_state && <p>Credit operation: {row.credit_operation_state.replaceAll("_"," ").toLowerCase()}</p>}
      <dl>{row.components.map((c,i)=><div key={i}><dt>{components[c.component]}</dt><dd>{orderMoney(c.amount_minor)}</dd></div>)}
        <dt>Reserved</dt><dd>{orderMoney(row.reserved_minor)}</dd><dt>Settled</dt><dd>{orderMoney(row.settled_minor)}</dd>
        <dt>Unsettled</dt><dd>{orderMoney(row.unsettled_minor)}</dd></dl>
      <h3>Recent adjustment activity</h3>
      <ul>{r.data?.history.filter(e=>e.adjustment_id===id).map((e,i)=><li key={i}>{orderTime(e.occurred_at)} · {eventLabel[e.action] ?? "Adjustment updated"} · {e.actor_type==="user" ? "Platform user":"System"}</li>)}</ul>
      {r.data?.dispositions && <><h3>Recorded stock decisions for this order</h3>
        {r.data.dispositions.length ? <ul>{r.data.dispositions.map(d=><li key={d.line_id}>{d.line_id} · {d.quantity} units · {d.decision==="RESTOCK" ? "Restock":"Non-sellable"} · {d.status.replaceAll("_"," ").toLowerCase()}</li>)}</ul> : <p>No stock decisions recorded.</p>}</>}
    </>}
  </section>;
}
function Queue({offset,change,selected,select,inspect}:{offset:number;change:(n:number)=>void;selected:string;select:(id:string)=>void;inspect:(order:string)=>void}) {
  const load=useCallback(()=>client.list(offset),[offset]);
  const r=useDriverResource(load,denied);
  const current=r.data?.adjustments.find(a=>a.id===selected);
  return <><FinanceFeedback loaded={!!r.data} error={r.error} refresh={()=>void r.refresh()}/>
    {r.data && <>{r.data.adjustments.length ? <div className="table-scroll"><table><caption>Financial adjustments</caption><thead><tr>
      <th>Order and reason</th><th>Amount</th><th>Settlement method</th><th>Status</th></tr></thead>
      <tbody>{r.data.adjustments.map(row=><tr key={row.id}>
        <td><button onClick={()=>select(row.id)}>{row.order_id} · {reasonLabel[row.reason]}</button></td>
        <td>{orderMoney(row.amount_minor)}</td><td>{row.default_method==="STORE_CREDIT" ? "Store Credit":"Original payment"}</td>
        <td><AdminSettlementStatus row={row}/></td></tr>)}</tbody></table></div> : <p>No adjustments on this page.</p>}
      <button disabled={offset===0} onClick={()=>change(offset-20)}>Previous page</button>
      <button disabled={r.data.adjustments.length<20} onClick={()=>change(offset+20)}>Next page</button>
      {current && <><button onClick={()=>inspect(current.order_id)}>Inspect this order’s marketplace economics</button>
        <Detail key={current.id} order={current.order_id} id={current.id}/></>}
    </>}
  </>;
}
export default function FinancialAdjustments() {
  const [offset,setOffset]=useState(0);
  const [lookup,setLookup]=useState<{actor:string;order:string}|null>(null);
  const [selection,setSelection]=useState<{actor:string;id:string}|null>(null);
  return <main className="application-layout"><SessionBoundary client={authClient} title="Financial adjustments">
    {identity=>identity.type==="user" && <section className="application-content"><Link href="/">Admin home</Link>
      <form key={identity.id} onSubmit={event=>{event.preventDefault();setLookup({actor:identity.id,order:String(new FormData(event.currentTarget).get("order")??"").trim()});}}>
        <label>Order reference <input name="order" required maxLength={100} pattern="[A-Za-z0-9_\-]+"/></label>
        <button>Inspect order economics</button>
      </form>
      {lookup?.actor===identity.id && lookup.order && <OrderEconomicsPanel key={identity.id+lookup.order} id={lookup.order} load={economics.order} denied={denied}/>}
      <Queue key={identity.id+offset} offset={offset} inspect={order=>setLookup({actor:identity.id,order})}
      change={n=>{setSelection(null);setOffset(n);}} selected={selection?.actor===identity.id ? selection.id:""}
      select={id=>setSelection({actor:identity.id,id})}/></section>}
  </SessionBoundary></main>;
}
