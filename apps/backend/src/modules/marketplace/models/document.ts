import { model } from "@medusajs/framework/utils";
import Application from "./application";
export const DOCUMENT_TYPES = ["BUSINESS_REGISTRATION", "REPRESENTATIVE_ID", "LIQUOR_DOCUMENT", "OTHER"] as const;
const Document = model.define("merchant_application_document", {
  id: model.id({ prefix: "madoc" }).primaryKey(),
  application: model.belongsTo(() => Application, { mappedBy: "documents" }),
  document_type: model.enum([...DOCUMENT_TYPES]), display_name: model.text(), storage_key: model.text().unique(),
  mime_type: model.text(), size_bytes: model.number(), removal_pending: model.boolean().default(false),
});
export default Document;
