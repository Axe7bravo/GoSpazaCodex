import type { FinancialAdjustmentView, OrderAdjustment, MerchantAdjustment } from "@gospaza/contracts";
import { orderMoney } from "./orders";

export const reasonLabel: Record<OrderAdjustment["reason"],string> = {
  ITEM_OMITTED:"Item omitted", MERCHANT_REJECTED:"Order declined by store",
  FULL_UNFULFILLABLE:"Order could not be fulfilled", RESTRICTED_HANDOFF_FAILED:"Restricted delivery could not be completed",
  GOODWILL:"Customer care adjustment",
};
export const causeLabel: Record<MerchantAdjustment["financial_cause"],string> = {
  MERCHANT:"Store", PLATFORM:"Platform", CUSTOMER_RECIPIENT:"Customer or recipient", POLICY:"Platform policy",
};
export function settlementLabel(row:OrderAdjustment) {
  if(row.default_method==="ORIGINAL_PAYMENT" && row.refund_status) return {
    PENDING:"Refund processing", SUCCEEDED:"Refunded to original payment method", FAILED:"Refund failed", ATTENTION_REQUIRED:"Refund needs review",
  }[row.refund_status];
  if(row.default_method==="STORE_CREDIT" && row.credit_status) return {
    PENDING:"Credit processing", CREDIT_ADDED:"Credit added to GoSpaza balance", REVIEW_PENDING:"Credit needs review",
  }[row.credit_status];
  return { REVIEW_REQUIRED:"Awaiting approval", ATTENTION_REQUIRED:"Adjustment needs review", APPROVED:"Approved · awaiting settlement" }[row.status];
}
export function Adjustment({row}:{row:OrderAdjustment}) {
  return <><strong>{reasonLabel[row.reason]}</strong>
    <p>{row.status==="APPROVED" ? "Approved amount" : "Amount under review"}: {orderMoney(row.amount_minor)}</p>
    <p>{row.default_method==="STORE_CREDIT" ? "GoSpaza balance" : "Original payment method"} · {settlementLabel(row)}</p>
  </>;
}
export function AdminSettlementStatus({row}:{row:FinancialAdjustmentView}) {
  if(row.refund_operation_state==="UNKNOWN") return <strong>Refund outcome unknown</strong>;
  const label=settlementLabel(row);
  return row.status==="ATTENTION_REQUIRED" || row.refund_status==="ATTENTION_REQUIRED" ||
    row.refund_status==="FAILED" || row.credit_status==="REVIEW_PENDING" ? <strong>{label}</strong> : <>{label}</>;
}
export function OrderAdjustments({rows}:{rows:OrderAdjustment[]}) {
  return rows.length ? <ul>{rows.map((row,i)=><li key={i}><Adjustment row={row}/></li>)}</ul>
    : <p>No adjustments recorded for this order.</p>;
}
export function FinanceFeedback({error,loaded,refresh}:{error:string;loaded:boolean;refresh:()=>void}) {
  return <>{error ? <p role="alert">Financial information is unavailable.</p> : !loaded && <p role="status">Loading financial information…</p>}
    <button type="button" onClick={refresh}>Refresh financial information</button></>;
}
