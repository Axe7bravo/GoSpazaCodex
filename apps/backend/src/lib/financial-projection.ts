import type { FinancialAdjustmentView, OrderAdjustment } from "@gospaza/contracts";

export function orderAdjustment(row: FinancialAdjustmentView): OrderAdjustment {
  return { reason:row.reason, amount_minor:row.amount_minor, currency:row.currency,
    status:row.status, default_method:row.default_method, settled_minor:row.settled_minor,
    refund_status:row.refund_status, credit_status:row.credit_status };
}
