import { model } from "@medusajs/framework/utils";
export default model.define("merchant", {
  id: model.id({ prefix: "mer" }).primaryKey(), source_application_id: model.text().unique(),
  legal_name: model.text(), trading_name: model.text(), status: model.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE"),
});
