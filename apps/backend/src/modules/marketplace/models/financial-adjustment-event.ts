import { model } from "@medusajs/framework/utils";
export default model.define("financial_adjustment_event", {
  id: model.id({ prefix: "faevt" }).primaryKey(), adjustment_id: model.text(),
  action: model.text(), actor_type: model.enum(["system", "user"]), actor_id: model.text().nullable(),
  revision: model.number(), evidence: model.json(), occurred_at: model.dateTime(),
}).indexes([{ on: ["adjustment_id", "revision"], unique: true }]);
