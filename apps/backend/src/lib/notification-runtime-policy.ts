import { z } from "@medusajs/framework/zod";
import type { NotificationTransportDisposition } from "@gospaza/contracts";
import { id } from "./notification-policy";

const cursorShape = z.object({ at: z.string().datetime({ offset: true }), id }).strict();
export function decodeNoticeCursor(value: string) {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid notification cursor.");
  return cursorShape.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}
export function encodeNoticeCursor(at: Date | string, value: string) {
  return Buffer.from(JSON.stringify(cursorShape.parse({ at: new Date(at).toISOString(), id: value }))).toString("base64url");
}
export const notificationPage = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).transform((value, context) => {
    try { return decodeNoticeCursor(value); }
    catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid notification cursor." }); return z.NEVER; }
  }).optional() }).strict();
// Evidence is append-only. A late weak observation never clears a permanent
// failure or delivery evidence; delivery is not human read acknowledgement.
export const evidencePriority: readonly NotificationTransportDisposition[] = ["accepted", "delivery_delayed", "sent", "delivered", "failed", "bounced", "complained"];
export function transportDisposition(events: readonly string[], accepted: boolean): NotificationTransportDisposition | null {
  return [...evidencePriority].reverse().find(event => events.includes(event)) ?? (accepted ? "accepted" : null);
}
export function notificationOpsAllowed(user: string, env: NodeJS.ProcessEnv = process.env) {
  return !!user && (env.NOTIFICATION_OPERATIONS_VIEW_USER_IDS ?? "").split(",").map(value => value.trim()).includes(user);
}
export const runtimeBatch = 20;
export const notificationWorkers = ["delivery", "repair"] as const;
export function workerEnabled(name: typeof notificationWorkers[number], env: NodeJS.ProcessEnv = process.env) {
  return env.APP_ENV !== "test" && env["NOTIFICATION_" + name.toUpperCase() + "_WORKER_ENABLED"] === "true";
}
