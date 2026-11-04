"use client";
import { useCallback } from "react";
import type { AdminOrderEconomics, CommissionException, MerchantOrderEconomics } from "@gospaza/contracts";
import { useDriverResource } from "./driver-resource";
import { orderMoney,orderTime } from "./orders";
import { FinanceFeedback } from "./financial";

export const commissionRate=(bps:number|null)=>bps===null?"No applicable rate":(bps/100).toFixed(2)+"%";
const zero={MERCHANT_REJECTED:"The store declined this order.",FULL_UNFULFILLABLE:"All units were omitted.",FAILED_RESTRICTED_HANDOFF:"The restricted delivery was not handed over."};
const reasons:Record<CommissionException,string>={
  MISSING_COMMISSION_TERMS:"No applicable historical commission terms.",UNKNOWN_PROMOTION_SPONSORSHIP:"Promotion funding is unverified.",
  ECONOMIC_EVIDENCE_MISMATCH:"Order amounts require review.",RECOGNITION_EVIDENCE_MISMATCH:"Delivery evidence requires review.",
  UNRESOLVED_ADJUSTMENT_ATTRIBUTION:"Adjustment attribution requires review.",POSTING_SOURCE_CONFLICT:"Posting evidence conflicts with its source.",
};
export function OrderEconomicsPanel({id,load,denied}:{id:string;load:(id:string)=>Promise<MerchantOrderEconomics|AdminOrderEconomics>;denied:()=>void}) {
  const fetchOrder=useCallback(()=>load(id),[load,id]);
  const resource=useDriverResource(fetchOrder,denied);
  return <section aria-label="Marketplace economics"><h2>Marketplace economics</h2>
    <FinanceFeedback loaded={!!resource.data} error={resource.error} refresh={()=>void resource.refresh()}/>
    {resource.data && <OrderEconomicsView row={resource.data}/>}
  </section>;
}
export function OrderEconomicsView({row}:{row:MerchantOrderEconomics|AdminOrderEconomics}) {
  const platform="exceptions" in row?row:null, earned=row.earned??platform?.posting?.amounts;
  return <>
      <p>Order {row.order_id}</p>
      {platform && <p>Merchant {platform.merchant_id} · Store {platform.store_id}</p>}
      <p>Frozen commission rate: {row.basis_points===null?"Unavailable":commissionRate(row.basis_points)}</p>
      {row.state==="PENDING" && <p>Order finance is awaiting preparation.</p>}
      {row.state==="RESOLVED" && <p>Commission terms are frozen. No earned sale has been recorded.</p>}
      {row.state==="KNOWN_ZERO" && row.zero_reason && <p>No merchandise earnings. {zero[row.zero_reason]}</p>}
      {row.state==="UNRESOLVED" && <p><strong>Marketplace economics require review.</strong></p>}
      {platform && <>{platform.rule_revision!==null && platform.rule_effective_at && <p>Commission rule revision {platform.rule_revision} · {orderTime(platform.rule_effective_at)}</p>}
        {platform.evidence.basis_minor!==null && <p>Order basis before delivery: {orderMoney(platform.evidence.basis_minor)}</p>}
        {platform.exceptions.length>0 && <ul>{platform.exceptions.map((e,i)=><li key={i}>{reasons[e.reason]} · {orderTime(e.recorded_at)}</li>)}</ul>}</>}
      {earned && <><h3>{row.state==="UNRESOLVED"?"Previously recorded sale under review":"Earned sale"}</h3><dl>
        <dt>Recognized merchandise</dt><dd>{orderMoney(earned.merchandise_minor)}</dd>
        <dt>Attributable tax</dt><dd>{orderMoney(earned.tax_minor)}</dd>
        <dt>Platform-funded subsidy</dt><dd>{orderMoney(earned.subsidy_minor)}</dd>
        <dt>Commission basis</dt><dd>{orderMoney(earned.basis_minor)}</dd>
        <dt>Platform commission</dt><dd>{orderMoney(earned.commission_minor)}</dd>
        <dt>Merchant merchandise entitlement</dt><dd>{orderMoney(earned.entitlement_minor)}</dd>
        <dt>Economic date</dt><dd>{orderTime(earned.economic_at)}</dd>
        {platform?.recorded_at && <><dt>Recorded date</dt><dd>{orderTime(platform.recorded_at)}</dd></>}
      </dl></>}
    </>;
}
