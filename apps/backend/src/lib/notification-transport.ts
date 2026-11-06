import type { INotificationModuleService, NotificationTypes } from "@medusajs/framework/types";
import { z } from "@medusajs/framework/zod";
import { classify, digest, envelopeSchema, errorResult, HTTP_MS, NotificationConflict,
  type Envelope, type TransportResult } from "./notification-policy";
import type { NotificationTransport, SendClaim } from "./notification-foundation";

const providerId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const metadata = z.object({ key: z.string().regex(/^gospaza-m22-[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/),
  reply_to: z.string().max(254).nullable(), not_after: z.number().int().positive(), credential: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function providerPayload(envelope: Envelope, key: string, hash: string, credential: string, notAfter = Date.now() + HTTP_MS): NotificationTypes.ProviderSendNotificationDTO {
  const frozen = envelopeSchema.parse(envelope);
  metadata.parse({ key, hash, reply_to: frozen.reply_to, not_after: notAfter, credential });
  if (digest(frozen) !== hash) throw new NotificationConflict();
  return { channel: "email", template: "gospaza-frozen", to: frozen.to, from: frozen.from,
    content: { subject: frozen.subject, text: frozen.text, html: frozen.html },
    provider_data: { key, hash, reply_to: frozen.reply_to, not_after: notAfter, credential } };
}
export function unpackProvider(input: NotificationTypes.ProviderSendNotificationDTO) {
  if (input.channel !== "email" || input.template !== "gospaza-frozen" || input.attachments?.length || input.data && Object.keys(input.data).length)
    throw new NotificationConflict();
  const data = metadata.parse(input.provider_data);
  const envelope = envelopeSchema.parse({ from: input.from, to: input.to, subject: input.content?.subject,
    text: input.content?.text, html: input.content?.html, reply_to: data.reply_to });
  if (digest(envelope) !== data.hash) throw new NotificationConflict();
  return { envelope, key: data.key, notAfter: data.not_after, credential: data.credential };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new NotificationConflict();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new NotificationConflict();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

// Only this transport integration knows Resend's wire API. No hidden retries,
// redirects, configurable URL, recipient searches or provider error/body logs.
export class ResendHttpTransport {
  constructor(private readonly apiKey: string, private readonly request: typeof fetch = fetch,
    private readonly appEnv: string | undefined = process.env.APP_ENV) {}
  async send(input: NotificationTypes.ProviderSendNotificationDTO): Promise<TransportResult> {
    let frozen: ReturnType<typeof unpackProvider>;
    try { frozen = unpackProvider(input); }
    catch { return errorResult("TERMINAL", "ENVELOPE_INVALID"); }
    if (Date.now() >= frozen.notAfter) return errorResult("RETRYABLE", "CLAIM_EXPIRED");
    if (!this.apiKey || /\s/.test(this.apiKey)) return errorResult("TERMINAL", "CONFIGURATION");
    if (digest(this.apiKey) !== frozen.credential) return errorResult("TERMINAL", "CONFIGURATION_CHANGED");
    if (this.appEnv === "test" && this.request === fetch) return errorResult("TERMINAL", "TEST_NETWORK_DISABLED");
    const { envelope, key } = frozen;
    try {
      const response = await this.request("https://api.resend.com/emails", { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(HTTP_MS, frozen.notAfter - Date.now()))), headers: { Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ from: envelope.from, to: [envelope.to], subject: envelope.subject, text: envelope.text,
          html: envelope.html, ...(envelope.reply_to ? { reply_to: envelope.reply_to } : {}) }) });
      const body = await boundedJson(response);
      if (!response.ok) {
        const name = z.object({ name: z.string().max(100) }).safeParse(body);
        return classify(response.status, name.success ? name.data.name : "");
      }
      const accepted = z.object({ id: providerId }).safeParse(body);
      return accepted.success ? { classification: "ACCEPTED", providerId: accepted.data.id } : errorResult("AMBIGUOUS", "INVALID_ACCEPTANCE");
    } catch { return errorResult("AMBIGUOUS", "NETWORK_UNCERTAIN"); }
  }
  async retrieve(knownId: string): Promise<{ providerId: string; event: string | null }> {
    providerId.parse(knownId);
    if (!this.apiKey || this.appEnv === "test" && this.request === fetch) throw new NotificationConflict();
    try {
      const response = await this.request("https://api.resend.com/emails/" + encodeURIComponent(knownId), {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(HTTP_MS), headers: { Authorization: "Bearer " + this.apiKey } });
      if (!response.ok) throw new NotificationConflict();
      const body = z.object({ id: providerId, last_event: z.enum(["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed"]).nullable().optional() })
        .parse(await boundedJson(response));
      if (body.id !== knownId) throw new NotificationConflict();
      return { providerId: body.id, event: body.last_event ?? null };
    } catch { throw new NotificationConflict(); }
  }
}

// Medusa wraps provider exceptions. Only our bounded marker is decoded; neither
// raw provider bodies nor arbitrary database errors are made retryable here.
export class NativeNotificationTransport implements NotificationTransport {
  constructor(private readonly native: Pick<INotificationModuleService, "createNotifications">) {}
  async send(claim: SendClaim, envelope: Envelope): Promise<TransportResult> {
    try {
      if (Date.now() >= new Date(claim.lease_until).getTime()) return errorResult("RETRYABLE", "CLAIM_EXPIRED");
      const data = providerPayload(envelope, claim.provider_key, claim.envelope_hash, claim.credential_fingerprint, new Date(claim.lease_until).getTime());
      const rows = await this.native.createNotifications([{ ...data, idempotency_key: "gospaza-native-" + claim.id }]);
      const row = rows[0];
      if (!row || row.status !== "success" || !providerId.safeParse(row.external_id).success) return errorResult("AMBIGUOUS", "NATIVE_RESULT_UNCERTAIN");
      return { classification: "ACCEPTED", providerId: row.external_id as string, nativeId: row.id };
    } catch (error) {
      const message = safeProviderMarker(error);
      const match = /M22\|(RETRYABLE|TERMINAL|AMBIGUOUS)\|([A-Z_]{1,60})\|/.exec(message);
      if (match?.[1] === "RETRYABLE" || match?.[1] === "TERMINAL" || match?.[1] === "AMBIGUOUS")
        return errorResult(match[1], match[2] ?? "TRANSPORT_FAILURE");
      return errorResult("AMBIGUOUS", "NATIVE_RESULT_UNCERTAIN");
    }
  }
}

function safeProviderMarker(error: unknown, depth = 0): string {
  if (depth > 3 || !error || typeof error !== "object") return "";
  const message = error instanceof Error ? error.message : "";
  if (/M22\|(RETRYABLE|TERMINAL|AMBIGUOUS)\|[A-Z_]{1,60}\|/.test(message)) return message;
  if ("errors" in error && Array.isArray(error.errors)) {
    for (const child of error.errors.slice(0, 4)) {
      const marker = safeProviderMarker(child, depth + 1);
      if (marker) return marker;
    }
  }
  return "";
}
