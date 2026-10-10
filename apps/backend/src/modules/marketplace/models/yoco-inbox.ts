import { model } from "@medusajs/framework/utils";

export default model.define("yoco_inbox", {
  id: model.id({ prefix: "yin" }).primaryKey(),
  event_id: model.text().unique(),
  body_fingerprint: model.text(),
  event: model.json(),
  state: model.enum(["RECEIVED", "APPLIED", "REJECTED"]).default("RECEIVED"),
  rejection_code: model.text().nullable(),
});
