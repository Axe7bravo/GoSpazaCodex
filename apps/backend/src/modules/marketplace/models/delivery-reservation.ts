import { model } from "@medusajs/framework/utils";

// M9-C owns lifecycle/capacity operations under customer and slot locks.
export default model.define("delivery_reservation", {
  id: model.id({ prefix: "dhold" }).primaryKey(),
  cart_context_id: model.text(),
  merchant_store_id: model.text(), // Composite-FK consistency, not independent authority.
  delivery_option_id: model.text(),
  store_service_zone_id: model.text(),
  delivery_slot_id: model.text(),
  status: model.enum(["HELD", "PAYMENT_PENDING", "RELEASED", "EXPIRED", "COMMITTED"]).default("HELD"),
  expires_at: model.dateTime(),
  payment_deadline: model.dateTime().nullable(),
  payment_accepted_at: model.dateTime().nullable(),
  medusa_order_id: model.text().nullable(),
  released_at: model.dateTime().nullable(),
  release_reason: model.text().nullable(),
  configuration_revision: model.number(),
  selection_revision: model.number().default(1),
  quoted_fee_minor: model.number(),
  currency_code: model.enum(["zar"]).default("zar"),
  medusa_customer_address_id: model.text().nullable(),
  latitude: model.float().nullable(),
  longitude: model.float().nullable(),
}).indexes([
  { on: ["id", "cart_context_id"], unique: true },
  // Migration20261004100000 owns delivery_one_held_per_cart: unique on
  // cart_context_id WHERE status IN ('HELD', 'PAYMENT_PENDING'). DML 2.18
  // does not support $in and adds soft-delete scoping to SQL predicates.
  // Keep this exact all-row invariant in the migration; do not narrow it here.
  { on: ["delivery_slot_id", "status", "expires_at"] },
  { on: ["status", "expires_at"] },
]);
