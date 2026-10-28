import { model } from "@medusajs/framework/utils";
export default model.define("restricted_event", {
  id: model.id({ prefix: "revt" }).primaryKey(), merchant_id: model.text().nullable(), merchant_store_id: model.text().nullable(),
  target_id: model.text(), actor_id: model.text(), action: model.text(), evidence: model.json(),
});
