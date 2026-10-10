import { model } from "@medusajs/framework/utils";

// Dispatch coordination and receipts, never a substitute for native Orders.
export default model.define("checkout_completion", {
  id: model.id({ prefix: "cpl" }).primaryKey(),
  checkout_attempt_id: model.text().unique(),
  operation_id: model.text().unique(),
  workflow_id: model.text(),
  transaction_id: model.text().unique(),
  input_fingerprint: model.text(),
  state: model.enum(["READY", "DISPATCHED", "SUCCEEDED", "RECOVERY_REQUIRED"]).default("READY"),
  dispatched_at: model.dateTime().nullable(),
  execution_id: model.text().nullable(),
  run_id: model.text().nullable(),
  native_state: model.text().nullable(),
  unresolved: model.json().nullable(),
  order_id: model.text().nullable(),
  terminal_receipt: model.json().nullable(),
  recovery_reason: model.text().nullable(),
});
