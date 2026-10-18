import { model } from "@medusajs/framework/utils";

export default model.define("shortage_resolution", {
  id: model.id({ prefix: "shr" }).primaryKey(),
  order_operation_id: model.text(),
  pick_session_id: model.text(),
  pick_line_id: model.text(),
  preference_id: model.text(),
  status: model.enum(["CUSTOMER_DECISION_REQUIRED", "RESOLVED_OMITTED"]),
  revision: model.number().default(1),
  evidence: model.json(),
  decision_customer_id: model.text().nullable(),
  resolved_at: model.dateTime().nullable(),
  invalidated_at: model.dateTime().nullable(),
  financial_review_required: model.boolean().default(false),
}).indexes([{ on: ["pick_line_id"], unique: true, where: { invalidated_at: null } }]);
