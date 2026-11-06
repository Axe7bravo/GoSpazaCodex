import type { IAuthModuleService, ICustomerModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { ActorNotice, NoticePage, NotificationOperationPage, NotificationHealth } from "@gospaza/contracts";
import type MarketplaceService from "../modules/marketplace/service";
import { DriverService } from "../modules/marketplace/driver-service";
import { capabilitiesFor } from "../modules/marketplace/team-policy";
import { currentPlatformNotice, type NoticeBinding } from "./notification-currentness";
import { NotificationFoundation } from "./notification-foundation";
import { id, type Actor } from "./notification-policy";
import { encodeNoticeCursor, notificationOpsAllowed, notificationPage, notificationWorkers, transportDisposition, workerEnabled } from "./notification-runtime-policy";

const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Notification unavailable.");
const forbidden = () => new MedusaError(MedusaError.Types.FORBIDDEN, "Notification access unavailable.");
export interface NoticePrincipal { actor: Actor; role?: Parameters<typeof capabilitiesFor>[0] }
interface InboxRow extends NoticeBinding { title: string; body: string; deep_link: string | null; created_at: Date; read_at: Date | null }
interface OperationRow { id: string; kind: string; channel: "IN_APP" | "EMAIL"; created_at: Date; state: string;
  attempts: number; accepted_at: Date | null; revision: number }
export function noticeVisible(principal: NoticePrincipal, row: NoticeBinding, env: NodeJS.ProcessEnv) {
  if (row.recipient_type !== principal.actor.type || row.recipient_id !== principal.actor.id) return false;
  if (principal.actor.type === "user") return currentPlatformNotice(principal.actor, row, env);
  if (principal.actor.type !== "merchant") return true;
  if (!principal.role) return false;
  const capabilities = capabilitiesFor(principal.role);
  if (row.template_key.startsWith("merchant.settlement_")) return capabilities.includes("MERCHANT_SETTLEMENT_VIEW");
  if (row.template_key === "merchant.disposition_required") return capabilities.includes("MERCHANT_INVENTORY_MANAGE");
  if (row.template_key === "merchant.return_action") return capabilities.includes("MERCHANT_RETURN_RECEIVE");
  if (row.template_key === "merchant.new_order") return capabilities.includes("MERCHANT_ORDER_DECIDE");
  if (row.template_key === "merchant.order_closed" || row.template_key === "merchant.delivery_completed") return capabilities.includes("MERCHANT_ORDER_VIEW");
  if (principal.role === "PICKER" && !row.deep_link?.startsWith("/merchant/picking/")) return false;
  return capabilities.includes(principal.role === "PICKER" ? "MERCHANT_PICKING_VIEW" : "MERCHANT_ORDER_VIEW");
}
export interface NotificationAuthContext { actor_type: string; actor_id?: string; auth_identity_id?: string }
export class NotificationAccess {
  constructor(private readonly container: MedusaContainer) {}
  async resolve(context: NotificationAuthContext, expected: "customer" | "merchant" | "driver" | "user"): Promise<NoticePrincipal> {
    if (context.actor_type !== expected || !context.auth_identity_id) throw forbidden();
    // Re-read native identity on every request, including same-session access.
    const auth = await this.container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(context.auth_identity_id, { relations: ["provider_identities"] });
    if (!auth.provider_identities?.some(provider => provider.provider === "emailpass")) throw forbidden();
    if (expected === "merchant") {
      const tenant = await this.container.resolve<MarketplaceService>("marketplace").resolveTenant(auth.id);
      return { actor: { type: "merchant", id: tenant.membership.id }, role: tenant.membership.member_type };
    }
    if (expected === "driver") return { actor: { type: "driver", id: (await new DriverService(this.container).profileForIdentity(auth.id)).id } };
    if (!context.actor_id || auth.app_metadata?.[expected + "_id"] !== context.actor_id) throw forbidden();
    if (expected === "customer") {
      const customer = await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(context.actor_id);
      if (!customer.has_account) throw forbidden();
    } else await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(context.actor_id);
    return { actor: { type: expected, id: context.actor_id } };
  }
}
export function actorNotice(row: { id: string; kind: string; title: string; body: string; deep_link: string | null; created_at: Date | string; read_at: Date | string | null }): ActorNotice {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, deep_link: row.deep_link,
    created_at: new Date(row.created_at).toISOString(), read_at: row.read_at ? new Date(row.read_at).toISOString() : null };
}
export class NotificationInbox {
  readonly db: Knex;
  constructor(container: MedusaContainer, db?: Knex, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private rows(principal: NoticePrincipal) {
    return this.db("notification_intent as i").join("notification_notice as n", "n.intent_id", "i.id")
      .where({ "i.recipient_type": principal.actor.type, "i.recipient_id": principal.actor.id, "i.channel": "IN_APP" })
      .select<InboxRow[]>("i.*", "n.read_at");
  }
  async list(principal: NoticePrincipal, value: unknown): Promise<NoticePage> {
    const input = notificationPage.parse(value), query = this.rows(principal);
    if (input.cursor) query.whereRaw("(i.created_at,i.id)<(?::timestamptz,?::text)", [input.cursor.at, input.cursor.id]);
    // Scan at most one page. Hidden/revoked categories still advance cursor;
    // no unbounded fill loop and no persisted unread-counter authority.
    const rows = await query.orderBy("i.created_at", "desc").orderBy("i.id", "desc").limit(input.limit + 1);
    const page = rows.slice(0, input.limit), last = page[page.length - 1];
    return { notifications: page.filter(row => noticeVisible(principal, row, this.env)).map(actorNotice),
      next_cursor: rows.length > input.limit && last ? encodeNoticeCursor(last.created_at, last.id) : null };
  }
  async detail(principal: NoticePrincipal, noticeId: string, markRead = false): Promise<ActorNotice> {
    id.parse(noticeId);
    const row = await this.rows(principal).where("i.id", noticeId).first();
    if (!row || !noticeVisible(principal, row, this.env)) throw missing();
    if (markRead) {
      await new NotificationFoundation(this.db, this.env).readNotice(principal.actor, noticeId, true);
      const current = await this.rows(principal).where("i.id", noticeId).first();
      if (!current) throw missing(); return actorNotice(current);
    }
    return actorNotice(row);
  }
  private authorizeOps(principal: NoticePrincipal) {
    if (principal.actor.type !== "user" || !notificationOpsAllowed(principal.actor.id, this.env)) throw forbidden();
  }
  async operations(principal: NoticePrincipal, value: unknown): Promise<NotificationOperationPage> {
    this.authorizeOps(principal);
    const input = notificationPage.parse(value), query = this.db("notification_intent as i").join("notification_delivery as d", "d.intent_id", "i.id")
      .select<OperationRow[]>("i.id", "i.kind", "i.channel", "i.created_at", "d.state", "d.attempts", "d.accepted_at", "d.revision");
    if (input.cursor) query.whereRaw("(i.created_at,i.id)<(?::timestamptz,?::text)", [input.cursor.at, input.cursor.id]);
    const rows = await query.orderBy("i.created_at", "desc").orderBy("i.id", "desc").limit(input.limit + 1), page = rows.slice(0, input.limit);
    const operations = [];
    for (const row of page) {
      const event = await this.db("notification_delivery_event").where({ intent_id: row.id, revision: row.revision }).first();
      const evidence = await this.db("notification_provider_evidence as e").join("notification_provider_message as p", "p.provider_id", "e.provider_id")
        .where("p.intent_id", row.id).distinct("e.event_type");
      operations.push({ id: row.id, kind: row.kind, channel: row.channel, state: row.state, attempts: row.attempts,
        created_at: new Date(row.created_at).toISOString(), accepted_at: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
        last_code: event?.code ?? "UNAVAILABLE", transport_disposition: transportDisposition(evidence.map(e => e.event_type), row.state === "ACCEPTED" && row.channel === "EMAIL") });
    }
    const last = page[page.length - 1];
    return { operations, next_cursor: rows.length > input.limit && last ? encodeNoticeCursor(last.created_at, last.id) : null };
  }
  async health(principal: NoticePrincipal): Promise<NotificationHealth> {
    this.authorizeOps(principal);
    const { rows: [clock] } = await this.db.raw("select gospaza_notification_now() as instant"), start = new Date(new Date(clock.instant).getTime() - 86400000);
    const sample = await this.db("notification_intent as i").join("notification_delivery as d", "d.intent_id", "i.id")
      .where("i.created_at", ">=", start).orderBy("i.created_at", "desc").orderBy("i.id", "desc").select("i.channel", "d.state", "d.suppression_reason").limit(10001);
    const rows = sample.slice(0, 10000), states: Record<string, number> = {};
    for (const row of rows) states[row.state] = (states[row.state] ?? 0) + 1;
    const boundedCount = async (table: string, column: string, extra: Record<string, string> = {}) => Number((await this.db.from(
      this.db(table).where(column, ">=", start).where(extra).select(this.db.raw("1")).limit(10000).as("bounded")).count("* as n").first())?.n);
    const oldest = await this.db("notification_delivery as d").join("notification_intent as i", "i.id", "d.intent_id")
      .where("i.channel", "EMAIL").whereIn("d.state", ["PENDING", "RETRYABLE_FAILURE"])
      .where(q => q.whereNull("d.next_attempt_at").orWhereRaw("d.next_attempt_at<=gospaza_notification_now()"))
      .orderBy("i.created_at").select("i.created_at").first();
    const health = await this.db("notification_worker_health");
    return { window_start: start.toISOString(), sampled: rows.length, truncated: sample.length > 10000, states,
      in_app: rows.filter(row => row.channel === "IN_APP").length,
      email_attempts: await boundedCount("notification_attempt", "started_at"), dispatched_attempts: await boundedCount("notification_attempt_started", "dispatched_at"),
      ambiguous: await boundedCount("notification_attempt_result", "completed_at", { classification: "AMBIGUOUS" }),
      stale_suppressions: rows.filter(row => row.suppression_reason === "STALE").length,
      webhook_evidence: await boundedCount("notification_webhook_receipt", "received_at"),
      retrieval_mismatches: await boundedCount("notification_runtime_observation", "recorded_at", { category: "RETRIEVAL_MISMATCH" }),
      repair_discoveries: await boundedCount("notification_runtime_observation", "recorded_at", { category: "REPAIR_DISCOVERED" }),
      oldest_pending_age_seconds: oldest ? Math.max(0, Math.floor((new Date(clock.instant).getTime() - new Date(oldest.created_at).getTime()) / 1000)) : null,
      workers: notificationWorkers.map(name => { const row = health.find(item => item.name === name); return { name, enabled: workerEnabled(name, this.env),
        last_success_at: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null, last_error: row?.last_error ?? null }; }) };
  }
}
