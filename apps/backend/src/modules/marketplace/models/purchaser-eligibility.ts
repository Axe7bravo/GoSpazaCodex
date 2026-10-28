import { model } from "@medusajs/framework/utils";
export default model.define("purchaser_eligibility", {
  id: model.id({ prefix: "pelig" }).primaryKey(), customer_id: model.text(), method: model.text(), method_version: model.text(),
  policy_version: model.text(), minimum_age: model.number(), provincial_requirements_satisfied: model.boolean(),
  state: model.enum(["UNVERIFIED", "PENDING", "VERIFIED", "EXPIRED", "REVOKED"]),
  verified_at: model.dateTime().nullable(), expires_at: model.dateTime().nullable(),
});
