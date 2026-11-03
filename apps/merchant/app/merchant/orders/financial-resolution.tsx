"use client";
import { useCallback } from "react";
import { merchantFinance } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { Adjustment, causeLabel, FinanceFeedback } from "@gospaza/ui/financial";

const client=merchantFinance(process.env.NEXT_PUBLIC_API_URL!);
const denied=()=>window.location.replace("/application");
export default function MerchantFinancialResolution({id}:{id:string}) {
  const load=useCallback(()=>client.order(id),[id]);
  const resource=useDriverResource(load,denied);
  return <section><h2>Order adjustments</h2>
    <FinanceFeedback loaded={!!resource.data} error={resource.error} refresh={()=>void resource.refresh()}/>
    {resource.data && (resource.data.adjustments.length
      ? <ul>{resource.data.adjustments.map((row,i)=><li key={i}><Adjustment row={row}/><p>Attribution: {causeLabel[row.financial_cause]}</p></li>)}</ul>
      : <p>No adjustments recorded for this order.</p>)}
  </section>;
}
