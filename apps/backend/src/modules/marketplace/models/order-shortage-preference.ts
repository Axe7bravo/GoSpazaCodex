import { model } from "@medusajs/framework/utils";

export default model.define("order_shortage_preference", {
  id: model.id({ prefix: "osp" }).primaryKey(),
  order_operation_id: model.text().unique(),
  preference: model.enum(["CONTACT_ME", "NO_SUBSTITUTION"]).default("CONTACT_ME"),
  customer_id: model.text().nullable(),
  chosen_at: model.dateTime().nullable(),
  frozen_at: model.dateTime().nullable(),
  revision: model.number().default(1),
});
