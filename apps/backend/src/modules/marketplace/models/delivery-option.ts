import { model } from "@medusajs/framework/utils";

export default model.define("delivery_option_configuration", {
  id: model.id({ prefix: "doption" }).primaryKey(),
  merchant_store_id: model.text(),
  store_service_zone_id: model.text(),
  mode: model.enum(["ASAP", "SCHEDULED"]),
  enabled: model.boolean().default(false),
  medusa_shipping_option_id: model.text().nullable(),
  revision: model.number().default(1),
  synced_revision: model.number().nullable(),
  sync_state: model.enum(["PENDING", "SYNCING", "READY", "FAILED"]).default("PENDING"),
  sync_error: model.text().nullable(),
}).indexes([
  { on: ["store_service_zone_id", "mode"], unique: true },
  { on: ["medusa_shipping_option_id"], unique: true, where: { medusa_shipping_option_id: { $ne: null } } },
  { on: ["id", "merchant_store_id", "store_service_zone_id"], unique: true },
]);
