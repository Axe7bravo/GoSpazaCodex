import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { NotificationConflict } from "../../../../lib/notification-policy";
import { NotificationWebhookInvalid, receiveResendWebhook, verifyResendWebhook } from "../../../../lib/notification-webhook";
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NOTIFICATION_WEBHOOK_ENABLED !== "true" || !process.env.RESEND_WEBHOOK_SECRET) { res.status(503).json({ code: "NOTIFICATION_INGRESS_UNAVAILABLE" }); return; }
  const raw: unknown = req.rawBody;
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) { res.status(400).json({ code: "INVALID_WEBHOOK" }); return; }
  try {
    const verified = verifyResendWebhook(raw, req.headers, process.env.RESEND_WEBHOOK_SECRET);
    if (verified) await receiveResendWebhook(req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), verified);
    res.json({ received: true });
  } catch (error) {
    if (error instanceof NotificationWebhookInvalid) { res.status(400).json({ code: "INVALID_WEBHOOK" }); return; }
    if (error instanceof NotificationConflict) {
      await req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("notification_runtime_observation").insert({ category: "WEBHOOK_CONFLICT" });
      res.status(409).json({ code: "NOTIFICATION_EVIDENCE_CONFLICT" }); return;
    }
    throw error; // never acknowledge failed persistence
  }
}
