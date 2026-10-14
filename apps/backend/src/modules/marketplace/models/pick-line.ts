import { model } from "@medusajs/framework/utils";

export default model.define("pick_line", {
  id: model.id({ prefix: "pline" }).primaryKey(),
  pick_session_id: model.text(),
  medusa_order_line_id: model.text(),
  // Native-compatible exact numeric storage; migration checks whole safe units.
  // These are physical units, never money. Native quantity remains authoritative.
  ordered_quantity_at_start: model.bigNumber(),
  picked_quantity: model.bigNumber().default(0),
  shortage_recorded: model.boolean().default(false),
}).indexes([{ on: ["pick_session_id", "medusa_order_line_id"], unique: true }]);
