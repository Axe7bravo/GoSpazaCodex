import { model } from "@medusajs/framework/utils";
export default model.define("restricted_evidence", {
  id: model.id({ prefix: "revd" }).primaryKey(), merchant_id: model.text(), merchant_store_id: model.text(),
  storage_key: model.text().unique(), display_name: model.text(), mime_type: model.text(), size_bytes: model.number(),
});
