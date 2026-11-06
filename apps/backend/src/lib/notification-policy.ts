import { createHash } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { productionCatalogue, renderProduction } from "./notification-catalogue";

export const limits = { title: 160, subject: 200, body: 8000, html: 24000, path: 240,
  destination: 254, template: 80, providerId: 128, error: 120 } as const;
export const MAX_ATTEMPTS = 4;
export const LEASE_MS = 90000;
export const HTTP_MS = 15000;
export const REPLAY_MS = 23 * 60 * 60 * 1000; // margin inside Resend's 24h retention
export const RETRY_MS = [60000, 300000, 1800000] as const;
export const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const actor = z.object({ type: z.enum(["customer", "merchant", "driver", "user", "guest"]), id }).strict();
export type Actor = z.infer<typeof actor>;
export type State = "PENDING" | "IN_PROGRESS" | "ACCEPTED" | "RETRYABLE_FAILURE" | "TERMINAL_FAILURE" | "ATTENTION_REQUIRED" | "SUPPRESSED";
export type Classification = "RETRYABLE" | "TERMINAL" | "AMBIGUOUS";
export const suppression = z.enum(["NO_RECIPIENT", "STALE", "POLICY", "AUTHORIZATION_CHANGED"]);
export class NotificationConflict extends Error {
  readonly code = "NOTIFICATION_CONFLICT";
  constructor() { super("Notification evidence conflicts or is unavailable."); }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const providerKey = (logical: string) => "gospaza-m22-" + logical;
export const headerSafe = (value: string) => !value.includes("\0") && !/[\r\n]/.test(value);
export const email = z.string().max(limits.destination).email().refine(v => !Array.from(v).some(c => c.charCodeAt(0) <= 32));
export function destination(value: string | null): string | null {
  const parsed = email.safeParse(value);
  return parsed.success ? parsed.data : null;
}
// Only verified existing role routes. Descriptors cannot carry arbitrary URLs.
export const linkInput = z.object({ route: z.enum(["FOUNDATION_TEST", "CUSTOMER_ORDER", "MERCHANT_ORDER", "MERCHANT_PICKING",
  "MERCHANT_SETTLEMENT", "DRIVER_CURRENT", "DRIVER_EARNINGS", "ADMIN_FINANCIAL", "ADMIN_SETTLEMENT", "ADMIN_DRIVER_FINANCE", "ADMIN_COMMISSION"]), resource: id }).strict();
export type Link = z.infer<typeof linkInput>;
export function deepLink(link: Link | null, appEnv: string | undefined) {
  if (!link) return null;
  const parsed = linkInput.parse(link), resource = encodeURIComponent(parsed.resource);
  if (parsed.route === "FOUNDATION_TEST" && appEnv !== "test") throw new NotificationConflict();
  const paths = { FOUNDATION_TEST: "/orders/" + resource, CUSTOMER_ORDER: "/orders/" + resource,
    MERCHANT_ORDER: "/merchant/orders/" + resource, MERCHANT_PICKING: "/merchant/picking/" + resource,
    MERCHANT_SETTLEMENT: "/merchant/settlements/" + resource, DRIVER_CURRENT: "/", DRIVER_EARNINGS: "/driver/earnings",
    ADMIN_FINANCIAL: "/admin/financial-adjustments", ADMIN_SETTLEMENT: "/admin/settlements/" + resource,
    ADMIN_DRIVER_FINANCE: "/admin/driver-finance", ADMIN_COMMISSION: "/admin/commissions" };
  const path = paths[parsed.route];
  if (path.length > limits.path) throw new NotificationConflict();
  return path;
}
const templateInput = z.object({ detail: z.string().min(1).max(2000) }).strict();
function textRenderer(title: string) {
  return (data: z.infer<typeof templateInput>) => ({ title, subject: title, text: data.detail,
    html: "<p>" + escapeHtml(data.detail) + "</p>" });
}
export const templateRegistry = {
  "test.notification": {
    1: { channels: ["IN_APP", "EMAIL"] as const, input: templateInput, render: textRenderer("GoSpaza foundation notice") },
    2: { channels: ["IN_APP", "EMAIL"] as const, input: templateInput, render: textRenderer("GoSpaza foundation notice version two") },
  },
} as const;
export const createInput = z.object({
  source: z.object({ type: id, id, transition: id, committed_at: z.string().datetime({ offset: true }), evidence: id }).strict(),
  kind: z.enum(["FOUNDATION_TEST", ...new Set(productionCatalogue.map(row => row.kind))] as [string, ...string[]]), recipient: actor, channel: z.enum(["IN_APP", "EMAIL"]),
  destination: z.string().max(limits.destination).nullable(),
  template: z.enum(["test.notification", ...productionCatalogue.map(row => row.template)] as [string, ...string[]]), version: z.number().int().min(1).max(2),
  input: z.object({ detail: z.string().min(1).max(2000).optional(), reference: z.string().min(1).max(80).optional(),
    amount_minor: z.string().max(16).optional(), currency: z.literal("zar").optional() }).strict(), link: linkInput.nullable(),
}).strict();
export type CreateInput = z.infer<typeof createInput>;
export function identity(input: CreateInput) {
  return digest({ source: { type: input.source.type, id: input.source.id, transition: input.source.transition },
    kind: input.kind, recipient: input.recipient, channel: input.channel });
}
export function requestFingerprint(input: CreateInput) {
  // Template upgrade alone must not resend history. Compare semantic input.
  return digest({ ...input, version: undefined });
}
export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
export function render(input: CreateInput, appEnv: string | undefined) {
  let content: { title: string; subject: string; text: string; html: string };
  if (input.template === "test.notification") {
    if (appEnv !== "test" || input.kind !== "FOUNDATION_TEST") throw new NotificationConflict();
    const entry = templateRegistry["test.notification"][input.version as 1 | 2];
    if (!entry || !entry.channels.some(channel => channel === input.channel)) throw new NotificationConflict();
    content = entry.render(entry.input.parse(input.input));
  } else content = renderProduction(input, escapeHtml);
  const output = { ...content, path: deepLink(input.link, appEnv) };
  if (output.title.length > limits.title || output.subject.length > limits.subject || output.text.length > limits.body || output.html.length > limits.html)
    throw new NotificationConflict();
  return output;
}
export const envelopeSchema = z.object({ from: z.string().min(1).max(400).refine(headerSafe),
  to: email, subject: z.string().min(1).max(limits.subject).refine(headerSafe),
  text: z.string().min(1).max(limits.body), html: z.string().min(1).max(limits.html), reply_to: email.nullable() }).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export type TransportResult = { classification: "ACCEPTED"; providerId: string; nativeId?: string }
  | { classification: Classification; code: string };
export function errorResult(classification: Classification, code: string): TransportResult {
  return { classification, code: /^[A-Z_]{1,60}$/.test(code) ? code : "TRANSPORT_FAILURE" };
}
export function classify(status: number, name: string): TransportResult {
  if (status === 429 || status === 409 && name === "concurrent_idempotent_requests") return errorResult("RETRYABLE", "PROVIDER_BUSY");
  if (status === 409) return errorResult("TERMINAL", "PROVIDER_PAYLOAD_CONFLICT");
  if ([400, 401, 403, 404, 413, 422].includes(status)) return errorResult("TERMINAL", "PROVIDER_REJECTED");
  return errorResult("AMBIGUOUS", "PROVIDER_UNCERTAIN");
}
export function retryAt(number: number, now: Date, firstSent: Date | null): Date | null {
  const delay = RETRY_MS[number - 1];
  if (number < 1 || number >= MAX_ATTEMPTS || delay === undefined) return null;
  const next = new Date(now.getTime() + delay);
  return firstSent && next.getTime() >= firstSent.getTime() + REPLAY_MS ? null : next;
}
export function canReplay(firstSent: Date, now: Date) {
  return now.getTime() >= firstSent.getTime() && now.getTime() < firstSent.getTime() + REPLAY_MS;
}
export function nextState(result: TransportResult, retry: Date | null): State {
  if (result.classification === "ACCEPTED") return "ACCEPTED";
  if (result.code === "CONFIGURATION_CHANGED" || result.code === "PROVIDER_PAYLOAD_CONFLICT") return "ATTENTION_REQUIRED";
  if (result.classification === "TERMINAL") return "TERMINAL_FAILURE";
  return retry ? "RETRYABLE_FAILURE" : "ATTENTION_REQUIRED";
}
export function sourceEligible(activated: Date | null, committed: Date, now: Date) {
  return !!activated && Number.isFinite(committed.getTime()) && activated <= committed && committed <= now;
}
