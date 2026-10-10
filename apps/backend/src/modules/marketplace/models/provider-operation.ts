import { model } from "@medusajs/framework/utils";

// Coordination and immutable external identity only. Medusa owns financial records.
export default model.define("provider_operation", {
  id: model.id({ prefix: "yop" }).primaryKey(),
  checkout_attempt_id: model.text().unique(),
  payment_collection_id: model.text().nullable(),
  amount_minor: model.number(),
  currency_code: model.enum(["zar"]).default("zar"),
  mode: model.enum(["test", "live"]),
  account_fingerprint: model.text(),
  idempotency_key: model.text().unique(),
  request_json: model.text(),
  request_fingerprint: model.text(),
  state: model.enum(["prepared", "sending", "uncertain", "created", "mismatch"]).default("prepared"),
  checkout_id: model.text().nullable(),
  checkout_receipt: model.json().nullable(),
  // Written only by verified/correlated reconciliation.
  verified_payment: model.json().nullable(),
  reconciliation_pending: model.boolean().default(false),
  terminal_refunded: model.boolean().default(false),
  session_token: model.text().nullable(),
  replay_allowed: model.boolean().default(false),
  canonical_session_id: model.text().nullable(),
  financial_session_id: model.text().nullable(),
}).indexes([
  { on: ["checkout_id"], unique: true, where: { checkout_id: { $ne: null } } },
  { on: ["payment_collection_id"], unique: true, where: { payment_collection_id: { $ne: null } } },
]);
