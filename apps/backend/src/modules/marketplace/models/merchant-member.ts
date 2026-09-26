import { model } from "@medusajs/framework/utils";
export default model.define("merchant_member", {
  id: model.id({ prefix: "mmem" }).primaryKey(), merchant_id: model.text().unique(),
  auth_identity_id: model.text().unique(), member_type: model.enum(["OWNER"]).default("OWNER"),
  status: model.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});
