import { model } from "@medusajs/framework/utils";
export default model.define("merchant_application_review", {
  id: model.id({ prefix: "mrev" }).primaryKey(), application_id: model.text(),
  action: model.enum(["REVIEW_STARTED", "INFORMATION_REQUESTED", "RESUBMITTED", "REJECTED", "APPROVED"]),
  platform_user_id: model.text().nullable(), reason: model.text().default(""), from_status: model.text(), to_status: model.text(),
});
