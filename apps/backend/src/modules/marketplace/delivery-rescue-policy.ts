import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { resourceId } from "./team-policy";
export const rescueInput = z.object({ request_id: resourceId,
  expected_revision: z.number().int().positive().max(2147483646),
  expected_generation: z.number().int().positive().max(2147483646),
  expected_status: z.literal("ATTENTION_REQUIRED"), reason_code: z.literal("RETRY_DISPATCH_SEARCH"), confirmed: z.literal(true),
}).strict();
export function rescueConflict(code = "RESCUE_NOT_ELIGIBLE"): never {
  throw new MedusaError(MedusaError.Types.CONFLICT, "Delivery state changed. Reopen the current delivery before another action.", code);
}
export function nextRescueGeneration(current: number, maximum: number) {
  if (!Number.isSafeInteger(current) || current < 1 || current >= 2147483647 || maximum !== current) return rescueConflict("RESCUE_HISTORY_UNPROVEN");
  return current + 1;
}
