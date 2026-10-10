import { model } from "@medusajs/framework/utils";

// No native-session FK: history must survive Medusa's failed-initiation cleanup.
export default model.define("provider_session", {
  id: model.id({ prefix: "yps" }).primaryKey(),
  operation_id: model.text(),
  native_session_id: model.text().unique(),
  payment_collection_id: model.text(),
});
