import Link from "next/link";
import type { AttentionPage, DeliveryDiagnostic, DeliveryRescueCommand, OperationsHealth, OperationsOverview, OperationsTimeline, OrderDiagnostic } from "@gospaza/contracts";
import { orderTime } from "@gospaza/ui/orders";
import { formatZarMinor, operationsLookupTypes } from "@gospaza/contracts";
import type { FormEventHandler } from "react";
const shown = (value: string | null | undefined) => value ?? "Not recorded";
export function ExactLookupForm({ busy, submit }: { busy: boolean; submit: FormEventHandler<HTMLFormElement> }) {
  return <form onSubmit={submit}><fieldset disabled={busy}><label htmlFor="operations-lookup-type">Record type</label>
    <select id="operations-lookup-type" name="type">{operationsLookupTypes.map(type => <option key={type} value={type}>{type}</option>)}</select>
    <label htmlFor="operations-lookup-id">Exact record ID</label><input id="operations-lookup-id" name="id" required maxLength={128}/><button>Find authorized record</button></fieldset></form>;
}
export function AttentionTable({ page }: { page: AttentionPage }) {
  return <section aria-label={page.source + " attention"}><h2>{page.source.replaceAll("_", " ")}</h2>
    <p>{page.page_count} on this page{page.has_more ? "; more available" : ""}. Observed {orderTime(page.observed_at)}.</p>
    {!page.items.length ? <p>No current attention in this source sample.</p> : <div className="table-scroll"><table><caption>Current domain attention</caption>
      <thead><tr><th>Domain / reference</th><th>Category</th><th>Status / reason</th><th>Recorded</th><th>Context</th></tr></thead>
      <tbody>{page.items.map(row => <tr key={row.domain + ":" + row.record_type + ":" + row.record_id}><td>{row.domain}<br/>{row.reference}</td>
        <td>{row.category}</td><td>{row.status}<br/>{row.reason_code}<p>{row.summary}</p></td><td>{row.created_at ? orderTime(row.created_at) : "Not recorded"}</td>
        <td>{row.link ? <Link href={row.link}>Open domain context</Link> : "No linked console"}</td></tr>)}</tbody></table></div>}
  </section>;
}
export function OverviewView({ data }: { data: OperationsOverview }) {
  return <><h2>Needs attention</h2><p>Bounded current samples, not global totals. Observed {orderTime(data.observed_at)}.</p>
    {data.navigation.orders && <p><Link href="/admin/orders">Orders · exact-ID diagnostics</Link></p>}
    {data.navigation.deliveries && <p><Link href="/admin/operations/attention">Deliveries / attention</Link></p>}
    {!data.sections.length && <p>No operational source sections are available to this account.</p>}
    {data.sections.map(section => section.availability === "AVAILABLE" ? <AttentionTable key={section.source} page={section.page}/>
      : <section key={section.source}><h2>{section.source}</h2><p role="status">Source unavailable; this is not an empty result.</p></section>)}
    <section aria-label="Existing domain tools"><h2>Existing domain tools</h2><ul>{data.links.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}</ul></section></>;
}
export function DeliveryView({ data }: { data: DeliveryDiagnostic }) {
  return <section aria-label="Delivery diagnostics"><h2>Delivery {data.id}</h2><dl className="application-summary">
    <dt>Order / Store</dt><dd>{data.order_id} · {data.store_id}</dd><dt>Delivery / search</dt><dd>{data.status} · generation {data.generation} · revision {data.revision}</dd>
    <dt>Policy / path</dt><dd>{data.mode} · {shown(data.path)}</dd><dt>Attention</dt><dd>{shown(data.reason_code)}</dd>
    <dt>Commitment / driver</dt><dd>{data.commitment ? `${data.commitment.status} · ${data.commitment.id} · ${data.commitment.driver_profile_id}` : "No recorded commitment"}</dd>
    <dt>Pickup</dt><dd>{data.pickup.length ? data.pickup.map(p => `${p.action}: ${p.state}`).join(" · ") : "Not started"}</dd>
    <dt>Completion</dt><dd>{shown(data.completion_state)}</dd><dt>Return</dt><dd>{shown(data.return_state)}</dd>
    {Object.entries(data.timing).map(([label, at]) => <div key={label}><dt>{label.replaceAll("_", " ")}</dt><dd>{at ? orderTime(at) : "Not recorded"}</dd></div>)}
    <dt>Rescue precheck</dt><dd>{data.rescue.eligible ? "Persisted precheck passes; current admission must still be validated." : shown(data.rescue.block_reason)}</dd>
  </dl></section>;
}
export function OrderView({ data }: { data: OrderDiagnostic }) {
  return <><section aria-label="Order diagnostics"><h2>Order {data.order.id}</h2><p>{data.order.status} · {data.order.currency}</p>
    <h3>Merchant / Store</h3><p>{data.store ? `${data.store.name} · ${data.store.merchant_id} · ${data.store.store_id}` : "No proven store context"}</p>
    <h3>Checkout / Operation</h3><p>Handoff {data.handoff}. {data.operation ? `${data.operation.status} · revision ${data.operation.revision}` : "No operation recorded; no repair was performed."}</p>
    <h3>Picking</h3><p>{data.picking ? `${data.picking.status} · revision ${data.picking.revision}` : "Not recorded"}</p>
    {data.unavailable_sections.map(section => <p key={section} role="status">{section} information is unavailable.</p>)}</section>
    {data.delivery && <><h3>Dispatch / Delivery / Attention</h3><DeliveryView data={data.delivery}/><Link href={"/admin/dispatch/" + encodeURIComponent(data.delivery.id)}>Open Delivery diagnostics</Link></>}
    {data.finance && <section aria-label="Authorized financial context"><h2>Financial context</h2>{!data.finance.items.length && <p>No adjustments in this sample.</p>}
      {data.finance.items.map(item => <p key={item.id}>{item.reason} · {item.status} · {item.currency === "zar" ? formatZarMinor(item.amount_minor) : item.amount_minor + " minor units " + item.currency}
        {" · "}{item.method} · refund {shown(item.refund_state)} · credit {shown(item.credit_state)}</p>)}
      {data.finance.truncated && <p>More financial records exist; use the authorized financial console.</p>}</section>}</>;
}
export function TimelineView({ data }: { data: OperationsTimeline }) {
  return <section aria-label="Operational timeline"><h2>Timeline</h2><p>Independent source samples; not a complete global audit history.</p>
    {data.pages.map(page => <section key={page.source}><h3>{page.source}</h3>{!page.items.length && <p>No events in this source page.</p>}
      <ul>{page.items.map(item => <li key={item.id}>{orderTime(item.timestamp)} · {item.label} · {item.summary}</li>)}</ul></section>)}</section>;
}
export function HealthView({ data }: { data: OperationsHealth }) {
  return <section aria-label="Operational health"><h2>Worker / system signals</h2><p>Observed {orderTime(data.observed_at)}. Configuration and pending work do not prove successful execution.</p>
    {data.workers.map(row => <p key={row.name}>{row.name}: Not instrumented · configuration {row.enabled === null ? "Unknown" : row.enabled ? "Enabled" : "Disabled"}
      {" · "}{row.sample_count} {row.sample_kind.toLowerCase().replaceAll("_", " ")} in sample{row.has_more ? " (more available)" : ""}</p>)}
    {data.notifications && <section aria-label="Persisted notification signals"><h3>Notification observations</h3>
      <p>{data.notifications.sampled} sampled{data.notifications.truncated ? " (truncated)" : ""} · {data.notifications.ambiguous} ambiguous transport outcomes. Provider acceptance is not proof of delivery.</p>
      {data.notifications.workers.map(worker => <p key={worker.name}>{worker.name} · {worker.enabled ? "Enabled" : "Disabled"} · last successful cycle {worker.last_success_at ? orderTime(worker.last_success_at) : "Unknown"} · {worker.last_error ? "Needs attention" : "No recorded error"}</p>)}
      <Link href="/admin/notifications">Open notification operations</Link></section>}</section>;
}
export function RescueReview({ data, command }: { data: DeliveryDiagnostic; command: DeliveryRescueCommand }) {
  return <section aria-label="Review dispatch rescue"><h3>Review search reopening</h3><p>{data.id} · search generation {command.expected_generation} · {shown(data.reason_code)}</p>
    <p>Reopen dispatch search from generation {command.expected_generation} to generation {command.expected_generation + 1} and re-enter normal dispatch. No driver is selected and the delivery is not completed.</p><p>Reason: {command.reason_code}</p></section>;
}
