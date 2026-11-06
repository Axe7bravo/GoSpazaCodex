import type { MedusaContainer } from "@medusajs/framework/types";
import { NotificationRepair } from "../lib/notification-repair";
import { workerEnabled } from "../lib/notification-runtime-policy";
export default async function notificationRepair(container: MedusaContainer) {
  if (!workerEnabled("repair")) return;
  await new NotificationRepair(container).cycle();
}
export const config = { name: "gospaza-notification-repair", schedule: "*/1 * * * *" };
