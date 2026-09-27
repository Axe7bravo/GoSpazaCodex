import { model } from "@medusajs/framework/utils";
export default model.define("customer_address_location", {
  id: model.id({ prefix: "caloc" }).primaryKey(),
  medusa_customer_address_id: model.text().unique(),
  latitude: model.float(),
  longitude: model.float(),
  source: model.enum(["browser_geolocation", "manual"]),
});
