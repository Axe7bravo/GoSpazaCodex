"use client";
import { customerFinance } from "@gospaza/api-client";
import { useDriverResource } from "@gospaza/ui/driver-resource";
import { FinanceFeedback } from "@gospaza/ui/financial";
import { orderMoney } from "@gospaza/ui/orders";

export const finance=customerFinance(process.env.NEXT_PUBLIC_API_URL!,process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? "");
export const signIn=()=>window.location.replace("/login");
export default function Balance({onApply,disabled=false}:{onApply?:(use:boolean)=>void;disabled?:boolean}) {
  const resource=useDriverResource(finance.balance,signIn);
  return <section aria-label="GoSpaza balance"><h2>GoSpaza balance</h2>
    <FinanceFeedback error={resource.error} loaded={!!resource.data} refresh={()=>void resource.refresh()}/>
    {resource.data && <><strong>{orderMoney(resource.data.balance_minor)}</strong>
      <p>Available for future orders. Balance cannot be transferred or withdrawn.</p>
      {onApply && <><p>Review checkout to see the balance applied and the remaining Yoco payment.</p>
        <button type="button" disabled={disabled || resource.data.balance_minor===0} onClick={()=>onApply(true)}>Use available balance</button>
        <button type="button" disabled={disabled} onClick={()=>onApply(false)}>Remove balance from checkout</button></>}</>}
  </section>;
}
