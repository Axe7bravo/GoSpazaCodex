import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
export const statuses = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "REJECTED"] as const;
export const documentTypes = ["BUSINESS_REGISTRATION", "REPRESENTATIVE_ID", "LIQUOR_DOCUMENT", "OTHER"] as const;
const text = (max: number) => z.string().trim().max(max);
export const applicationFields = z.object({
  legal_name: text(200), trading_name: text(200), contact_name: text(150),
  contact_email: z.union([z.literal(""), z.string().trim().email().max(254)]),
  contact_phone: text(40), address_line_1: text(200), address_line_2: text(200),
  city: text(100), province: text(100), postal_code: text(20),
  country_code: z.string().regex(/^[A-Z]{2}$/), intends_to_sell_alcohol: z.boolean(), notes: text(2000),
}).strict();
export type ApplicationFields = z.infer<typeof applicationFields>;
export const patchSchema = applicationFields.partial().strict();
export const listSchema = z.object({
  status: z.enum(statuses).optional(), q: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid application input. Check field values and lengths.");
  return result.data;
}
export function validateSubmission(data: ApplicationFields) {
  parse(applicationFields, data);
  const required = [data.legal_name, data.trading_name, data.contact_name, data.contact_email,
    data.contact_phone, data.address_line_1, data.city, data.province, data.postal_code, data.country_code];
  if (required.some((field) => !field.trim())) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Complete all required application fields before submitting.");
}
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export function validateDocument(input: unknown) {
  const data = parse(z.object({ document_type: z.enum(documentTypes), display_name: z.string().min(1).max(200),
    mime_type: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    content: z.string().min(1).max(4 * Math.ceil(MAX_FILE_BYTES / 3)),
  }).strict(), input);
  if ((data.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.content))) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid file encoding.");
  }
  const bytes = Buffer.from(data.content, "base64");
  if (bytes.toString("base64") !== data.content) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid file encoding.");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Files must be at most 10 MB.");
  const pdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-" && bytes.subarray(-1024).includes(Buffer.from("%%EOF"));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(-8,-4).toString("ascii") === "IEND";
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  const detected = pdf ? "application/pdf" : png ? "image/png" : jpeg ? "image/jpeg" : null;
  if (!detected || data.mime_type !== detected) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Upload a PDF, JPEG, or PNG whose contents match its type.");
  const displayName = Array.from(data.display_name.split(/[\\/]/).at(-1)!).filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").trim();
  if (!displayName) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid display name.");
  return { bytes, content: data.content, mime_type: detected, document_type: data.document_type, display_name: displayName };
}
