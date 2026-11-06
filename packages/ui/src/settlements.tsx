import type { MerchantSettlementDetail, SettlementState, SettlementSummary } from "@gospaza/contracts";
import { formatZarMinor as settlementMoney } from "@gospaza/contracts";
import { orderTime } from "./orders";
export const settlementStateLabel:Record<SettlementState,string>={DRAFT:"Draft",READY_FOR_APPROVAL:"Ready for approval",APPROVED:"Approved",
  FAILED:"Failed transfer attempt",PAID:"External payout recorded",RECONCILED:"Reconciled"};
export const settlementEventLabel:Record<string,string>={GENERATED:"Statement generated",READY:"Ready for approval",FINALIZED:"Nonpayable statement finalized",
  SUPERSEDED:"Draft superseded",APPROVE:"Settlement approved",PAY:"External payout recorded",FAIL:"Failed transfer attempt recorded",RETRY:"Retry authorized",
  RECONCILE:"Recorded payout reconciled",DISCREPANCY:"Payment discrepancy recorded"};
export { settlementMoney };
export function settlementPeriod(s:Pick<SettlementSummary,"period_start"|"period_end"|"timezone">) {
  const format=new Intl.DateTimeFormat("en-ZA",{dateStyle:"medium",timeStyle:"short",timeZone:s.timezone});
  return format.format(new Date(s.period_start))+" – "+format.format(new Date(s.period_end))+" ("+s.timezone+")";
}
export function settlementStatus(s:SettlementSummary) {
  if(s.superseded) return "Superseded statement";
  if(!s.payable_id && s.finalized) return "Statement finalized — no payout created";
  return s.payment_status?settlementStateLabel[s.payment_status]:settlementStateLabel[s.statement_status];
}
export function SettlementTable({rows,href}:{rows:SettlementSummary[];href:string}) {
  return rows.length?<div className="table-scroll"><table><caption>Period statements</caption><thead><tr>
    {["Store / period","Status","Merchant entitlement","Tax held","Incoming carry","Statement net","Positive payable","Held sources","Payment / review"].map(h=><th key={h}>{h}</th>)}
  </tr></thead><tbody>{rows.map(s=><tr key={s.id}><td><a href={href+"/"+encodeURIComponent(s.id)}>{s.store_name} · {settlementPeriod(s)}</a>
    {"merchant_id" in s && <p>Merchant {String(s.merchant_id)}</p>}</td>
    <td>{settlementStatus(s)}{s.attention_required && <strong> · Payment needs attention</strong>}</td>
    <td>{settlementMoney(s.current_effects_minor)}</td><td>{settlementMoney(s.tax_held_minor)}</td><td>{settlementMoney(s.incoming_carry_minor)}</td>
    <td>{settlementMoney(s.net_minor)}</td><td>{s.payable_id?settlementMoney(s.payable_minor):"No payout created"}</td><td>{s.excluded_count}</td>
    <td>{!s.payable_id?"No payout created":<>{s.paid_at?"Recorded "+orderTime(s.paid_at):"No payout recorded"}<br/>{s.reconciled_at?"Reconciled "+orderTime(s.reconciled_at):"Not reconciled"}</>}</td>
  </tr>)}</tbody></table></div>:<p>No period statements on this page.</p>;
}
export function SettlementStatement({detail}:{detail:MerchantSettlementDetail}) {
  const s=detail.statement;
  return <section aria-label="Period statement"><h2>{settlementStatus(s)}</h2>
    <p>{s.store_name} · {settlementPeriod(s)}</p>
    {s.attention_required && <p role="alert">Payment needs operational attention. Recorded payment history remains unchanged.</p>}
    <dl className="application-summary">
      <div><dt>Recognized merchandise</dt><dd>{settlementMoney(s.merchandise_minor)}</dd></div>
      <div><dt>Tax held</dt><dd>{settlementMoney(s.tax_held_minor)}</dd></div>
      <div><dt>Platform subsidy</dt><dd>{settlementMoney(s.subsidy_minor)}</dd></div>
      <div><dt>Platform commission</dt><dd>{settlementMoney(s.commission_minor)}</dd></div>
      <div><dt>Merchant entitlement in this statement</dt><dd>{settlementMoney(s.current_effects_minor)}</dd></div>
      <div><dt>Incoming carry</dt><dd>{settlementMoney(s.incoming_carry_minor)}</dd></div>
      <div><dt>Signed statement net</dt><dd>{settlementMoney(s.net_minor)}</dd></div>
      <div><dt>Outgoing carry</dt><dd>{settlementMoney(s.outgoing_carry_minor)}</dd></div>
      <div><dt>Positive payable</dt><dd>{s.payable_id?settlementMoney(s.payable_minor):"No payout created"}</dd></div>
      <div><dt>Included sources</dt><dd>{s.included_count}</dd></div><div><dt>Held / excluded sources</dt><dd>{s.excluded_count}</dd></div>
    </dl><p>Tax held is disclosed separately under current settlement policy and is excluded from this payout. Delivery charges are excluded.</p>
    {!s.payable_id && <p>No payout created.{s.outgoing_carry_minor!=="0"?" Carried forward: "+settlementMoney(s.outgoing_carry_minor):""}</p>}
    <h3>Included orders</h3>{detail.items.length?<ul>{detail.items.map(i=><li key={i.order_id+"_"+i.economic_at}>{i.order_id} · {settlementMoney(i.entitlement_minor)}{i.prior_period?" · Prior-period item":""}</li>)}</ul>:<p>No included orders.</p>}
    <h3>Held sources</h3>{detail.holds.length?<ul>{detail.holds.map(h=><li key={h.order_id}>{h.order_id} · {h.category==="HISTORICAL_REVIEW"?"Historical item under review":"Financial item under review"}
      {h.held_minor===null?" · Amount not established":" · Recorded source amount "+settlementMoney(h.held_minor)}</li>)}</ul>:<p>No held sources.</p>}
    {detail.payment && <section aria-label="Recorded external payout"><h3>Recorded external payout</h3><p>{settlementMoney(detail.payment.amount_minor)} · {orderTime(detail.payment.transferred_at)}</p>
      <p>Payment reference: {detail.payment.external_reference}</p><p>Verified beneficiary reference recorded.</p>
      <p>{s.reconciled_at?"Reconciled "+orderTime(s.reconciled_at):"Reconciliation pending"}</p></section>}
  </section>;
}
