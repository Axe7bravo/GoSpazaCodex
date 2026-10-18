import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";

export const shortageConflict = () => new MedusaError(MedusaError.Types.CONFLICT,
  "Shortage resolution changed or is not eligible. Refresh the order.", "SHORTAGE_CONFLICT");
const revision = z.number().int().min(0).max(2147483646);
export const preferenceInput = z.object({
  preference: z.enum(["CONTACT_ME", "NO_SUBSTITUTION"]), expected_revision: revision,
}).strict();
export const omissionInput = z.object({ expected_revision: revision.min(1), confirmed: z.literal(true) }).strict();
export const shortageAdmissionInput = z.object({ expected_revision: revision.min(1) }).strict();
export const shortageEvidence = z.object({
  ordered: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  picked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  missing: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  native_order_id: z.string(), native_line_id: z.string(), checkout_completion_id: z.string(),
  source_lines_fingerprint: z.string(),
  preference: z.enum(["CONTACT_ME", "NO_SUBSTITUTION"]), preference_revision: z.number().int().positive(),
}).strict().refine((e) => e.picked < e.ordered && e.missing === e.ordered - e.picked);

export function accounted(ordered: number, picked: number, omitted: number): boolean {
  return [ordered, picked, omitted].every(Number.isSafeInteger)
    && ordered > 0 && picked >= 0 && omitted >= 0 && picked <= ordered && omitted === ordered - picked;
}
