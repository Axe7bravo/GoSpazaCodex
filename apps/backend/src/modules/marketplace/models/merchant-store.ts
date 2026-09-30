import { model } from "@medusajs/framework/utils";
export default model.define("merchant_store", {
  id: model.id({ prefix: "mstore" }).primaryKey(), merchant_id: model.text().unique(), name: model.text(),
  active: model.boolean().default(true),
  medusa_fulfillment_set_id: model.text().nullable(),
  address_line_1: model.text(), address_line_2: model.text(), city: model.text(), province: model.text(),
  postal_code: model.text(), country_code: model.text(), medusa_stock_location_id: model.text().nullable(),
}).indexes([
  { name: "merchant_store_id_merchant_unique", on: ["id", "merchant_id"], unique: true },
  { name: "merchant_store_fulfillment_unique", on: ["medusa_fulfillment_set_id"], unique: true, where: { medusa_fulfillment_set_id: { $ne: null } } },
  {
    name: "merchant_store_stock_location_unique",
    on: ["medusa_stock_location_id"],
    unique: true,
    where: { medusa_stock_location_id: { $ne: null } },
  },
]);
