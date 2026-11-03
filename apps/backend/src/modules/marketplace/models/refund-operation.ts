import { model } from "@medusajs/framework/utils";
export default model.define("refund_operation", {
  id: model.id({ prefix: "rfop" }).primaryKey(), settlement_id: model.text(), adjustment_id: model.text(),
  order_id: model.text(), merchant_id: model.text(), store_id: model.text(), customer_id: model.text().nullable(),
  provider_operation_id: model.text(), checkout_id: model.text(), provider_payment_id: model.text(),
  payment_id: model.text(), capture_id: model.text(), account_fingerprint: model.text(), mode: model.text(),
  amount_minor: model.number(), currency: model.text(), status: model.text(), revision: model.number().default(1),
  current_attempt_id: model.text().nullable(), native_dispatched_at: model.dateTime().nullable(), native_refund_id: model.text().nullable(),
  order_dispatched_at: model.dateTime().nullable(), order_transaction_id: model.text().nullable(),
  attention_reason: model.text().nullable(), settled_at: model.dateTime().nullable(),
});
