import { model } from "@medusajs/framework/utils";
import Document from "./document";
export const APPLICATION_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "REJECTED"] as const;
const Application = model.define("merchant_application", {
  id: model.id({ prefix: "mapp" }).primaryKey(),
  applicant_identity_id: model.text().unique(),
  legal_name: model.text().default(""), trading_name: model.text().default(""),
  contact_name: model.text().default(""), contact_email: model.text().default(""), contact_phone: model.text().default(""),
  address_line_1: model.text().default(""), address_line_2: model.text().default(""),
  city: model.text().default(""), province: model.text().default(""), postal_code: model.text().default(""), country_code: model.text().default("ZA"),
  intends_to_sell_alcohol: model.boolean().default(false), notes: model.text().default(""),
  status: model.enum([...APPLICATION_STATUSES]).default("DRAFT"), submitted_at: model.dateTime().nullable(),
  documents: model.hasMany(() => Document, { mappedBy: "application" }),
});
export default Application;
