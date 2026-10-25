import { model } from "@medusajs/framework/utils";
export default model.define("pickup_operation", {
  id: model.id({ prefix: "pkop" }).primaryKey(), delivery_id: model.text(), action: model.enum(["PREPARE","SHIP"]),
  state: model.enum(["DISPATCHED","SUCCEEDED","RECOVERY_REQUIRED"]), workflow_id: model.text(), transaction_id: model.text().unique(),
  input: model.json(), input_fingerprint: model.text(), dispatched_at: model.dateTime(), native_state: model.text().nullable(),
  execution_id: model.text().nullable(), run_id: model.text().nullable(), fulfillment_id: model.text().nullable(), terminal_receipt: model.json().nullable(),
}).indexes([{ on: ["delivery_id","action"], unique: true }]);
