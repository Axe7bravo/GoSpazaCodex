import { model } from "@medusajs/framework/utils";

export default model.define("delivery_slot", {
  id: model.id({ prefix: "dslot" }).primaryKey(),
  merchant_store_id: model.text(),
  start_at: model.dateTime(),
  end_at: model.dateTime(),
  booking_cutoff_at: model.dateTime(),
  capacity: model.number(),
  enabled: model.boolean().default(true),
  revision: model.number().default(1),
}).indexes([
  { on: ["id", "merchant_store_id"], unique: true },
  { on: ["merchant_store_id", "start_at", "end_at"], unique: true },
  { on: ["merchant_store_id", "enabled", "start_at"] },
]);
