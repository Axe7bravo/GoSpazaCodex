import { model } from "@medusajs/framework/utils";

export default model.define("pick_event", {
  id: model.id({ prefix: "pevt" }).primaryKey(),
  pick_session_id: model.text(),
  revision: model.number(),
  previous_revision: model.number(),
  action: model.enum(["CLAIM", "LINE", "REASSIGN", "COMPLETE"]),
  acting_member_id: model.text(),
  medusa_order_line_id: model.text().nullable(),
  request: model.json(),
  before: model.json(),
  after: model.json(),
  occurred_at: model.dateTime(),
}).indexes([{ on: ["pick_session_id", "revision"], unique: true }]);
