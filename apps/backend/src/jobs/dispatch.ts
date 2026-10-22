import type { MedusaContainer } from "@medusajs/framework/types";
import { DispatchOrchestrator } from "../lib/dispatch-orchestrator";
export default async function dispatch(container: MedusaContainer) {
  if (process.env.DISPATCH_WORKER_ENABLED !== "true") return;
  await new DispatchOrchestrator(container).runBatch();
}
export const config = { name: "gospaza-dispatch", schedule: "*/5 * * * * *" };
