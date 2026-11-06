import type { MedusaContainer } from "@medusajs/framework/types";
import { NotificationRuntime } from "../lib/notification-runtime";
import { workerEnabled } from "../lib/notification-runtime-policy";
export default async function notificationDelivery(container: MedusaContainer) {
  if (!workerEnabled("delivery")) return;
  await new NotificationRuntime(container).deliveryCycle();
}
export const config = { name: "gospaza-notification-delivery", schedule: "*/1 * * * *" };
