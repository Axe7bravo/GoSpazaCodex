import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";
import { orderParse } from "./order-operation-policy";

const revision = z.number().int().min(1).max(2147483646);
export const pickingListInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  status: z.enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED"]).optional(),
}).strict();
export const pickLineInput = z.object({
  expected_revision: revision,
  picked_quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  shortage_recorded: z.boolean(),
}).strict();
export const pickReassignInput = z.object({ expected_revision: revision, target_member_id: resourceId }).strict();
export const pickCompleteInput = z.object({ expected_revision: revision, confirmed: z.literal(true) }).strict();
export const pickClaimInput = z.object({}).strict();
export type PickingCommand =
  | { action: "CLAIM"; input: Record<string, never> }
  | { action: "LINE"; line_id: string; input: z.infer<typeof pickLineInput> }
  | { action: "REASSIGN"; input: z.infer<typeof pickReassignInput> }
  | { action: "COMPLETE"; input: z.infer<typeof pickCompleteInput> };
export type PickingAction = PickingCommand["action"];
export function pickingCommand(action: PickingAction, value: unknown, lineId?: string): PickingCommand {
  switch (action) {
    case "CLAIM": return { action, input: orderParse(pickClaimInput, value) };
    case "LINE": return { action, line_id: orderParse(resourceId, lineId), input: orderParse(pickLineInput, value) };
    case "REASSIGN": return { action, input: orderParse(pickReassignInput, value) };
    case "COMPLETE": return { action, input: orderParse(pickCompleteInput, value) };
  }
}
export const pickingConflict = () => new MedusaError(MedusaError.Types.CONFLICT, "Picking changed or is not eligible. Refresh picking.", "PICKING_CONFLICT");
export const pickingMissing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Picking order or line not found.");
export function validatePicked(ordered: number, picked: number, shortage: boolean) {
  if (!Number.isSafeInteger(ordered) || ordered <= 0 || !Number.isSafeInteger(picked) || picked < 0
    || picked > ordered || (shortage && picked === ordered)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid picked quantity or shortage.");
  }
}
export function pickingFingerprint(lines: { id: string; variant_id: string | null; quantity: number }[]) {
  if (!lines.length || new Set(lines.map((line) => line.id)).size !== lines.length) throw pickingConflict();
  return createHash("sha256").update(JSON.stringify([...lines].sort((a, b) => a.id.localeCompare(b.id))
    .map((line) => [line.id, line.variant_id, line.quantity]))).digest("hex");
}
