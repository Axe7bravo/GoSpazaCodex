import { model } from "@medusajs/framework/utils";

// Entitlement evidence only. Native commerce remains money-movement authority.
export default model.define("financial_adjustment", {
  id: model.id({ prefix: "fadj" }).primaryKey(), order_operation_id: model.text(), medusa_order_id: model.text(),
  merchant_id: model.text(), merchant_store_id: model.text(), customer_id: model.text().nullable(),
  source_type: model.text(), source_id: model.text(), source_revision: model.number(),
  reason: model.text(), financial_cause: model.text(), currency: model.text().default("zar"),
  amount_minor: model.number(), economic_bound_minor: model.number(), allocations: model.json(),
  economics_fingerprint: model.text(), eligible_methods: model.json(), default_method: model.text(),
  status: model.enum(["REVIEW_REQUIRED", "APPROVED", "ATTENTION_REQUIRED"]), revision: model.number().default(1),
  approved_at: model.dateTime().nullable(), approved_by: model.text().nullable(),
  source_review_required: model.boolean().default(true), policy_version: model.text(),
  request_fingerprint: model.text(),
}).indexes([{ on: ["source_type", "source_id", "source_revision", "reason"], unique: true },
  { on: ["merchant_id", "merchant_store_id", "medusa_order_id"] }]);
