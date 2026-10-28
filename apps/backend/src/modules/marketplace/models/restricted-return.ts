import { model } from "@medusajs/framework/utils";
export default model.define("restricted_return", {
  id: model.id({ prefix: "rret" }).primaryKey(), delivery_id: model.text().unique(), compliance_id: model.text().unique(),
  commitment_id: model.text().unique(), merchant_store_id: model.text(), fulfillment_id: model.text(), physical_manifest: model.json(),
  state: model.enum(["RETURN_REQUIRED","RETURNING_TO_STORE","RETURNED_TO_STORE"]), failed_at: model.dateTime(),
  started_at: model.dateTime().nullable(), driver_arrived_at: model.dateTime().nullable(), returned_at: model.dateTime().nullable(),
  received_by: model.text().nullable(), financial_review_required: model.boolean().default(true),
});
