import type { NotificationOperation } from "@gospaza/contracts";
export type NoticeSurface = "customer" | "merchant" | "driver";
export function noticeHref(path: string | null, surface: NoticeSurface): string | null {
  if (!path || path.includes("\\") || /[\r\n]/.test(path) || path.includes("\0")) return null;
  const resource = "[A-Za-z0-9][A-Za-z0-9_.:%-]*";
  const allowed = surface === "customer" ? new RegExp("^/orders/" + resource + "$")
    : surface === "merchant" ? new RegExp("^/merchant/(orders|picking|settlements)/" + resource + "$") : /^\/$|^\/driver\/earnings$/;
  return allowed.test(path) ? path : null;
}
export function noticeTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" }).format(date) : "Time unavailable";
}
export function operationStatus(row: Pick<NotificationOperation, "state" | "channel">) {
  if (row.state === "ACCEPTED") return row.channel === "IN_APP" ? "Published in app" : "Accepted by provider";
  return ({ PENDING: "Queued", IN_PROGRESS: "Processing", RETRYABLE_FAILURE: "Retry scheduled", TERMINAL_FAILURE: "Known delivery failure",
    ATTENTION_REQUIRED: "Delivery outcome requires attention", SUPPRESSED: "Suppressed" } as Record<string, string>)[row.state] ?? "Status unavailable";
}
export function notificationCode(code: string) {
  return ({ NO_RECIPIENT: "No valid contact destination", STALE: "Message is no longer current", AUTHORIZATION_CHANGED: "Recipient access or contact changed",
    POLICY: "Suppressed by notification policy", CONFIGURATION: "Transport configuration needs review", CONFIGURATION_CHANGED: "Frozen transport configuration changed",
    ENVELOPE_INVALID: "Frozen message requires review", LOST_SEND_RESULT: "Provider send outcome could not be confirmed", REPLAY_OR_ATTEMPT_LIMIT: "Automatic recovery limit reached",
    PROVIDER_ACCEPTED: "Provider acceptance recorded", CREATED: "Notification recorded", PROVIDER_REJECTED: "Provider rejected the request",
    NETWORK_UNCERTAIN: "Provider send outcome could not be confirmed", NATIVE_RESULT_UNCERTAIN: "Provider send outcome could not be confirmed",
    CLAIM_NOT_DISPATCHED: "Interrupted before provider dispatch", PROVIDER_BUSY: "Provider temporarily unavailable" } as Record<string, string>)[code] ?? "Review the safe operational status";
}
