import { z } from "@medusajs/framework/zod";
import { identifier } from "../modules/yoco/validation";

// Pinned 2.18 persists Refund.metadata but omits it from RefundDTO. Validate
// the runtime projection instead of asserting that the missing field exists.
const refundCorrelation = z.object({ metadata: z.object({
  gospazaRefundOperationId: identifier,
  gospazaProviderRefundId: identifier,
}) });
export function nativeRefundCorrelation(value: unknown) {
  const parsed = refundCorrelation.safeParse(value);
  return parsed.success ? parsed.data.metadata : null;
}
