import { model } from "@medusajs/framework/utils";
export default model.define("merchant_store_service_zone", {
  id: model.id({ prefix: "mszone" }).primaryKey(),
  merchant_store_id: model.text(),
  service_zone_id: model.text(),
  active: model.boolean().default(false),
  medusa_service_zone_id: model.text().nullable(),
}).indexes([
  { on: ["merchant_store_id", "service_zone_id"], unique: true },
  { on: ["medusa_service_zone_id"], unique: true, where: { medusa_service_zone_id: { $ne: null } } },
]);
