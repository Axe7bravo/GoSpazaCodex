"use client";
import { useCallback } from "react";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { OrderAdjustments, FinanceFeedback } from "@gospaza/ui/financial";
import { orderMoney } from "@gospaza/ui/orders";
import { finance,signIn } from "../account/balance";

export default function FinancialResolution({id}:{id:string}) {
  const load=useCallback(()=>finance.order(id),[id]);
  const resource=useDriverResource(load,signIn);
  return <section aria-label="Payment and adjustments"><h2>Payment and adjustments</h2>
    <FinanceFeedback loaded={!!resource.data} error={resource.error} refresh={()=>void resource.refresh()}/>
    {resource.data && <>
      {resource.data.funding.store_credit_minor>0 && <dl>
        <dt>Order value before credit</dt><dd>{orderMoney(resource.data.funding.gross_minor)}</dd>
        <dt>GoSpaza balance used</dt><dd>{orderMoney(resource.data.funding.store_credit_minor)}</dd>
        <dt>Paid with Yoco</dt><dd>{orderMoney(resource.data.funding.original_payment_minor)}</dd>
      </dl>}
      <OrderAdjustments rows={resource.data.adjustments}/>
    </>}
  </section>;
}
