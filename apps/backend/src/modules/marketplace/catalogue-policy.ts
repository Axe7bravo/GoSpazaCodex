import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
export const variantInput = z.object({
  id: z.string().max(100).optional(),
  title: z.string().trim().min(1).max(100),
  sku: z.string().trim().max(100).default(""),
  price_minor: z.number().int().min(0).max(1000000000),
  stocked_quantity: z.number().int().min(0).max(1000000),
}).strict();
export const productInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(""),
  status: z.enum(["draft", "published"]),
  requires_age_verification: z.boolean(),
  variants: z.array(variantInput).min(1).max(30),
}).strict().refine((value) => new Set(value.variants.map((v) => v.title)).size === value.variants.length, "Variant names must be unique.");
export type CatalogueInput = z.infer<typeof productInput>;
export const catalogueQuery = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["draft", "published"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export const stockInput = z.object({ stocked_quantity: z.number().int().min(0).max(1000000) }).strict();
export function catalogueParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid catalogue input.");
  return result.data;
}
// Medusa v2 uses major units. API/storage policy at our boundary remains integer cents.
export function nativePrice(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid minor-unit amount.");
  return (BigInt(cents) / 100n).toString() + "." + (BigInt(cents) % 100n).toString().padStart(2, "0");
}
export function minorPrice(amount: string | number): number {
  const text = String(amount);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Unsupported native price precision.");
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Native price exceeds safe bounds.");
  return Number(cents);
}
export function validateCatalogueImage(input: unknown) {
  const data = catalogueParse(z.object({
    mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    content: z.string().min(1).max(6990508),
  }).strict(), input);
  const bytes = Buffer.from(data.content, "base64");
  const bad = () => new MedusaError(MedusaError.Types.INVALID_DATA, "Use a valid JPEG, PNG or WebP image up to 5 MB.");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== data.content) throw bad();
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR";
  const jpeg = bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const webp = bytes.length >= 20 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!(data.mime_type === "image/png" ? png : data.mime_type === "image/jpeg" ? jpeg : webp)) throw bad();
  return { ...data, bytes };
}
