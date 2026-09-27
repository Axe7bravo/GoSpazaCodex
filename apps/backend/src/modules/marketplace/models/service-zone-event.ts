import { model } from "@medusajs/framework/utils";
export default model.define("service_zone_event", {
  id: model.id({ prefix: "szevt" }).primaryKey(),
  service_zone_id: model.text(),
  platform_user_id: model.text(),
  action: model.enum(["CREATED", "UPDATED", "STORE_ASSIGNED", "STORE_UNASSIGNED"]),
  before_state: model.json().nullable(),
  after_state: model.json(),
});
