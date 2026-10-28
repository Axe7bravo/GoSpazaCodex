import { model } from "@medusajs/framework/utils";
export default model.define("restriction_review", {
  id: model.id({ prefix: "rrev" }).primaryKey(), product_profile_id: model.text(), identity_fingerprint: model.text(),
  revision: model.number(),
  restriction: model.enum(["NONE", "ALCOHOL"]), alcohol_class: model.enum(["WINE", "BEER", "SPIRITS", "OTHER"]).nullable(),
  reviewer_id: model.text(), reason: model.text(),
});
