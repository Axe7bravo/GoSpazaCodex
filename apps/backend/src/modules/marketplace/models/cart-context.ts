import { model } from "@medusajs/framework/utils";

export default model.define("cart_marketplace_context", {
  id: model.id({ prefix: "cmctx" }).primaryKey(),
  medusa_cart_id: model.text().unique(),
  merchant_id: model.text(),
  merchant_store_id: model.text(),
  superseded_at: model.dateTime().nullable(),
}).indexes([
  { on: ["id", "merchant_store_id"], unique: true },
  { on: ["id", "medusa_cart_id"], unique: true },
]);
