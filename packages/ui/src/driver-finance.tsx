import type { DriverEarningSummary, DriverPaymentSummary } from "@gospaza/contracts";
import { orderTime } from "./orders";
import { settlementMoney } from "./settlements";
// Reuse the existing exact bigint/ZAR presentation, without financial arithmetic.
export const driverFinanceMoney = (minor: string | number) => settlementMoney(String(minor));
export const driverEarningPaymentLabel: Record<DriverEarningSummary["payment_state"], string> = {
  UNPAID: "Unpaid", RESERVED: "Payment under review", PAYMENT_RECORDED: "Payment recorded", RECONCILED: "Reconciled",
};
export const driverPaymentLabel: Record<DriverPaymentSummary["state"], string> = {
  UNDER_REVIEW: "Payment outcome under review", PAYMENT_RECORDED: "Payment recorded", CONFIRMED_NOT_PAID: "Confirmed not paid", RECONCILED: "Reconciled",
};
export function DriverEarningCard({ item }: { item: DriverEarningSummary }) {
  return <article className="driver-card" aria-label={"Earning " + item.delivery_reference}>
    <h2>{item.delivery_reference}</h2><p>Completed {orderTime(item.economic_at)}</p>
    <p>Earned {driverFinanceMoney(item.amount_minor)}</p><strong>{driverEarningPaymentLabel[item.payment_state]}</strong>
    {item.attention_required && <p role="status">Earning or payment under review. Existing history remains recorded.</p>}
    {item.payment && <><p>{item.payment.reference} · {orderTime(item.payment.payment_date)}</p><p>{driverPaymentLabel[item.payment.state]}</p></>}
  </article>;
}
export function DriverPaymentCard({ item }: { item: DriverPaymentSummary }) {
  return <section aria-label="Payment summary"><h2>{driverPaymentLabel[item.state]}</h2>
    <p>{driverFinanceMoney(item.amount_minor)} · {item.earning_count} whole earnings</p>
    <p>{item.reference} · {item.state === "UNDER_REVIEW" || item.state === "CONFIRMED_NOT_PAID" ? "Attempted" : "Transferred"} {orderTime(item.payment_date)}</p>
    {item.attention_required && <p role="alert">Payment needs review. Recorded history is retained.</p>}
    <p>Payment recording and reconciliation are separate platform records. Reconciliation does not mean you personally confirmed receipt.</p>
  </section>;
}
