"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import type { DriverFinanceCapabilities, DriverPaymentEvidence, PlatformEarning, PublishDriverTerms, RecordDriverPayment } from "@gospaza/contracts";
import { AuthError, createPlatformDriverFinanceClient } from "@gospaza/api-client";
import { SessionBoundary } from "@gospaza/ui/auth";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { FinanceFeedback } from "@gospaza/ui/financial";
import { DriverEarningCard, DriverPaymentCard, driverEarningPaymentLabel, driverPaymentLabel, driverFinanceMoney as orderMoney } from "@gospaza/ui/driver-finance";
import { orderTime } from "@gospaza/ui/orders";
import { authClient } from "./auth-client";
const client = createPlatformDriverFinanceClient(process.env.NEXT_PUBLIC_API_URL!);
const denied = () => window.location.replace("/login");
const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
const cents = (raw: string) => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
const decision = (data: FormData) => ({ request_id: crypto.randomUUID(), reason: text(data, "reason"), confirmed: true as const });
function Terms({ manage }: { manage: boolean }) {
  const [after, setAfter] = useState<string>(), [draft, setDraft] = useState<PublishDriverTerms>();
  const [error, setError] = useState("");
  const load = useCallback(() => client.terms(after), [after]);
  const r = useDriverResource(load, denied);
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!r.data) return;
    const data = new FormData(event.currentTarget), amount = cents(text(data, "amount"));
    const raw = text(data, "effective"), effective = raw ? new Date(raw) : null;
    if (!amount || effective && (!Number.isFinite(effective.getTime()) || effective.getTime() <= Date.now())) { setError("Enter positive cents and a valid future time, or leave time empty for immediate publication."); return; }
    setError(""); setDraft({ ...decision(data), expected_revision: r.data.revision, amount_minor: amount, currency: "zar",
      ...(effective ? { effective_at: effective.toISOString() } : {}) });
  }
  return <section aria-label="Compensation terms"><h2>Platform compensation terms</h2>
    <FinanceFeedback error={r.error} loaded={!!r.data} refresh={() => void r.refresh()}/>
    {r.notice && <p role="status">{r.notice}</p>}{error && <p role="alert">{error}</p>}
    {r.data && <><p>Current effective rate: {r.data.current ? orderMoney(r.data.current.amount_minor) : "No applicable terms"}</p>
      <p>Zero-value terms are not supported. A missing rate is not a zero rate.</p>
      <p>Activation: {r.data.activation ? orderTime(r.data.activation.effective_at) : "Not activated"}. Publication alone does not activate compensation.</p>
      <div className="table-scroll"><table><caption>Compensation decision history</caption><thead><tr><th>Revision</th><th>Rate</th><th>Effective</th><th>Reason</th></tr></thead>
        <tbody>{r.data.items.map(row => <tr key={row.id}><td>{row.revision}</td><td>{orderMoney(row.amount_minor)}</td><td>{orderTime(row.effective_at)}</td><td>{row.reason}</td></tr>)}</tbody></table></div>
      {!r.data.items.length && <p>No published compensation terms on this page.</p>}
      <button disabled={!after} onClick={() => { setDraft(undefined); setAfter(undefined); }}>First terms</button>
      <button disabled={!r.data.next_after} onClick={() => { setDraft(undefined); setAfter(r.data?.next_after ?? undefined); }}>Next terms</button>
      {manage && <>{draft ? <section aria-label="Review compensation publication"><h3>Review publication</h3>
        <p>Platform flat · GoSpaza · ZAR · {orderMoney(draft.amount_minor)}</p><p>{draft.effective_at ? orderTime(draft.effective_at) : "Effective immediately"}</p><p>{draft.reason}</p>
        <button disabled={r.busy} onClick={() => void r.mutate(async () => {
          try { await client.publish(draft); setDraft(undefined); }
          catch (cause) { if (cause instanceof AuthError && cause.status === 409) setDraft(undefined); throw cause; }
        })}>Confirm publication</button>
        <button disabled={r.busy} onClick={() => setDraft(undefined)}>Back to terms</button></section>
        : <form onSubmit={review}><fieldset disabled={r.busy}><legend>Publish platform flat terms</legend>
          <label>Amount in cents<input name="amount" type="number" min="1" step="1" required/></label>
          <label>Future local effective time (empty for immediate)<input name="effective" type="datetime-local"/></label>
          <label>Reason<input name="reason" required maxLength={240}/></label><button>Review publication</button>
        </fieldset></form>}</>}
    </>}
  </section>;
}
function RecordTransfer({ rows, done }: { rows: PlatformEarning[]; done: (id?: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]), [draft, setDraft] = useState<RecordDriverPayment>();
  const [uncertain, setUncertain] = useState(false), [error, setError] = useState("");
  const load = useCallback(() => client.earnings(), []);
  const r = useDriverResource(load, denied);
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), amount = cents(text(data, "amount")), at = new Date(text(data, "time"));
    if (!selected.length || !amount || !Number.isFinite(at.getTime())) { setError("Select whole earnings and enter a valid observed amount and transfer time."); return; }
    setError(""); setDraft({ ...decision(data), earning_ids: selected, amount_minor: amount, currency: "zar", channel: "BANK_TRANSFER",
      beneficiary_reference: text(data, "beneficiary"), origin_reference: text(data, "origin"), external_transfer_id: text(data, "transfer"),
      transferred_at: at.toISOString(), evidence_reference: text(data, "evidence") });
  }
  return <section aria-label="Record external payment"><h3>Record an external transfer</h3>
    <p>GoSpaza records a transfer already attempted outside this application. This action does not send money.</p>
    <p>Select whole earnings for one driver. Use opaque evidence references, never bank-account numbers or credentials.</p>
    {r.notice && <p role="status">{r.notice}</p>}{error && <p role="alert">{error}</p>}
    {draft ? <><h4>Review external transfer</h4><p>Observed amount {orderMoney(draft.amount_minor)} · ZAR · {draft.earning_ids.length} whole earnings</p>
      <ul>{rows.filter(row => draft.earning_ids.includes(row.id)).map(row => <li key={row.id}>Driver {row.driver_profile_id} · {row.delivery_reference} · {orderMoney(row.amount_minor)}</li>)}</ul>
      <p>{orderTime(draft.transferred_at)} · {draft.external_transfer_id} · {uncertain ? "Outcome under review; earnings will remain reserved" : "Record successful payment"}</p>
      <p>Beneficiary {draft.beneficiary_reference} · Origin {draft.origin_reference} · {draft.reason}</p>
      <button disabled={r.busy} onClick={() => void r.mutate(async () => {
        try { const saved = await client.record(draft, uncertain); setDraft(undefined); done(saved.payment_id); }
        catch (cause) { if (cause instanceof AuthError && cause.status === 409) { setDraft(undefined); done(); } throw cause; }
      })}>
        {uncertain ? "Confirm uncertain attempt" : "Confirm record payment"}</button>
      <button disabled={r.busy} onClick={() => setDraft(undefined)}>Back to transfer</button></>
      : <form onSubmit={review}><fieldset disabled={r.busy}><legend>Whole unpaid earnings</legend>
        {rows.filter(row => row.payment_state === "UNPAID" && !row.attention_required).map(row => <label key={row.id}>
          <input type="checkbox" checked={selected.includes(row.id)} onChange={e => setSelected(current => e.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))}/>
          {row.delivery_reference} · {row.driver_profile_id} · {orderMoney(row.amount_minor)}</label>)}
        <label>Observed amount in cents<input name="amount" type="number" min="1" step="1" required/></label>
        <label>Verified beneficiary reference<input name="beneficiary" required maxLength={120}/></label>
        <label>Origin channel reference<input name="origin" required maxLength={120}/></label>
        <label>External transfer ID<input name="transfer" required maxLength={120}/></label>
        <label>Actual local transfer time<input name="time" type="datetime-local" required/></label>
        <label>Evidence reference<input name="evidence" required maxLength={120}/></label>
        <label>Reason<input name="reason" required maxLength={240}/></label>
        <label><input type="checkbox" checked={uncertain} onChange={e => setUncertain(e.target.checked)}/>Outcome is uncertain; reserve these earnings</label>
        <button>Review external transfer</button></fieldset></form>}
  </section>;
}
function PaymentOperations({ id, capabilities, done }: { id: string; capabilities: DriverFinanceCapabilities; done: () => void }) {
  const load = useCallback(() => client.evidence(id), [id]);
  const r = useDriverResource(load, denied), evidence = r.data;
  const [chosenAction, setAction] = useState(""), [draft, setDraft] = useState<{ action: string; data: FormData; request_id: string }>();
  const actions = evidence ? [
    ...(capabilities.reconcile && !evidence.attention_required && ["PAID", "CONFIRMED_PAID"].includes(evidence.state) ? ["RECONCILE"] : []),
    ...(capabilities.record && evidence.state === "UNKNOWN" && !evidence.discrepancies.length ? ["CONFIRMED_PAID", "CONFIRMED_NOT_PAID"] : []), "DISCREPANCY",
  ] : [];
  const action = actions.includes(chosenAction) ? chosenAction : actions[0] ?? "DISCREPANCY";
  function review(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setDraft({ action, data: new FormData(event.currentTarget), request_id: crypto.randomUUID() }); }
  async function execute(e: DriverPaymentEvidence, reviewDraft: { action: string; data: FormData; request_id: string }) {
    const data = reviewDraft.data, base = { request_id: reviewDraft.request_id, reason: text(data, "reason"), confirmed: true as const }, review_reference = text(data, "review"), evidence_reference = text(data, "evidence");
    if (reviewDraft.action === "RECONCILE") await client.reconcile(id, { ...base, driver_profile_id: e.driver_profile_id, earning_ids: e.items.map(row => row.earning_id),
      amount_minor: Number(e.amount_minor), currency: "zar", beneficiary_reference: e.beneficiary_reference, channel: e.channel,
      origin_reference: e.origin_reference, external_transfer_id: e.external_transfer_id, transferred_at: e.transferred_at, review_reference });
    else if (reviewDraft.action === "CONFIRMED_PAID") await client.confirmPaid(id, { ...base, review_reference, evidence_reference });
    else if (reviewDraft.action === "CONFIRMED_NOT_PAID") {
      const failure_category = (["BANK_REJECTED", "RETURNED_BEFORE_RECEIPT", "RAIL_CONFIRMED_FAILURE"] as const).find(v => v === text(data, "failure"));
      if (!failure_category) return;
      await client.confirmNotPaid(id, { ...base, review_reference, evidence_reference, nonreceipt_confirmed: true, failure_category });
    } else {
      const category = (["BENEFICIARY_MISMATCH", "AMOUNT_MISMATCH", "TRANSFER_DISPUTE", "DUPLICATE_EXTERNAL_RECORD", "RETURNED_TRANSFER", "RECONCILIATION_MISMATCH"] as const).find(v => v === text(data, "category"));
      if (!category) return; await client.discrepancy(id, { ...base, category, evidence_reference });
    }
    setDraft(undefined); done();
  }
  return <section aria-label="Restricted payment evidence"><h3>Payment evidence and review</h3>
    <FinanceFeedback loaded={!!evidence} error={r.error} refresh={() => void r.refresh()}/>{r.notice && <p role="status">{r.notice}</p>}
    {evidence && <><p>Driver {evidence.driver_profile_id} · {orderMoney(evidence.amount_minor)} · ZAR · {evidence.items.length} earnings</p>
      <p>Beneficiary {evidence.beneficiary_reference} · {evidence.channel} · {evidence.origin_reference} · {evidence.external_transfer_id}</p>
      <p>{orderTime(evidence.transferred_at)} · {evidence.state}</p>
      {evidence.attention_required && <p role="alert">Payment outcome or discrepancy needs review. History is retained.</p>}
      {draft ? <><h4>Confirm evidence review</h4><p>{draft.action} · {text(draft.data, "reason")}</p>
        <p>This records the reviewed evidence. It does not send money or rewrite payment history.</p>
        <button disabled={r.busy} onClick={() => void r.mutate(() => execute(evidence, draft))}>Confirm reviewed evidence</button>
        <button disabled={r.busy} onClick={() => setDraft(undefined)}>Back to evidence</button></>
        : <form onSubmit={review}><fieldset disabled={r.busy}><legend>Evidence-based action</legend>
          <label>Action<select value={action} onChange={e => setAction(e.target.value)}>
            {actions.includes("RECONCILE") && <option value="RECONCILE">Reconcile recorded payment</option>}
            {actions.includes("CONFIRMED_PAID") && <><option value="CONFIRMED_PAID">Confirmed paid</option><option value="CONFIRMED_NOT_PAID">Confirmed not paid</option></>}
            <option value="DISCREPANCY">Record discrepancy</option></select></label>
          {action !== "DISCREPANCY" && <label>Review reference<input name="review" required maxLength={120}/></label>}
          {action !== "RECONCILE" && <label>Evidence reference<input name="evidence" required maxLength={120}/></label>}
          {action === "CONFIRMED_NOT_PAID" && <><label>Proven nonreceipt category<select name="failure"><option>BANK_REJECTED</option><option>RETURNED_BEFORE_RECEIPT</option><option>RAIL_CONFIRMED_FAILURE</option></select></label>
            <label><input type="checkbox" required/>I confirm authoritative evidence proves the beneficiary did not receive funds.</label></>}
          {action === "DISCREPANCY" && <label>Discrepancy category<select name="category">{["BENEFICIARY_MISMATCH", "AMOUNT_MISMATCH", "TRANSFER_DISPUTE", "DUPLICATE_EXTERNAL_RECORD", "RETURNED_TRANSFER", "RECONCILIATION_MISMATCH"].map(c => <option key={c}>{c}</option>)}</select></label>}
          <label>Reason<input name="reason" required maxLength={240}/></label><label><input type="checkbox" required/>I reviewed the displayed evidence and confirm this assertion.</label>
          <button>Review evidence action</button></fieldset></form>}
    </>}
  </section>;
}
function PaymentDetail({ id, capabilities, done }: { id: string; capabilities: DriverFinanceCapabilities; done: () => void }) {
  const load = useCallback(() => client.payment(id), [id]); const r = useDriverResource(load, denied);
  return <section aria-label="Platform payment detail"><FinanceFeedback loaded={!!r.data} error={r.error} refresh={() => void r.refresh()}/>
    {r.data && <><DriverPaymentCard item={r.data.payment}/><p>Driver {r.data.payment.driver_profile_id}</p>
      {r.data.payment.discrepancies.map(c => <p role="alert" key={c}>Discrepancy: {c}</p>)}
      {r.data.earnings.map(e => <DriverEarningCard key={e.id} item={e}/>)}
      {(capabilities.record || capabilities.reconcile) && <PaymentOperations id={id} capabilities={capabilities} done={() => { void r.refresh(); done(); }}/>}</>}
  </section>;
}
function EarningInspector({ id }: { id: string }) {
  const load = useCallback(() => client.earning(id), [id]); const r = useDriverResource(load, denied);
  return <section aria-label="Platform earning detail"><FinanceFeedback loaded={!!r.data} error={r.error} refresh={() => void r.refresh()}/>
    {r.data && <><DriverEarningCard item={r.data}/><p>Driver {r.data.driver_profile_id} · Payer {r.data.payer} · {r.data.payer_classification}</p>
      <p>Frozen snapshot {r.data.snapshot.id} · Terms revision {r.data.snapshot.terms_revision} · {orderMoney(r.data.snapshot.amount_minor)}</p><p>Recorded {orderTime(r.data.recorded_at)}</p>
      {r.data.recognition_exceptions.map((ex, index) => <p role="alert" key={ex.reason + ":" + ex.recorded_at + ":" + index}>{ex.reason} · {orderTime(ex.recorded_at)}</p>)}</>}
  </section>;
}
function FinanceLists({ capabilities }: { capabilities: DriverFinanceCapabilities }) {
  const [driver, setDriver] = useState(""), [after, setAfter] = useState<string>(), [paymentAfter, setPaymentAfter] = useState<string>();
  const [reviewAfter, setReviewAfter] = useState<string>();
  const [payment, setPayment] = useState(""), [earning, setEarning] = useState<string>(), [epoch, setEpoch] = useState(0);
  const scope = JSON.stringify([driver, after, paymentAfter, reviewAfter, epoch]);
  const load = useCallback(async () => ({ scope, earnings: await client.earnings(after, driver), payments: await client.payments(paymentAfter, driver), reviews: await client.reviews(reviewAfter, driver) }), [scope, after, driver, paymentAfter, reviewAfter]);
  const r = useDriverResource(load, denied);
  const data = r.data?.scope === scope ? r.data : undefined;
  const done = (id?: string) => { if (id) setPayment(id); setEpoch(n => n + 1); };
  return <section><h2>Driver finance records</h2><form onSubmit={e => { e.preventDefault(); setDriver(text(new FormData(e.currentTarget), "driver")); setAfter(undefined); setPaymentAfter(undefined); setReviewAfter(undefined); setEarning(undefined); setPayment(""); }}>
    <label>Driver reference (empty for all)<input name="driver" maxLength={100}/></label><button>View driver finance</button></form>
    <FinanceFeedback loaded={!!data} error={r.error} refresh={() => void r.refresh()}/>
    {data && <>{!!data.reviews.items.length && <section aria-label="Recognition review"><h3>Earning recognition under review</h3>
      <p>These reviews do not establish a payable amount. Historical candidates are not unpaid debt.</p>
      {data.reviews.items.map(row => <p key={row.id}>{row.delivery_reference} · {row.reason} · {orderTime(row.recorded_at)}</p>)}</section>}
      <button disabled={!reviewAfter} onClick={() => setReviewAfter(undefined)}>First recognition reviews</button>
      <button disabled={!data.reviews.next_after} onClick={() => setReviewAfter(data.reviews.next_after ?? undefined)}>Next recognition reviews</button>
      <div className="table-scroll"><table><caption>Recorded earnings</caption><thead><tr><th>Driver</th><th>Delivery</th><th>Earned</th><th>State</th><th>Inspect</th></tr></thead>
      <tbody>{data.earnings.items.map(row => <tr key={row.id}><td>{row.driver_profile_id}</td><td>{row.delivery_reference}</td><td>{orderMoney(row.amount_minor)}</td>
        <td>{driverEarningPaymentLabel[row.payment_state]}{row.attention_required ? " · Under review" : ""}</td><td><button onClick={() => setEarning(row.id)}>Inspect earning {row.delivery_reference}</button></td></tr>)}</tbody></table></div>
      {!data.earnings.items.length && <p>No earnings on this page.</p>}
      <button disabled={!after} onClick={() => setAfter(undefined)}>First earnings</button><button disabled={!data.earnings.next_after} onClick={() => setAfter(data.earnings.next_after ?? undefined)}>Next earnings</button>
      {earning && <EarningInspector key={earning + ":" + epoch} id={earning}/>}
      {capabilities.record && <RecordTransfer key={driver + ":" + epoch} rows={data.earnings.items} done={done}/>}
      <div className="table-scroll"><table><caption>External payment records</caption><thead><tr><th>Driver</th><th>Amount</th><th>Reference</th><th>Status</th><th>Inspect</th></tr></thead>
        <tbody>{data.payments.items.map(row => <tr key={row.id}><td>{row.driver_profile_id}</td><td>{orderMoney(row.amount_minor)}</td><td>{row.reference}</td>
          <td>{driverPaymentLabel[row.state]}{row.attention_required ? " · Attention required" : ""}</td><td><button onClick={() => setPayment(row.id)}>Inspect payment {row.reference}</button></td></tr>)}</tbody></table></div>
      {!data.payments.items.length && <p>No payments on this page.</p>}
      <button disabled={!paymentAfter} onClick={() => setPaymentAfter(undefined)}>First payments</button><button disabled={!data.payments.next_after} onClick={() => setPaymentAfter(data.payments.next_after ?? undefined)}>Next payments</button>
      {payment && <PaymentDetail key={payment + ":" + epoch} id={payment} capabilities={capabilities} done={() => done()}/>}</>}
  </section>;
}
function Console() {
  const r = useDriverResource(client.capabilities, denied);
  return <section className="application-content"><Link href="/">Admin home</Link><FinanceFeedback loaded={!!r.data} error={r.error} refresh={() => void r.refresh()}/>
    {r.data && <>{r.data.view ? <FinanceLists capabilities={r.data}/> : <p>Earnings-view capability is required to inspect financial records.</p>}
      {(r.data.view || r.data.manage) && <Terms manage={r.data.manage}/>}</>}
  </section>;
}
export default function DriverFinanceConsole() {
  return <main className="application-layout"><SessionBoundary client={authClient} title="Driver finance">{actor => actor.type === "user" && <Console key={actor.id}/>}</SessionBoundary></main>;
}
