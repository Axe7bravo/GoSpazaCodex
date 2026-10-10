import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import { identifier, minorAmount, webhookKey } from "./validation";
import { YocoProviderError, type VerifiedPaymentEvent, type YocoWebhookPayload } from "./types";

/** Pure verification/normalization. Does not acknowledge, persist or dispatch an event. */
export const verifiedPayment = z.object({
  id: identifier, type: z.enum(["payment.succeeded", "payment.failed"]),
  paymentId: identifier, checkoutId: identifier, sessionId: identifier.optional(),
  operationId: identifier, amount: minorAmount, currency: z.literal("ZAR"), mode: z.enum(["test", "live"]),
}).strict();

function signedEnvelope(
  input: YocoWebhookPayload,
  secret: string,
  now = Date.now(),
) {
  const invalid = () => new YocoProviderError("YOCO_INVALID_WEBHOOK");
  const header = (name: string) => {
    const value = input.headers[name];
    if (typeof value !== "string" || !value || value.length > 2048) throw invalid();
    return value;
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
    || Math.abs(now / 1000 - Number(timestamp)) > 180) throw invalid();
  if (typeof input.rawData !== "string" && !Buffer.isBuffer(input.rawData)) throw invalid();
  const raw = Buffer.from(input.rawData);
  if (!raw.length || raw.length > 65536) throw invalid();
  const expected = createHmac("sha256", webhookKey(secret))
    .update(id + "." + timestamp + ".")
    .update(raw)
    .digest();
  const matches = signatures.split(/\s+/).some((part) => {
    const [version, encoded] = part.split(",");
    if (version !== "v1" || !encoded) return false;
    const candidate = Buffer.from(encoded, "base64");
    return candidate.length === expected.length && candidate.toString("base64") === encoded
      && timingSafeEqual(expected, candidate);
  });
  if (!matches) throw invalid();

  // Parse the signed bytes, never the separately supplied parsed wrapper data.
  let body: unknown;
  try { body = JSON.parse(raw.toString("utf8")); } catch { throw invalid(); }
  const envelope = z.object({ id: identifier, type: z.string(), payload: z.unknown() }).safeParse(body);
  if (!envelope.success) throw invalid();
  return envelope.data;
}

export function verifyYocoEvent(input: YocoWebhookPayload, secret: string, now = Date.now()): VerifiedPaymentEvent | null {
  return paymentEvent(signedEnvelope(input, secret, now));
}

function paymentEvent(body: { id: string; type: string; payload?: unknown }): VerifiedPaymentEvent | null {
  const invalid = () => new YocoProviderError("YOCO_INVALID_WEBHOOK");
  if (!["payment.succeeded", "payment.failed"].includes(body.type)) return null;
  const parsed = z.object({
    id: identifier,
    type: z.enum(["payment.succeeded", "payment.failed"]),
    payload: z.object({
      id: identifier,
      type: z.literal("payment"),
      status: z.enum(["succeeded", "failed"]),
      amount: minorAmount,
      currency: z.literal("ZAR"),
      mode: z.enum(["test", "live"]),
      metadata: z.object({ checkoutId: identifier, session_id: identifier.optional(), operation_id: identifier }),
    }),
  }).safeParse(body);
  if (!parsed.success || parsed.data.type !== "payment." + parsed.data.payload.status) throw invalid();
  const event = parsed.data;
  return {
    id: event.id,
    type: event.type,
    paymentId: event.payload.id,
    checkoutId: event.payload.metadata.checkoutId,
    sessionId: event.payload.metadata.session_id,
    operationId: event.payload.metadata.operation_id,
    amount: event.payload.amount,
    currency: event.payload.currency,
    mode: event.payload.mode,
  };
}

export const verifiedRefund = z.object({
  id: identifier, type: z.enum(["refund.succeeded", "refund.failed"]),
  checkoutId: identifier, amount: minorAmount, currency: z.literal("ZAR"), mode: z.enum(["test", "live"]),
}).strict();
export type VerifiedRefundEvent = z.infer<typeof verifiedRefund>;
export type VerifiedYocoEvent = VerifiedPaymentEvent | VerifiedRefundEvent;
export const verifiedYocoEvent = z.union([verifiedPayment, verifiedRefund]);

export function verifyYocoInboxEvent(input: YocoWebhookPayload, secret: string, now = Date.now()): VerifiedYocoEvent | null {
  const body = signedEnvelope(input, secret, now);
  const payment = paymentEvent(body);
  if (payment) return payment;
  if (!["refund.succeeded", "refund.failed"].includes(body.type)) return null;
  const parsed = z.object({
    id: identifier, type: z.enum(["refund.succeeded", "refund.failed"]),
    payload: z.object({ type: z.literal("refund"), status: z.enum(["succeeded", "failed"]),
      amount: minorAmount, currency: z.literal("ZAR"), mode: z.enum(["test", "live"]),
      metadata: z.object({ checkoutId: identifier }),
    }),
  }).safeParse(body);
  if (!parsed.success || parsed.data.type !== "refund." + parsed.data.payload.status) {
    throw new YocoProviderError("YOCO_INVALID_WEBHOOK");
  }
  return { id: parsed.data.id, type: parsed.data.type, checkoutId: parsed.data.payload.metadata.checkoutId,
    amount: parsed.data.payload.amount, currency: parsed.data.payload.currency, mode: parsed.data.payload.mode };
}
