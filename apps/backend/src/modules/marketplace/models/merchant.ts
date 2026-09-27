import { model } from "@medusajs/framework/utils";
export default model.define("merchant", {
  id: model.id({ prefix: "mer" }).primaryKey(), source_application_id: model.text().unique(),
  medusa_sales_channel_id: model.text().nullable(),
  legal_name: model.text(), trading_name: model.text(), status: model.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE"),
}).indexes([
  {
    name: "merchant_sales_channel_unique",
    on: ["medusa_sales_channel_id"],
    unique: true,
    where: { medusa_sales_channel_id: { $ne: null } },
  },
]);
