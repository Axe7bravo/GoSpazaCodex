import type { MedusaContainer } from "@medusajs/framework/types";
import { z } from "@medusajs/framework/zod";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { NotificationFoundation } from "./notification-foundation";
import { NativeNotificationActors, NotificationRecipients, type NotificationActors } from "./notification-recipients";
import { NotificationSources, notificationDatabase, type Discovery, type NotificationFact } from "../modules/marketplace/notification-sources";
import { productionDefinition } from "./notification-catalogue";
import { actor, digest, id, identity, linkInput, NotificationConflict, type CreateInput } from "./notification-policy";

const discovery = z.enum(["ORDER", "DELIVERY", "REFUND", "CREDIT", "SETTLEMENT", "DRIVER_PAYMENT", "MARKETPLACE_EXCEPTION", "DRIVER_EXCEPTION"]);
// No send method/provider dependency. This service creates obligations only.
export class NotificationMappings {
  private readonly foundation: NotificationFoundation;
  private readonly sources: NotificationSources;
  private readonly recipients: NotificationRecipients;
  private readonly db: Knex;
  constructor(container: MedusaContainer, options: { db?: Knex; actors?: NotificationActors; env?: NodeJS.ProcessEnv } = {}) {
    this.db = options.db ?? notificationDatabase(container);
    const actors = options.actors ?? new NativeNotificationActors(container, this.db), env = options.env ?? process.env;
    this.foundation = new NotificationFoundation(this.db, env);
    this.sources = new NotificationSources(container, this.db, actors);
    this.recipients = new NotificationRecipients(this.db, actors, env);
  }
  async discover(topic: Discovery, sourceId: string) {
    const facts = await this.sources.discover(discovery.parse(topic), sourceId);
    const results = await Promise.allSettled(facts.map(fact => this.map(fact)));
    const errors = results.flatMap(row => row.status === "rejected" ? [row.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Notification source mapping requires review.");
  }
  async deliveredOrder(orderId: string) {
    id.parse(orderId);
    const delivery = await this.db("delivery_operation").where({ medusa_order_id: orderId }).whereNull("deleted_at").first();
    const results = await Promise.allSettled([this.discover("ORDER", orderId), ...(delivery ? [this.discover("DELIVERY", delivery.id)] : [])]);
    const errors = results.flatMap(row => row.status === "rejected" ? [row.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Notification outcome discovery requires review.");
  }
  private async map(fact: NotificationFact) {
    if (!await this.foundation.eligible(fact.source)) return;
    const candidates = await this.recipients.resolve(fact);
    if (candidates.length > 250) throw new NotificationConflict();
    const key = digest({ source: { type: fact.source.type, id: fact.source.id, transition: fact.source.transition }, kind: fact.kind, audience: fact.audience });
    const fingerprint = digest({ source: fact.source, template: fact.template, input: fact.input, link: fact.link });
    // Immutable audience snapshot prevents later-added actors receiving old
    // business facts. It neither dedupes sends nor replaces B intent identity.
    await this.db("notification_mapping_audience").insert({ source_key: key, fingerprint,
      recipients: JSON.stringify(candidates.map(candidate => ({ actor: candidate.actor,
        link: candidate.actor.type === "merchant" && candidate.merchant?.role === "PICKER" && fact.order
          ? { route: "MERCHANT_PICKING", resource: fact.order.id } : fact.link }))) }).onConflict("source_key").ignore();
    const snapshot = await this.db("notification_mapping_audience").where({ source_key: key }).first();
    if (snapshot?.fingerprint !== fingerprint) throw new NotificationConflict();
    const frozen = z.array(z.object({ actor, link: linkInput.nullable() }).strict()).max(250).parse(snapshot.recipients);
    const selected = candidates.filter(candidate => frozen.some(old => old.actor.type === candidate.actor.type && old.actor.id === candidate.actor.id));
    const definition = productionDefinition(fact.template); if (!definition) throw new NotificationConflict();
    const results = await Promise.allSettled(selected.flatMap(recipient => definition.channels.map(async channel => {
      const input: CreateInput = { source: fact.source, kind: fact.kind, recipient: recipient.actor, channel,
        destination: channel === "EMAIL" ? recipient.destination : null, template: fact.template, version: 1, input: fact.input,
        link: frozen.find(old => old.actor.type === recipient.actor.type && old.actor.id === recipient.actor.id)?.link ?? null };
      // Preserve a previously frozen destination on rediscovery. Other semantic
      // changes still fail B's fingerprint check; never retarget a financial notice.
      const existing = await this.db("notification_intent").where({ logical_key: identity(input) }).select("destination").first();
      if (existing) input.destination = existing.destination;
      await this.foundation.create(input, async trx => await this.recipients.current(recipient, fact, trx) && await this.sources.current(fact, trx));
    })));
    const errors = results.flatMap(row => row.status === "rejected" ? [row.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Notification recipient mapping requires review.");
  }
}
