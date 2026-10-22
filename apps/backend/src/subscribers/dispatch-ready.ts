import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { DispatchOrchestrator } from "../lib/dispatch-orchestrator";
import { resourceId } from "../modules/marketplace/team-policy";
export default async function dispatchReady({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  if (process.env.DISPATCH_WORKER_ENABLED !== "true") return;
  const id = resourceId.safeParse(data?.id);
  if (!id.success) return;
  await new DispatchOrchestrator(container).ensure(id.data);
}
export const config: SubscriberConfig = {
  event: "gospaza.picking.completed", context: { subscriberId: "gospaza-dispatch-ready" },
};
