import { model } from "@medusajs/framework/utils";

export default model.define("store_delivery_policy", {
  id: model.id({ prefix: "dpolicy" }).primaryKey(),
  merchant_store_id: model.text().unique(),
  timezone: model.text().default("Africa/Johannesburg"),
  asap_enabled: model.boolean().default(false),
  scheduled_enabled: model.boolean().default(false),
  minimum_lead_minutes: model.number().default(60),
  booking_horizon_days: model.number().default(7),
  hold_minutes: model.number().default(15),
  enabled: model.boolean().default(false),
  revision: model.number().default(1),
});
