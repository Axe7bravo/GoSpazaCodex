import { model } from "@medusajs/framework/utils";
export default model.define("financial_settlement", {
  id: model.id({ prefix: "fset" }).primaryKey(), adjustment_id: model.text(),
  method: model.enum(["ORIGINAL_PAYMENT", "STORE_CREDIT"]), amount_minor: model.number(),
  currency: model.text(), state: model.enum(["RESERVED", "SETTLED", "RELEASED"]),
});
