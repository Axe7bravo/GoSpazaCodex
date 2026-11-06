import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { NotificationMappings } from "../lib/notification-mappings";
import { id } from "../lib/notification-policy";

export function notificationSignal(event: { name: string; data: unknown }) {
  if (!["order.placed", "gospaza.picking.completed", "gospaza.delivery-completed"].includes(event.name) || !event.data || typeof event.data !== "object") return null;
  const key = event.name === "gospaza.delivery-completed" ? "order_id" : "id";
  const source = id.safeParse((event.data as Record<string, unknown>)[key]);
  return source.success ? { id: source.data, delivered: event.name === "gospaza.delivery-completed" } : null;
}
export default async function notificationDiscovery({ event, container }: SubscriberArgs<{ id?: unknown; order_id?: unknown }>) {
  const source = notificationSignal(event); if (!source) return;
  const mappings = new NotificationMappings(container);
  if (source.delivered) await mappings.deliveredOrder(source.id);
  else await mappings.discover("ORDER", source.id);
}
export const config: SubscriberConfig = { event: ["order.placed", "gospaza.picking.completed", "gospaza.delivery-completed"],
  context: { subscriberId: "gospaza-notification-discovery" } };
