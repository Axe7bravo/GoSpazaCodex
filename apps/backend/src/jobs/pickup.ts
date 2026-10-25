import type { MedusaContainer } from "@medusajs/framework/types";
import { PickupService } from "../lib/pickup-service";
export default async function pickup(container: MedusaContainer) {
  if (process.env.PICKUP_WORKER_ENABLED !== "true") return;
  await new PickupService(container).runBatch();
}
export const config = { name: "gospaza-pickup", schedule: "*/10 * * * * *" };
