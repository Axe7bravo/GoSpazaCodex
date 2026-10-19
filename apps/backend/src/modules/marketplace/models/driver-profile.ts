import { model } from "@medusajs/framework/utils";
import { driverStatuses } from "../driver-policy";
export default model.define("driver_profile", {
  id: model.id({ prefix: "drv" }).primaryKey(), auth_identity_id: model.text().unique(),
  display_name: model.text().default(""), contact_phone: model.text().default(""),
  status: model.enum([...driverStatuses]).default("INCOMPLETE"), revision: model.number().default(1),
  submitted_at: model.dateTime().nullable(), reviewed_at: model.dateTime().nullable(), reviewed_by: model.text().nullable(),
});
