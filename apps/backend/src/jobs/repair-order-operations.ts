import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { OrderOperationsService } from "../lib/order-operations-service";

export default async function repairOrderOperations(container: MedusaContainer) {
  const result = await new OrderOperationsService(container).repairBatch();
  if (result.deferred) container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
    .warn("Order operation repair deferred " + result.deferred + " candidate(s); authoritative receipts retained.");
}
export const config = { name: "gospaza-repair-order-operations", schedule: "*/1 * * * *" };
