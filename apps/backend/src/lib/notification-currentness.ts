import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { productionDefinition } from "./notification-catalogue";
import { NativeNotificationActors, platformEligible, type NotificationActors } from "./notification-recipients";
import { NotificationSources, type Discovery, type NotificationFact } from "../modules/marketplace/notification-sources";
import type { Actor } from "./notification-policy";

export interface NoticeBinding { id: string; kind: string; template_key: string; recipient_type: string; recipient_id: string;
  source_type: string; source_id: string; source_transition: string; source_evidence: string; destination: string | null; deep_link?: string | null }
export function sourceDiscovery(source: string): Discovery | null {
  if (source === "checkout_completion" || source === "order_decision_event" || source === "pick_event" || source === "shortage_resolution") return "ORDER";
  if (["dispatch_commitment", "dispatch_event", "pickup_operation", "delivery_completion", "restricted_return", "restricted_event"].includes(source)) return "DELIVERY";
  if (source === "refund_operation") return "REFUND";
  if (source === "store_credit_operation") return "CREDIT";
  if (source === "settlement_transition_audit" || source === "merchant_settlement_command") return "SETTLEMENT";
  if (source === "driver_payment_command") return "DRIVER_PAYMENT";
  if (source === "order_finance_exception") return "MARKETPLACE_EXCEPTION";
  if (source === "driver_earning_exception") return "DRIVER_EXCEPTION";
  return null;
}
// Notification policy bindings only: existing owning capability functions still
// make the access decision. A closed task does not erase its historical notice.
export function platformNoticePolicy(row: NoticeBinding): Pick<NotificationFact, "platform" | "platformAction"> | null {
  switch (row.kind) {
    case "FINANCIAL_SETTLEMENT_ATTENTION": return { platform: "CUSTOMER_FINANCE", platformAction: row.source_type === "store_credit_operation" ? "CREDIT" : "REFUND" };
    case "MERCHANT_SETTLEMENT_ATTENTION": return { platform: "SETTLEMENT", platformAction: row.source_transition === "READY" ? "PREPARE" : "PAYMENT" };
    case "DRIVER_PAYMENT_ATTENTION": return { platform: "DRIVER_PAYMENT" };
    case "RECOGNITION_ATTENTION": return { platform: row.source_type === "driver_earning_exception" ? "DRIVER_RECOGNITION" : "MARKETPLACE_RECOGNITION" };
    case "DELIVERY_OPERATION_ATTENTION": return { platform: "DELIVERY_OPERATIONS" };
    default: return null;
  }
}
export function currentPlatformNotice(actor: Actor, row: NoticeBinding, env: NodeJS.ProcessEnv) {
  const policy = platformNoticePolicy(row); return !!policy && platformEligible(actor.id, policy, env);
}
export class NotificationCurrentness {
  private readonly native: NotificationActors;
  private readonly sources: NotificationSources;
  constructor(container: MedusaContainer, private readonly db: Knex, actors?: NotificationActors) {
    this.native = actors ?? new NativeNotificationActors(container, db);
    this.sources = new NotificationSources(container, db, this.native);
  }
  private async sourceId(row: NoticeBinding, topic: Discovery) {
    if (row.source_type === "checkout_completion") return (await this.db("checkout_completion").where({ id: row.source_id }).first())?.order_id;
    if (row.source_type === "order_decision_event") {
      const event = await this.db("order_decision_event").where({ id: row.source_id }).first();
      return event && (await this.db("order_operation").where({ id: event.order_operation_id }).first())?.medusa_order_id;
    }
    if (row.source_type === "pick_event" || row.source_type === "shortage_resolution") {
      const event = await this.db(row.source_type).where({ id: row.source_id }).first();
      const session = event && await this.db("pick_session").where({ id: event.pick_session_id }).first();
      return session && (await this.db("order_operation").where({ id: session.order_operation_id }).first())?.medusa_order_id;
    }
    if (topic === "DELIVERY") {
      const event = await this.db(row.source_type).where({ id: row.source_id }).first();
      if (!event) return null;
      if (row.source_type === "dispatch_event") return event.target_type === "DELIVERY" ? event.target_id : null;
      if (row.source_type === "restricted_event") return (await this.db("restricted_return").where({ id: event.target_id }).first())?.delivery_id;
      return event.delivery_id;
    }
    if (row.source_type === "settlement_transition_audit") return (await this.db(row.source_type).where({ id: row.source_id }).first())?.statement_id;
    if (row.source_type === "merchant_settlement_command") {
      const command = await this.db(row.source_type).where({ id: row.source_id }).first();
      return command && (await this.db("payable_settlement").where({ id: command.payable_id }).first())?.statement_id;
    }
    if (row.source_type === "driver_payment_command") return (await this.db(row.source_type).where({ id: row.source_id }).first())?.payment_id;
    return row.source_id;
  }
  async send(row: NoticeBinding): Promise<"STALE" | "AUTHORIZATION_CHANGED" | null> {
    const definition = productionDefinition(row.template_key), topic = sourceDiscovery(row.source_type);
    if (!definition || !definition.channels.includes("EMAIL") || !topic || row.recipient_type !== "customer") return "STALE";
    const sourceId = await this.sourceId(row, topic); if (!sourceId) return "STALE";
    const facts = await this.sources.discover(topic, sourceId, row.template_key);
    const fact = facts.find(candidate => candidate.template === row.template_key && candidate.kind === row.kind
      && candidate.source.type === row.source_type && candidate.source.id === row.source_id && candidate.source.transition === row.source_transition
      && candidate.source.evidence === row.source_evidence);
    if (!fact) return "STALE";
    if (!fact.order?.registered || fact.order.customerId !== row.recipient_id || fact.order.contact !== row.destination) return "AUTHORIZATION_CHANGED";
    // All C EMAIL facts are retrospective. Do not suppress settled credit just
    // because it was later spent or another legitimate financial fact occurred.
    return null;
  }
}
