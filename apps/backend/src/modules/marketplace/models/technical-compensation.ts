import { model } from "@medusajs/framework/utils";

// One full technical refund instruction, linked to native financial resources.
export default model.define("technical_compensation", {
  id: model.id({ prefix: "tcomp" }).primaryKey(),
  operation_id: model.text().unique(),
  native_payment_id: model.text().unique(),
  provider_payment_id: model.text().unique(),
  amount_minor: model.number(),
  idempotency_key: model.text().unique(),
  request_json: model.text(),
  reason: model.text(),
  state: model.enum(["prepared", "sending", "uncertain", "pending", "succeeded"]).default("prepared"),
  receipt: model.json().nullable(),
  verified_event: model.json().nullable(),
  native_refund_id: model.text().nullable(),
  native_dispatch_at: model.dateTime().nullable(),
  replay_allowed: model.boolean().default(false),
  recovery_required: model.boolean().default(false),
});
