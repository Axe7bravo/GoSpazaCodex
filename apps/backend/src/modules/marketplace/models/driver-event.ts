import { model } from "@medusajs/framework/utils";
export default model.define("driver_event", {
  id: model.id({ prefix: "devt" }).primaryKey(), driver_profile_id: model.text(), affiliation_id: model.text().nullable(),
  action: model.text(), actor_type: model.enum(["driver", "merchant", "user"]), actor_id: model.text(),
  merchant_id: model.text().nullable(), merchant_store_id: model.text().nullable(),
  from_status: model.text().nullable(), to_status: model.text(), previous_revision: model.number(), revision: model.number(),
  evidence: model.json(), request_fingerprint: model.text(), reason: model.text(), occurred_at: model.dateTime(),
}).indexes([{ name: "driver_event_profile_revision", on: ["driver_profile_id", "revision"], unique: true }]);
