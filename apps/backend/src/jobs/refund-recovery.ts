import type { MedusaContainer } from "@medusajs/framework/types";
import { RefundService } from "../lib/refund-service";
export default async function refundRecovery(container: MedusaContainer) {
  // Explicit opt-in; never inherits the checkout worker's enablement.
  if (process.env.REFUND_RECOVERY_WORKER_ENABLED !== "true") return;
  await new RefundService(container).repair(20);
}
export const config = { name: "gospaza-refund-recovery", schedule: "*/1 * * * *" };
