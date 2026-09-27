import { model } from "@medusajs/framework/utils";
export default model.define("marketplace_service_zone", {
  id: model.id({ prefix: "gszone" }).primaryKey(),
  name: model.text(),
  active: model.boolean().default(true),
  geometry: model.json(),
  delivery_fee_minor: model.number(),
  currency_code: model.enum(["zar"]).default("zar"),
});
