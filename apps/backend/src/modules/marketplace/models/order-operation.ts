import { model } from "@medusajs/framework/utils";

// Operational identity only. Commercial fields remain in the native Order.
export default model.define("order_operation", {
  id: model.id({ prefix: "oop" }).primaryKey(),
  medusa_order_id: model.text().unique(),
  checkout_completion_id: model.text().unique(),
  merchant_id: model.text(),
  merchant_store_id: model.text(),
  status: model.enum(["PENDING_ACCEPTANCE", "ACCEPTED", "REJECTED"]).default("PENDING_ACCEPTANCE"),
  revision: model.number().default(0),
  accepted_at: model.dateTime().nullable(),
  rejected_at: model.dateTime().nullable(),
  decided_by_member_id: model.text().nullable(),
  rejection_reason: model.text().nullable(),
}).indexes([{ name: "IDX_order_operation_tenant", on: ["merchant_id", "merchant_store_id", "created_at"] }]);
