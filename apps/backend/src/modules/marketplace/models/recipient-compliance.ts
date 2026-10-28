import { model } from "@medusajs/framework/utils";
export default model.define("recipient_compliance", {
  id: model.id({ prefix: "rcmp" }).primaryKey(), delivery_id: model.text(), commitment_id: model.text(),
  driver_profile_id: model.text(), generation_id: model.text().unique(), document_id: model.text(),
  outcome: model.enum(["SATISFIED","FAILED"]), reason: model.text().nullable(), evidence: model.json(),
  expected_revision: model.number(), verified_at: model.dateTime(),
});
