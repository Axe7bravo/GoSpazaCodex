import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { resourceId } from "../modules/marketplace/team-policy";
import { OrderOperationsService } from "../lib/order-operations-service";

export default async function orderPlaced({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  const id = resourceId.safeParse(data?.id);
  if (!id.success) return;
  // Native publication may precede the M10 terminal commit. The repair job and
  // authorized reads use the same ensure after that durable evidence appears.
  await new OrderOperationsService(container).ensure(id.data);
}
export const config: SubscriberConfig = { event: "order.placed", context: { subscriberId: "gospaza-order-operation" } };
