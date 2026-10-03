import { model } from "@medusajs/framework/utils";

export default model.define("scheduling_event", {
  id: model.id({ prefix: "schevt" }).primaryKey(),
  platform_user_id: model.text(),
  target_id: model.text(),
  action: model.text(),
  reason: model.text(),
  before_state: model.json().nullable(),
  after_state: model.json(),
});
