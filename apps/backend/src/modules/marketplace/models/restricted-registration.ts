import { model } from "@medusajs/framework/utils";
export default model.define("restricted_registration", {
  id: model.id({ prefix: "rreg" }).primaryKey(), merchant_id: model.text(), merchant_store_id: model.text().unique(),
  status: model.enum(["PENDING_REVIEW", "CHANGES_REQUIRED", "ACTIVE", "SUSPENDED", "REVOKED"]), revision: model.number().default(1),
  submission: model.json(), pending_submission: model.json().nullable(), trading_policy: model.json().nullable(), premises_fingerprint: model.text().nullable(),
  submitted_at: model.dateTime(), reviewed_at: model.dateTime().nullable(), approved_at: model.dateTime().nullable(),
  suspended_at: model.dateTime().nullable(), revoked_at: model.dateTime().nullable(), reviewed_by: model.text().nullable(),
});
