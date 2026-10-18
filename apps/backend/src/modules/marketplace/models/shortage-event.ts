import { model } from "@medusajs/framework/utils";

export default model.define("shortage_event", {
  id: model.id({ prefix: "shevt" }).primaryKey(),
  order_operation_id: model.text(),
  shortage_resolution_id: model.text().nullable(),
  action: model.text(),
  actor_type: model.enum(["customer", "merchant", "system"]),
  actor_id: model.text().nullable(),
  evidence: model.json(),
  occurred_at: model.dateTime(),
});
