import { model } from "@medusajs/framework/utils";

// One immutable domain audit per terminal merchant decision.
export default model.define("order_decision_event", {
  id: model.id({ prefix: "odevt" }).primaryKey(),
  order_operation_id: model.text().unique(),
  merchant_id: model.text(),
  merchant_store_id: model.text(),
  decided_by_member_id: model.text(),
  from_status: model.enum(["PENDING_ACCEPTANCE"]),
  to_status: model.enum(["ACCEPTED", "REJECTED"]),
  reason: model.text().nullable(),
  decided_at: model.dateTime(),
});
