import { model } from "@medusajs/framework/utils";
export default model.define("merchant_store", {
  id: model.id({ prefix: "mstore" }).primaryKey(), merchant_id: model.text().unique(), name: model.text(),
  address_line_1: model.text(), address_line_2: model.text(), city: model.text(), province: model.text(),
  postal_code: model.text(), country_code: model.text(), medusa_stock_location_id: model.text().nullable(),
});
