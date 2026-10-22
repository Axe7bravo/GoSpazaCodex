import { model } from "@medusajs/framework/utils";
export default model.define("driver_availability", {
  id: model.id({ prefix: "dav" }).primaryKey(), driver_profile_id: model.text().unique(), intent: model.enum(["OFFLINE","ONLINE"]).default("OFFLINE"), revision: model.number().default(1), generation: model.text().nullable(), available_since: model.dateTime().nullable(), profile_revision: model.number().nullable(), affiliation_id: model.text().nullable(), affiliation_revision: model.number().nullable(),
});
