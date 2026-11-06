import type { MedusaContainer, INotificationModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { NotificationFoundation, type NotificationTransport } from "./notification-foundation";
import { NotificationCurrentness, type NoticeBinding } from "./notification-currentness";
import { resendConfiguration } from "./notification-config";
import { digest, envelopeSchema } from "./notification-policy";
import { NativeNotificationTransport, ResendHttpTransport } from "./notification-transport";
import { runtimeBatch } from "./notification-runtime-policy";

export class NotificationRuntime {
  readonly db: Knex;
  readonly foundation: NotificationFoundation;
  private readonly eligibility: (row: NoticeBinding) => Promise<"STALE" | "AUTHORIZATION_CHANGED" | null>;
  constructor(private readonly container: MedusaContainer, private readonly options: { db?: Knex; env?: NodeJS.ProcessEnv;
    transport?: NotificationTransport; eligibility?: (row: NoticeBinding) => Promise<"STALE" | "AUTHORIZATION_CHANGED" | null> } = {}) {
    this.db = options.db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.foundation = new NotificationFoundation(this.db, options.env ?? process.env);
    const currentness = new NotificationCurrentness(container, this.db);
    this.eligibility = options.eligibility ?? (row => currentness.send(row));
  }
  async send(intentId: string) {
    const row = await this.db("notification_intent").where({ id: intentId, channel: "EMAIL" }).first(); if (!row) return false;
    const disposition = await this.foundation.inspect(intentId);
    if (!disposition || !["PENDING", "RETRYABLE_FAILURE"].includes(disposition.state)) return false;
    if ((this.options.env ?? process.env).APP_ENV === "test" && !this.options.transport) {
      await this.foundation.configurationAttention(intentId); return false;
    }
    const reason = await this.eligibility(row);
    if (reason) {
      // Another worker may have won admission meanwhile. Never suppress its
      // in-progress attempt or hide arbitrary validation/storage exceptions.
      await this.foundation.suppress(intentId, reason, true); return false;
    }
    const config = resendConfiguration(this.options.env ?? process.env);
    if (!row.envelope || !envelopeSchema.safeParse(row.envelope).success || digest(row.envelope) !== row.envelope_hash) {
      await this.foundation.configurationAttention(intentId, "ENVELOPE_INVALID"); return false;
    }
    if (!config || row.credential_fingerprint !== digest(config.apiKey)) {
      await this.foundation.configurationAttention(intentId, config ? "CONFIGURATION_CHANGED" : "CONFIGURATION"); return false;
    }
    const transport = this.options.transport ?? new NativeNotificationTransport(this.container.resolve<INotificationModuleService>(Modules.NOTIFICATION));
    // claim/begin and finish are short fenced transactions; send is outside.
    return this.foundation.execute(intentId, transport);
  }
  async deliveryCycle() {
    const rows = await this.db("notification_delivery as d").join("notification_intent as i", "i.id", "d.intent_id")
      .where("i.channel", "EMAIL").whereIn("d.state", ["PENDING", "RETRYABLE_FAILURE"])
      .where(q => q.whereNull("d.next_attempt_at").orWhereRaw("d.next_attempt_at<=gospaza_notification_now()"))
      .select("i.id").orderBy("i.created_at").orderBy("i.id").limit(runtimeBatch);
    let failed = false;
    for (const row of rows) try { await this.send(row.id); } catch { failed = true; }
    await this.health("delivery", failed ? "EXECUTION_UNAVAILABLE" : null);
  }
  async recoverStuck() {
    const rows = await this.db("notification_delivery").where({ state: "IN_PROGRESS" }).whereRaw("lease_until<=gospaza_notification_now()")
      .orderBy("lease_until").orderBy("intent_id").limit(runtimeBatch);
    for (const row of rows) await this.foundation.recoverExpired(row.intent_id);
  }
  async health(name: "delivery" | "repair", error: string | null) {
    const clock = this.db.raw("gospaza_notification_now()");
    await this.db("notification_worker_health").insert({ name, last_success_at: error ? null : clock, last_error: error, updated_at: clock })
      .onConflict("name").merge(error ? { last_error: error, updated_at: clock } : { last_success_at: clock, last_error: null, updated_at: clock });
    if (error) this.container.resolve<{ warn(message: string): void }>(ContainerRegistrationKeys.LOGGER)
      .warn(JSON.stringify({ event: "notification.worker", worker: name, code: error }));
  }
  async retrieveKnown(retrieve?: (id: string) => Promise<{ providerId: string; event: string | null }>) {
    const config = resendConfiguration(this.options.env ?? process.env); if (!config && !retrieve) return;
    const adapter = retrieve ?? ((id: string) => new ResendHttpTransport(config?.apiKey ?? "").retrieve(id));
    // Rotate known IDs through a durable checkpoint; no scan by customer/email.
    const key = "PROVIDER", { rows: [clock] } = await this.db.raw("select gospaza_notification_now() as instant");
    await this.db("notification_repair_checkpoint").insert({ family: key, window_start: clock.instant, window_end: clock.instant }).onConflict("family").ignore();
    const point = await this.db("notification_repair_checkpoint").where({ family: key }).first();
    const rows = await this.db("notification_provider_message as p").join("notification_attempt_result as r", "r.provider_id", "p.provider_id")
      .where("r.classification", "ACCEPTED").modify(q => { if (point.cursor_id) q.where("p.provider_id", ">", point.cursor_id); })
      .select("p.provider_id", "r.attempt_id").orderBy("p.provider_id").limit(runtimeBatch);
    for (const row of rows) {
      try {
        const result = await adapter(row.provider_id);
        if (result.providerId !== row.provider_id || result.event && !["sent", "delivered", "delivery_delayed", "bounced", "complained", "failed"].includes(result.event)) throw Error("PROVIDER_MISMATCH");
        if (result.event) {
          const eventId = "retrieve_" + digest({ id: row.provider_id, event: result.event });
          await this.db.transaction(async trx => {
            await trx("notification_provider_observation").insert({ provider_id: row.provider_id, event_type: result.event })
              .onConflict(["provider_id", "event_type"]).ignore();
            const observed = await trx("notification_provider_observation").where({ provider_id: row.provider_id, event_type: result.event }).first();
            if (!observed) throw Error("PROVIDER_MISMATCH");
            // Retrieval gives a status snapshot, not its historical event time.
            // Freeze first observation once so racing retrievals converge.
            await this.foundation.recordKnownEvidence({ event_id: eventId, provider_id: row.provider_id, attempt_id: row.attempt_id,
              event_type: result.event, occurred_at: new Date(observed.first_observed_at).toISOString() }, trx);
          });
        }
      } catch { await this.db("notification_runtime_observation").insert({ category: "RETRIEVAL_MISMATCH" }); }
    }
    await this.db("notification_repair_checkpoint").where({ family: key }).update({ cursor_id: rows.length === runtimeBatch ? rows[rows.length - 1]?.provider_id : null,
      cursor_at: rows.length === runtimeBatch ? clock.instant : null });
  }
}
