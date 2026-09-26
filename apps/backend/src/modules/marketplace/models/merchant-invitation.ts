import { model } from "@medusajs/framework/utils";

export default model.define("merchant_invitation", {
  id: model.id({ prefix: "minv" }).primaryKey(),
  merchant_id: model.text(),
  email_normalized: model.text(),
  role: model.enum(["MANAGER", "PICKER"]),
  token_hash: model.text().unique(),
  expires_at: model.dateTime(),
  accepted_at: model.dateTime().nullable(),
  revoked_at: model.dateTime().nullable(),
  // Retires expired invites without pretending they were revoked.
  closed_at: model.dateTime().nullable(),
  created_by_member_id: model.text(),
  accepted_by_identity_id: model.text().nullable(),
});
