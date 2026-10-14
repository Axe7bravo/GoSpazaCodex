import { model } from "@medusajs/framework/utils";

export default model.define("pick_session", {
  id: model.id({ prefix: "pick" }).primaryKey(),
  order_operation_id: model.text().unique(),
  assigned_member_id: model.text(),
  status: model.enum(["IN_PROGRESS", "COMPLETED"]).default("IN_PROGRESS"),
  revision: model.number().default(1),
  source_lines_fingerprint: model.text(),
  started_at: model.dateTime(),
  completed_at: model.dateTime().nullable(),
});
