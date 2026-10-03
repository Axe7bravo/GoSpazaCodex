import { model } from "@medusajs/framework/utils";
// Only marketplace ownership/compliance. Native Product owns commerce fields.
export default model.define("product_marketplace_profile", {
  id: model.id({ prefix: "pmprof" }).primaryKey(),
  merchant_id: model.text(),
  medusa_product_id: model.text().unique(),
  requires_age_verification: model.boolean().default(false),
});
