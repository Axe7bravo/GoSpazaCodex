import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { MedusaError } from "@medusajs/framework/utils";
import type { DeliveryDiagnostic, OrderDiagnostic, OperationalLookup, OperationsLookupType } from "@gospaza/contracts";
import type { DeliveryRow, CommitmentRow } from "./dispatch-rows";
import { completedOrderCandidates } from "./order-operation-repository";
import { diagnosticTime, operationsLink, rescuePrecheck, safeOperationReason } from "./operations-policy";
const diagnosticMissing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Operational record unavailable.");
type NativeOrderReader = (id: string) => Promise<{ id: string; status: string; currency_code: string }>;
// Internal owner read port. Authentication/section admission is performed by
// OperationsService before invoking a port. No mutation service is reachable.
export class MarketplaceOperationsRead {
  constructor(readonly db: Knex, private readonly nativeOrder: NativeOrderReader) {}
  async order(id: string): Promise<OrderDiagnostic> {
    let native: Awaited<ReturnType<NativeOrderReader>>;
    try { native = await this.nativeOrder(id); } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND) throw diagnosticMissing(); throw error;
    }
    if (native.id !== id) throw diagnosticMissing();
    const op = await this.db("order_operation").where({ medusa_order_id: id }).whereNull("deleted_at").first("id", "status", "revision", "accepted_at", "rejected_at", "merchant_id", "merchant_store_id", "checkout_completion_id");
    // Reuse the owner's canonical verified-handoff selector but do not hydrate
    // its private checkout snapshot, contact, money or terminal receipt.
    const handoffs = await completedOrderCandidates(this.db).where("c.order_id", id)
      .select("c.id as completion_id", "x.merchant_id", "x.merchant_store_id").limit(2);
    const handoff = handoffs.length === 1 ? handoffs[0] : undefined;
    const verified = native.status !== "canceled" && !!handoff && (!op || op.checkout_completion_id === handoff.completion_id && op.merchant_id === handoff.merchant_id && op.merchant_store_id === handoff.merchant_store_id);
    const store = op ? await this.db("merchant_store").where({ id: op.merchant_store_id, merchant_id: op.merchant_id }).whereNull("deleted_at").first("id", "merchant_id", "name") : undefined;
    const picking = op ? await this.db("pick_session").where({ order_operation_id: op.id }).whereNull("deleted_at").first("status", "revision", "completed_at") : undefined;
    return { unavailable_sections: [], order: { id: native.id, status: native.status, currency: native.currency_code }, handoff: verified ? "VERIFIED" : "UNPROVEN",
      operation: op ? { id: String(op.id), status: String(op.status), revision: Number(op.revision), accepted_at: diagnosticTime(op.accepted_at), rejected_at: diagnosticTime(op.rejected_at) } : null,
      store: store ? { merchant_id: String(store.merchant_id), store_id: String(store.id), name: String(store.name) } : null,
      picking: picking ? { status: String(picking.status), revision: Number(picking.revision), completed_at: diagnosticTime(picking.completed_at) } : null };
  }
  async delivery(id: string): Promise<DeliveryDiagnostic> {
    const d = await this.db<DeliveryRow>("delivery_operation").where({ id }).whereNull("deleted_at").first(); if (!d) throw diagnosticMissing();
    const commitment = await this.db<CommitmentRow>("dispatch_commitment").where({ delivery_id: id })
      .orderByRaw("case when status in ('OFFERED','ASSIGNED') then 0 else 1 end").orderBy("generation", "desc").orderBy("id").first();
    const pickup = await this.db("pickup_operation").where({ delivery_id: id }).orderBy("id").limit(3).select("action", "state");
    const completion = await this.db("delivery_completion").where({ delivery_id: id }).first("state");
    const returned = await this.db("restricted_return").where({ delivery_id: id }).first("state");
    const history = this.db("dispatch_commitment").where({ delivery_id: id });
    const active = !!await history.clone().whereIn("status", ["OFFERED", "ASSIGNED"]).first("id");
    const assigned = !!await history.clone().where(q => q.whereNotNull("assigned_at").orWhereIn("status", ["ASSIGNED", "COMPLETED", "RETURNED"])).first("id");
    const invalid = !!await history.clone().where(q => q.whereNotIn("status", ["DECLINED", "EXPIRED", "CANCELLED"]).orWhereNull("decided_at")
      .orWhereNotExists(this.db("dispatch_event as closure").select("closure.id").where("closure.target_type", "DELIVERY")
        .whereRaw("closure.target_id=dispatch_commitment.delivery_id and closure.action=dispatch_commitment.status and closure.evidence->>'commitment_id'=dispatch_commitment.id"))).first("id");
    const snapshot = !!await this.db("driver_compensation_snapshot").where({ delivery_id: id }).first("id");
    const custody = !!returned || !!await this.db("handoff_generation").where({ delivery_id: id }).first("id") || !!await this.db("recipient_compliance").where({ delivery_id: id }).first("id");
    const binding = await this.db("order_operation as o").join("pick_session as p", "p.order_operation_id", "o.id")
      .join("delivery_reservation as r", "r.medusa_order_id", "o.medusa_order_id").join("merchant_store as s", "s.id", "o.merchant_store_id")
      .where({ "o.id": d.order_operation_id, "o.medusa_order_id": d.medusa_order_id, "o.merchant_id": d.merchant_id, "o.merchant_store_id": d.merchant_store_id,
        "o.status": "ACCEPTED", "p.id": d.pick_session_id, "p.status": "COMPLETED", "r.id": d.reservation_id, "r.status": "COMMITTED", "r.merchant_store_id": d.merchant_store_id,
        "s.merchant_id": d.merchant_id }).whereNull("o.deleted_at").whereNull("p.deleted_at").whereNull("r.deleted_at").whereNull("s.deleted_at").first("o.id");
    return { id: d.id, order_id: d.medusa_order_id, merchant_id: d.merchant_id, store_id: d.merchant_store_id, status: d.status,
      revision: d.revision, generation: d.generation, mode: d.mode, path: d.path, reason_code: safeOperationReason(d.reason),
      timing: { dispatch_not_before: diagnosticTime(d.dispatch_not_before), started_at: diagnosticTime(d.started_at), deadline: diagnosticTime(d.deadline),
        picked_up_at: diagnosticTime(d.picked_up_at), arrived_at: diagnosticTime(d.arrived_at), delivered_at: diagnosticTime(d.delivered_at) },
      commitment: commitment ? { id: commitment.id, status: commitment.status, driver_profile_id: commitment.driver_profile_id,
        expires_at: diagnosticTime(commitment.expires_at), assigned_at: diagnosticTime(commitment.assigned_at) } : null,
      pickup: pickup.map(row => ({ action: String(row.action), state: String(row.state) })), completion_state: completion ? String(completion.state) : null,
      return_state: returned ? String(returned.state) : null,
      rescue: rescuePrecheck({ ...d, binding_proven: !!binding, active, assigned, history_invalid: invalid, native_operations: !!pickup.length || !!completion, custody, snapshot }) };
  }
  async finance(order: string): Promise<NonNullable<OrderDiagnostic["finance"]>> {
    const rows = await this.db("financial_adjustment as a").leftJoin("refund_operation as r", "r.adjustment_id", "a.id")
      .leftJoin("store_credit_operation as c", "c.adjustment_id", "a.id").where("a.medusa_order_id", order).whereNull("a.deleted_at")
      .orderBy("a.id").limit(26).select("a.id", "a.reason", "a.status", "a.amount_minor", "a.currency", "a.default_method", "r.status as refund_state", "c.status as credit_state");
    return { items: rows.slice(0, 25).map(row => ({ id: String(row.id), reason: String(row.reason), status: String(row.status), amount_minor: String(row.amount_minor),
      currency: String(row.currency), method: String(row.default_method), refund_state: row.refund_state == null ? null : String(row.refund_state), credit_state: row.credit_state == null ? null : String(row.credit_state) })), truncated: rows.length > 25 };
  }
  async lookup(type: OperationsLookupType, id: string): Promise<OperationalLookup> {
    let row: { id: string; status: string } | undefined;
    switch (type) {
      case "ORDER": { const value = await this.order(id); row = { id: value.order.id, status: value.operation?.status ?? "UNPROVEN_OPERATION" }; break; }
      case "DELIVERY": row = await this.db("delivery_operation").where({ id }).whereNull("deleted_at").first("id", "status"); break;
      case "MERCHANT": row = await this.db("merchant").where({ id }).whereNull("deleted_at").first("id", "status"); break;
      case "DRIVER": row = await this.db("driver_profile").where({ id }).whereNull("deleted_at").first("id", "status"); break;
      case "FINANCIAL_ADJUSTMENT": row = await this.db("financial_adjustment").where({ id }).whereNull("deleted_at").first("id", "status"); break;
      case "MERCHANT_SETTLEMENT": row = await this.db("merchant_period_statement").where({ id }).first("id", "status"); break;
      case "DRIVER_PAYMENT": row = await this.db("driver_payment as p").where("p.id", id).first("p.id", this.db.raw("case when exists(select 1 from driver_payment_reconciliation r where r.payment_id=p.id) then 'RECONCILED' when exists(select 1 from driver_payment_resolution r where r.payment_id=p.id and r.outcome='CONFIRMED_NOT_PAID') then 'CONFIRMED_NOT_PAID' when p.initial_outcome='PAID' or exists(select 1 from driver_payment_resolution r where r.payment_id=p.id and r.outcome='CONFIRMED_PAID') then 'PAYMENT_RECORDED' else 'UNDER_REVIEW' end as status")); break;
      case "NOTIFICATION": row = await this.db("notification_intent as i").join("notification_delivery as d", "d.intent_id", "i.id").where("i.id", id).first("i.id", "d.state as status"); break;
    }
    if (!row) throw diagnosticMissing();
    return { type, id: String(row.id), reference: String(row.id), status: String(row.status), link: operationsLink(type, id) };
  }
}
