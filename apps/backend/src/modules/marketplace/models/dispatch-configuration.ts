import { model } from "@medusajs/framework/utils";
export default model.define("store_dispatch_configuration", {
  id: model.id({ prefix: "dcfg" }).primaryKey(), merchant_store_id: model.text().unique(), mode: model.enum(["DISABLED","MERCHANT_ONLY","PLATFORM_ONLY","HYBRID"]).default("DISABLED"), revision: model.number().default(1),
});
