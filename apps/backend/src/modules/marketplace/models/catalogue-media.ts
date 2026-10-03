import { model } from "@medusajs/framework/utils";
// Provider references for cleanup; Product owns image relationships.
export default model.define("catalogue_media", {
  id: model.id({ prefix: "cmedia" }).primaryKey(),
  profile_id: model.text(),
  file_key: model.text().unique(),
  public_url: model.text().unique(),
  removal_pending: model.boolean().default(false),
});
