import { z } from "@medusajs/framework/zod";
import { discoveryInput } from "../../lib/discovery-service";
import { schedulingId } from "./scheduling-policy";

export const deliveryReadInput = z.object({ cart_id: schedulingId.optional() }).strict();
export const deliveryLocationInput = deliveryReadInput.extend({ location: discoveryInput }).strict();
export const deliverySelectionInput = deliveryLocationInput.extend({
  option_id: schedulingId,
  expected_option_revision: z.number().int().min(1).max(2147483647),
  slot_id: schedulingId.optional(),
  expected_revision: z.number().int().min(0).max(2147483646),
}).strict();
export const deliveryReleaseInput = deliveryReadInput.extend({
  reservation_id: schedulingId.optional(),
  expected_revision: z.number().int().min(0).max(2147483646),
}).strict();
