import { model } from "@medusajs/framework/utils";
export default model.define("refund_event", {
  id: model.id({ prefix: "rfev" }).primaryKey(), refund_operation_id: model.text(), revision: model.number(),
  action: model.text(), actor_id: model.text().nullable(), status: model.text(), evidence: model.json(),
});
