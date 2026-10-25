import { model } from "@medusajs/framework/utils";
export default model.define("delivery_completion", {
  id: model.id({ prefix: "delop" }).primaryKey(), delivery_id: model.text().unique(), commitment_id: model.text(), generation_id: model.text().unique(),
  ship_operation_id: model.text(), workflow_id: model.text(), transaction_id: model.text().unique(), state: model.enum(["DISPATCHED", "RECOVERY_REQUIRED", "SUCCEEDED"]),
  dispatched_at: model.dateTime(), native_done: model.boolean().default(false), receipt: model.json().nullable(), next_due_at: model.dateTime(),
});
