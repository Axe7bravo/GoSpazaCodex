import { model } from "@medusajs/framework/utils";
export default model.define("restricted_delivery_document", {
  id: model.id({ prefix: "rdoc" }).primaryKey(), order_operation_id: model.text().unique(), medusa_order_id: model.text().unique(), snapshot: model.json(),
});
