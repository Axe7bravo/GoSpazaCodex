import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// Native records contain customer destinations/content, not the role-safe M22
// inbox projection. Native admin authentication alone cannot authorize them.
export const nativeNotificationMatcher = /^\/admin\/notifications(?:\/.*)?$/i;
export function blockNativeNotifications(_request: MedusaRequest, response: MedusaResponse) {
  response.setHeader("Cache-Control", "private, no-store");
  response.status(404).json({ message: "Notification information is unavailable." });
}
