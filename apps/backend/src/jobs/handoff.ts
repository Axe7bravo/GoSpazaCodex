import type { MedusaContainer } from "@medusajs/framework/types";
import { HandoffService } from "../lib/handoff-service";
export default async function handoff(container: MedusaContainer) {
  if (process.env.HANDOFF_WORKER_ENABLED === "true") await new HandoffService(container).runBatch();
}
export const config = { name: "gospaza-handoff", schedule: "*/10 * * * * *" };
