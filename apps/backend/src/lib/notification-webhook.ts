import { createHmac, timingSafeEqual } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { z } from "@medusajs/framework/zod";
import { digest, id, NotificationConflict } from "./notification-policy";
import { NotificationFoundation } from "./notification-foundation";

export class NotificationWebhookInvalid extends Error { constructor() { super("Invalid notification webhook."); } }
export function verifyResendWebhook(raw: string | Buffer, headers: Record<string, unknown>, secret: string, now = Date.now()) {
  const invalid = () => new NotificationWebhookInvalid();
  const header = (name: string) => {
    const value = headers[name]; if (typeof value !== "string" || !value || value.length > 2048) throw invalid(); return value;
  };
  const eventId = header("svix-id"), timestamp = header("svix-timestamp"), signatures = header("svix-signature");
  if (!id.safeParse(eventId).success || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300
    || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length > 256) throw invalid();
  const bytes = Buffer.from(raw); if (!bytes.length || bytes.length > 65536) throw invalid();
  const key = Buffer.from(secret.slice(6), "base64"); if (key.length < 16) throw invalid();
  // Official Resend/Svix protocol: HMAC-SHA256(id.timestamp.exactRawBytes),
  // whsec_ base64 key, v1 signatures, constant-time comparison and freshness.
  const expected = createHmac("sha256", key).update(eventId + "." + timestamp + ".").update(bytes).digest();
  if (!signatures.split(/\s+/).slice(0, 10).some(part => {
    const [version, encoded] = part.split(","); if (version !== "v1" || !encoded) return false;
    const candidate = Buffer.from(encoded, "base64");
    return candidate.length === expected.length && candidate.toString("base64") === encoded && timingSafeEqual(candidate, expected);
  })) throw invalid();
  let body: unknown; try { body = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  const envelope = z.object({ type: z.string().max(80), created_at: z.string().datetime({ offset: true }),
    data: z.object({ email_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }) }).safeParse(body);
  if (!envelope.success) throw invalid();
  const type = envelope.data.type.replace(/^email\./, "");
  if (!envelope.data.type.startsWith("email.") || !["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed"].includes(type)) return null;
  return { event_id: eventId, provider_id: envelope.data.data.email_id, event_type: type,
    occurred_at: envelope.data.created_at, fingerprint: digest(bytes.toString("base64")) };
}
export async function receiveResendWebhook(db: Knex, verified: NonNullable<ReturnType<typeof verifyResendWebhook>>) {
  const foundation = new NotificationFoundation(db);
  await db.transaction(async trx => {
    await trx.raw("select pg_advisory_xact_lock(?::bigint)", [BigInt.asIntN(64, BigInt("0x" + digest(verified.event_id).slice(0, 16))).toString()]);
    const known = await trx("notification_attempt_result").where({ provider_id: verified.provider_id, classification: "ACCEPTED" }).first();
    if (!known) throw new NotificationConflict(); // no source intent or guessed binding
    await trx("notification_webhook_receipt").insert({ event_id: verified.event_id, provider_id: verified.provider_id, fingerprint: verified.fingerprint })
      .onConflict("event_id").ignore();
    const prior = await trx("notification_webhook_receipt").where({ event_id: verified.event_id }).first();
    if (prior?.fingerprint !== verified.fingerprint || prior.provider_id !== verified.provider_id) throw new NotificationConflict();
    await foundation.recordKnownEvidence({ event_id: verified.event_id, provider_id: verified.provider_id, attempt_id: known.attempt_id,
      event_type: verified.event_type, occurred_at: verified.occurred_at }, trx);
  });
}
