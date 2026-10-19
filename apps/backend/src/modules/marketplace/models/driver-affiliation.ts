import { model } from "@medusajs/framework/utils";
import { affiliationStatuses } from "../driver-policy";
// Multi-status partial uniqueness and composite tenancy FK are migration-owned.
export default model.define("driver_affiliation", {
  id: model.id({ prefix: "daff" }).primaryKey(), driver_profile_id: model.text(),
  kind: model.enum(["PLATFORM", "MERCHANT"]), status: model.enum([...affiliationStatuses]), revision: model.number().default(1),
  merchant_id: model.text().nullable(), merchant_store_id: model.text().nullable(),
  endorsed_by: model.text().nullable(), activated_by: model.text().nullable(),
});
