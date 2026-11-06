import type { ActorNotice, NoticePage, NotificationOperationPage, NotificationHealth } from "@gospaza/contracts";
import { driverTransport } from "./drivers";
import { AuthError } from "./auth";
function notificationRequest(baseUrl: string, fetcher: typeof fetch, publishableKey = "") {
  const request = driverTransport(baseUrl, fetcher, publishableKey ? { "x-publishable-api-key": publishableKey } : {});
  return async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    try { return await request<T>(path, method, body); }
    catch (error) {
      if (error instanceof AuthError) throw new AuthError(error.kind, "Notification information is unavailable. Refresh or sign in again.", error.status);
      throw error;
    }
  };
}
export function createNotificationClient(baseUrl: string, actor: "customer" | "merchant" | "driver" | "user", fetcher: typeof fetch = fetch, publishableKey = "") {
  const request = notificationRequest(baseUrl, fetcher, actor === "customer" ? publishableKey : "");
  const path = { customer: "/store/gospaza/notifications", merchant: "/merchant/notifications", driver: "/driver/notifications", user: "/admin/gospaza/notifications" }[actor];
  return {
    list: (cursor?: string) => request<NoticePage>(path + "?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")),
    detail: (id: string) => request<ActorNotice>(path + "/" + encodeURIComponent(id)),
    markRead: (id: string) => request<ActorNotice>(path + "/" + encodeURIComponent(id) + "/read", "POST", {}),
  };
}
export function createNotificationOperationsClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  const request = notificationRequest(baseUrl, fetcher), path = "/admin/gospaza/notification-operations";
  return { list: (cursor?: string) => request<NotificationOperationPage>(path + "?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")),
    health: () => request<NotificationHealth>(path + "/health") };
}
