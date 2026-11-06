import type { MedusaContainer, IOrderModuleService, IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules, MedusaError } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { operationsSources, operationsTimelineSources } from "@gospaza/contracts";
import type { OperationsOverview, OverviewSection, OperationsSource, OperationsHealth, OperationalWorkerSignal, OperationsTimeline } from "@gospaza/contracts";
import { OperationsAttentionRead } from "../modules/marketplace/operations-attention";
import { MarketplaceOperationsRead } from "../modules/marketplace/operations-read";
import { OperationsTimelineRead } from "../modules/marketplace/operations-timeline";
import { diagnosticTime, lookupInput, lookupSource, operationsId, operationsSource, sourceAllowed, timelineInput, timelineSource } from "../modules/marketplace/operations-policy";
import { platformGranted } from "../modules/marketplace/platform-capabilities";
import { hasFinancialCapability } from "../modules/marketplace/financial-policy";
import { NotificationInbox } from "./notification-inbox";
const forbidden = () => new MedusaError(MedusaError.Types.FORBIDDEN, "Operations capability required.");
async function boundedFanOut<T, R>(values: readonly T[], read: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) result.push(...await Promise.all(values.slice(offset, offset + 4).map(read)));
  return result;
}
// Composition uses public owner read ports, never controllers/ensure/repair.
export class OperationsService {
  readonly db: Knex;
  private readonly read: MarketplaceOperationsRead;
  constructor(private readonly container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.read = new MarketplaceOperationsRead(this.db, async id => {
      const row = await container.resolve<IOrderModuleService>(Modules.ORDER).retrieveOrder(id, { select: ["id", "status", "currency_code"] });
      return { id: row.id, status: row.status, currency_code: row.currency_code };
    });
  }
  private async user(actor: string) { if (!actor) throw forbidden(); await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(actor); }
  private async authorize(actor: string, source: OperationsSource) {
    if (!sourceAllowed(actor, source)) throw forbidden(); await this.user(actor); if (!sourceAllowed(actor, source)) throw forbidden();
  }
  private links(actor: string) {
    const links: { label: string; href: string }[] = [];
    const add = (allowed: boolean, label: string, href: string) => { if (allowed) links.push({ label, href }); };
    add(sourceAllowed(actor, "merchant_review"), "Merchant review", "/admin/merchant-applications");
    add(sourceAllowed(actor, "driver_review"), "Driver review", "/admin/drivers");
    add(sourceAllowed(actor, "restricted_review"), "Store compliance", "/admin/restricted-commerce");
    add(platformGranted(actor, "SERVICE_CONFIGURATION_VIEW"), "Service zones", "/admin/service-zones");
    add(sourceAllowed(actor, "adjustments"), "Financial adjustments", "/admin/financial-adjustments");
    add(sourceAllowed(actor, "settlements"), "Merchant settlements", "/admin/settlements");
    add(sourceAllowed(actor, "driver_payments"), "Driver finance", "/admin/driver-finance");
    add(sourceAllowed(actor, "notifications"), "Notification operations", "/admin/notifications");
    add(hasFinancialCapability(actor, "VIEW") || (process.env.COMMISSION_CONFIGURE_USER_IDS ?? "").split(",").map(v => v.trim()).includes(actor), "Commissions", "/admin/commissions");
    return links;
  }
  async overview(actor: string): Promise<OperationsOverview> {
    await this.user(actor); const allowed = operationsSources.filter(source => sourceAllowed(actor, source));
    if (!allowed.length && !this.links(actor).length) throw forbidden();
    const sections = await boundedFanOut<OperationsSource, OverviewSection>(allowed, async source => {
      try { return { source, availability: "AVAILABLE", page: await this.attention(actor, source, { limit: 5 }) }; }
      catch { return { source, availability: "UNAVAILABLE" }; }
    });
    await this.user(actor);
    return { observed_at: new Date().toISOString(), sections: sections.filter(section => sourceAllowed(actor, section.source)), links: this.links(actor),
      navigation: { orders: platformGranted(actor, "ORDER_OPERATIONS_VIEW"), deliveries: platformGranted(actor, "DELIVERY_OPERATIONS_VIEW") } };
  }
  async attention(actor: string, source: unknown, input: unknown) {
    const selected = operationsSource.parse(source); await this.authorize(actor, selected);
    const page = await new OperationsAttentionRead(this.db).page(selected, input);
    await this.authorize(actor, selected); return page;
  }
  async order(actor: string, value: unknown) {
    await this.authorize(actor, "orders"); const id = operationsId.parse(value), result = await this.read.order(id);
    if (sourceAllowed(actor, "deliveries")) {
      try {
        const d = await this.db("delivery_operation").where({ medusa_order_id: id }).whereNull("deleted_at").first("id");
        if (d) { const projection = await this.read.delivery(String(d.id)); if (sourceAllowed(actor, "deliveries")) result.delivery = projection; }
      } catch { if (sourceAllowed(actor, "deliveries")) result.unavailable_sections.push("delivery"); }
    }
    if (sourceAllowed(actor, "adjustments")) {
      try { const projection = await this.read.finance(id); if (sourceAllowed(actor, "adjustments")) result.finance = projection; }
      catch { if (sourceAllowed(actor, "adjustments")) result.unavailable_sections.push("finance"); }
    }
    await this.authorize(actor, "orders"); return result;
  }
  async delivery(actor: string, value: unknown) {
    await this.authorize(actor, "deliveries"); const result = await this.read.delivery(operationsId.parse(value));
    await this.authorize(actor, "deliveries"); return { ...result, can_rescue: platformGranted(actor, "DELIVERY_RESCUE") };
  }
  async lookup(actor: string, value: unknown) {
    const input = lookupInput.parse(value), source = input.type === "MERCHANT" && !sourceAllowed(actor, "orders") ? "merchant_review" : lookupSource[input.type];
    await this.authorize(actor, source); const result = await this.read.lookup(input.type, input.id);
    await this.authorize(actor, source); return result;
  }
  async timeline(actor: string, type: "order" | "delivery", value: unknown, query: unknown): Promise<OperationsTimeline> {
    const base = type === "order" ? "orders" : "deliveries"; await this.authorize(actor, base);
    const id = operationsId.parse(value), input = timelineInput.parse(query);
    let order = id, delivery: string | null = null;
    if (type === "delivery") { const d = await this.read.delivery(id); order = d.order_id; delivery = d.id; }
    else {
      await this.read.order(id);
      // Merely discovering a Delivery ID is also behind its own authority.
      if (sourceAllowed(actor, "deliveries") || sourceAllowed(actor, "restricted_review")) {
        const d = await this.db("delivery_operation").where({ medusa_order_id: id }).whereNull("deleted_at").first("id"); delivery = d ? String(d.id) : null;
      }
    }
    if (input.cursor && !input.source) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Select the timeline source for its cursor.");
    if (input.source && !sourceAllowed(actor, timelineSource[input.source])) throw forbidden();
    const sources = input.source ? [input.source] : operationsTimelineSources.filter(source => sourceAllowed(actor, timelineSource[source]));
    const pages = await boundedFanOut(sources, async source => {
      await this.authorize(actor, timelineSource[source]);
      return new OperationsTimelineRead(this.db).page(order, delivery, source, input.source ? input.limit : Math.min(5, input.limit), input.cursor);
    });
    await this.authorize(actor, base);
    return { observed_at: new Date().toISOString(), pages: pages.filter(page => sourceAllowed(actor, timelineSource[page.source])) };
  }
  async health(actor: string): Promise<OperationsHealth> {
    await this.user(actor); const workers: OperationalWorkerSignal[] = [];
    const specs = [
      { source: "orders", name: "Order operation repair", table: "order_operation_repair_cursor", key: "id", at: null, flag: null },
      { source: "deliveries", name: "Dispatch", table: "dispatch_work", key: "delivery_id", at: "next_due_at", flag: "DISPATCH_WORKER_ENABLED" },
      { source: "deliveries", name: "Pickup", table: "pickup_work", key: "delivery_id", at: "next_due_at", flag: "PICKUP_WORKER_ENABLED" },
      { source: "deliveries", name: "Handoff", table: "delivery_completion", key: "id", at: "next_due_at", flag: "HANDOFF_WORKER_ENABLED" },
      { source: "recovery", name: "Payment reconciliation", table: "provider_operation", key: "id", at: "updated_at", flag: "PAYMENT_RECONCILIATION_WORKER_ENABLED" },
      { source: "recovery", name: "Refund recovery", table: "refund_operation", key: "id", at: "updated_at", flag: "REFUND_RECOVERY_WORKER_ENABLED" },
      { source: "inventory", name: "Omission reservations", table: "omission_reservation_release", key: "resolution_id", at: "updated_at", flag: "OMISSION_RESERVATION_WORKER_ENABLED" },
    ] as const;
    for (const spec of specs) {
      if (!sourceAllowed(actor, spec.source)) continue;
      const q = this.db(spec.table).orderBy(spec.at ?? spec.key).limit(26);
      if (spec.at) q.where(spec.at, "<=", this.db.raw("clock_timestamp()"));
      if (spec.table === "provider_operation") q.where("reconciliation_pending", true);
      if (spec.table === "refund_operation") q.whereIn("status", ["CREATED", "REQUESTED", "UNKNOWN", "PROVIDER_SUCCEEDED", "ATTENTION_REQUIRED"]);
      if (spec.table === "omission_reservation_release") q.whereIn("status", ["DISPATCHED", "ATTENTION_REQUIRED"]);
      if (spec.table === "delivery_completion") q.whereNot("state", "SUCCEEDED");
      const rows = await q.select(spec.at ? [spec.key, spec.at] : [spec.key]);
      workers.push({ name: spec.name, execution_health: "NOT_INSTRUMENTED", enabled: spec.flag && ["true", "false"].includes(process.env[spec.flag] ?? "") ? process.env[spec.flag] === "true" : null,
        sample_kind: spec.at === null ? "CURSOR_RECORDS" : ["provider_operation", "refund_operation", "omission_reservation_release"].includes(spec.table) ? "PENDING_RECORDS" : "DUE_WORK",
        sample_count: rows.slice(0, 25).length, has_more: rows.length > 25, oldest_in_sample: spec.at ? diagnosticTime(rows[0]?.[spec.at]) : null });
    }
    const result: OperationsHealth = { observed_at: new Date().toISOString(), workers };
    if (sourceAllowed(actor, "notifications")) result.notifications = await new NotificationInbox(this.container).health({ actor: { type: "user", id: actor } });
    if (!specs.some(spec => sourceAllowed(actor, spec.source)) && !sourceAllowed(actor, "notifications")) throw forbidden();
    await this.user(actor);
    // Re-authorize after reads; no stale granted section is returned.
    result.workers = result.workers.filter(row => { const spec = specs.find(spec => spec.name === row.name); return !!spec && sourceAllowed(actor, spec.source); });
    if (!sourceAllowed(actor, "notifications")) delete result.notifications;
    return result;
  }
}
