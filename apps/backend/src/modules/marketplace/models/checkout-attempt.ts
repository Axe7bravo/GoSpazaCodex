import { model } from "@medusajs/framework/utils";

// Immutable commercial snapshot; native Cart/Payment remain authoritative.
export default model.define("checkout_attempt", {
  id: model.id({ prefix: "chk" }).primaryKey(),
  cart_context_id: model.text(),
  medusa_cart_id: model.text(),
  reservation_id: model.text(),
  checkout_revision: model.text(),
  snapshot: model.json(),
  state: model.enum(["CONFIRMED", "PAYMENT_PENDING", "ABANDONED", "EXPIRED", "RECOVERY_REQUIRED", "COMPLETED", "FAILED"]).default("CONFIRMED"),
  expires_at: model.dateTime(),
  payment_deadline: model.dateTime().nullable(),
  payment_accepted_at: model.dateTime().nullable(),
  closed_at: model.dateTime().nullable(),
}).indexes([
  { on: ["medusa_cart_id"], unique: true, where: { closed_at: null } },
  { on: ["cart_context_id"], unique: true, where: { closed_at: null } },
]);
