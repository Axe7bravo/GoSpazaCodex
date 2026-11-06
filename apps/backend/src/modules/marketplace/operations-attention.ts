import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { AttentionPage, OperationalAttention, OperationsSource } from "@gospaza/contracts";
import { diagnosticTime, operationsCursor, operationsLink, operationsPage, readOperationsCursor, safeOperationReason } from "./operations-policy";

interface Row { key: string; record_id: string; reference: string; status: string; reason: string | null; at: Date | string | null }
const labels: Record<OperationsSource, { domain: string; type: string; summary: string }> = {
  orders: { domain: "ORDER_OPERATIONS", type: "ORDER", summary: "Merchant action or operational handoff requires review." },
  deliveries: { domain: "DELIVERY", type: "DELIVERY", summary: "Delivery state requires operational review." },
  recovery: { domain: "PAYMENT", type: "CHECKOUT", summary: "Checkout completion evidence requires review; no order outcome is inferred." },
  adjustments: { domain: "FINANCE", type: "FINANCIAL_ADJUSTMENT", summary: "Adjustment entitlement or settlement requires review." },
  credit: { domain: "FINANCE", type: "STORE_CREDIT_OPERATION", summary: "Native credit settlement is not yet confirmed." },
  inventory: { domain: "INVENTORY", type: "DISPOSITION", summary: "Returned inventory disposition requires review; do not restock again blindly." },
  recognition: { domain: "MARKETPLACE_FINANCE", type: "FINANCE_EXCEPTION", summary: "Immutable economic evidence requires review." },
  settlements: { domain: "SETTLEMENT", type: "MERCHANT_SETTLEMENT", summary: "Statement holds, failure or discrepancy require review." },
  driver_payments: { domain: "DRIVER_FINANCE", type: "DRIVER_PAYMENT", summary: "Recorded transfer outcome or reconciliation requires review." },
  driver_recognition: { domain: "DRIVER_FINANCE", type: "EARNING_EXCEPTION", summary: "Delivery earning evidence requires review." },
  compensation: { domain: "DRIVER_COMPENSATION", type: "COMPENSATION_EXCEPTION", summary: "Assignment compensation requires evidence review; no earning is inferred." },
  notifications: { domain: "NOTIFICATION", type: "NOTIFICATION", summary: "Inspect transport status; it does not change the business outcome." },
  merchant_review: { domain: "MARKETPLACE", type: "MERCHANT_APPLICATION", summary: "Submitted merchant application requires review." },
  driver_review: { domain: "DRIVER", type: "DRIVER", summary: "Driver review or requested changes remain outstanding." },
  restricted_review: { domain: "COMPLIANCE", type: "REGISTRATION", summary: "Store supply authorization requires review." },
};
// Persistence lives in Marketplace today. These finite owner projections read
// only that module's authoritative records; the orchestrator never joins them.
// There are no ensure/observe/native-provider calls or writes in these adapters.
export class OperationsAttentionRead {
  constructor(private readonly db: Knex) {}
  private query(source: OperationsSource): { query: Knex.QueryBuilder; key: string } {
    const d = this.db;
    switch (source) {
      case "orders": return { key: "c.id", query: d("checkout_completion as c").leftJoin("order_operation as o", "o.checkout_completion_id", "c.id")
        .where({ "c.state": "SUCCEEDED", "c.native_state": "done" }).whereNotNull("c.order_id").whereNotNull("c.terminal_receipt").whereNull("c.deleted_at")
        .where(q => q.whereNull("o.id").orWhere("o.status", "PENDING_ACCEPTANCE"))
        .select("c.id as key", "c.order_id as record_id", "c.order_id as reference", "c.created_at as at")
        .select(d.raw("coalesce(o.status, 'UNPROVEN_OPERATION') as status, null::text as reason")) };
      case "deliveries": return { key: "d.id", query: d("delivery_operation as d").whereNull("d.deleted_at").where(q => q.where("d.status", "ATTENTION_REQUIRED")
        .orWhereExists(d("pickup_operation as p").select("p.id").whereRaw("p.delivery_id=d.id").where("p.state", "RECOVERY_REQUIRED"))
        .orWhereExists(d("delivery_completion as c").select("c.id").whereRaw("c.delivery_id=d.id").where("c.state", "RECOVERY_REQUIRED")))
        .select("d.id as key", "d.id as record_id", "d.medusa_order_id as reference", "d.status", "d.reason", "d.created_at as at") };
      case "recovery": return { key: "a.id", query: d("checkout_attempt as a").whereNull("a.deleted_at").where(q => q.where("a.state", "RECOVERY_REQUIRED")
        .orWhereExists(d("checkout_completion as c").select("c.id").whereRaw("c.checkout_attempt_id=a.id").whereIn("c.state", ["DISPATCHED", "RECOVERY_REQUIRED"])))
        .select("a.id as key", "a.id as record_id", "a.id as reference", "a.state as status", "a.created_at as at").select(d.raw("null::text as reason")) };
      case "adjustments": return { key: "a.id", query: d("financial_adjustment as a").whereNull("a.deleted_at").where(q => q.whereIn("a.status", ["REVIEW_REQUIRED", "ATTENTION_REQUIRED"])
        .orWhereExists(d("refund_operation as r").select("r.id").whereRaw("r.adjustment_id=a.id").whereNot("r.status", "SETTLED")))
        .select("a.id as key", "a.id as record_id", "a.medusa_order_id as reference", "a.status", "a.created_at as at").select(d.raw("null::text as reason")) };
      case "credit": return { key: "c.id", query: d("store_credit_operation as c").whereNot("c.status", "SETTLED")
        .select("c.id as key", "c.id as record_id", "c.order_id as reference", "c.status", "c.created_at as at").select(d.raw("null::text as reason")) };
      case "inventory": return { key: "i.id", query: d("returned_inventory_disposition as i").whereIn("i.status", ["DISPATCHED", "ATTENTION_REQUIRED"])
        .select("i.id as key", "i.id as record_id", "i.order_id as reference", "i.status", "i.created_at as at").select(d.raw("null::text as reason")) };
      case "recognition": return { key: "e.id", query: d("order_finance_exception as e").join("order_finance_snapshot as s", "s.id", "e.snapshot_id")
        .select("e.id as key", "e.id as record_id", "s.order_id as reference", "e.reason", "e.recorded_at as at").select(d.raw("'UNRESOLVED'::text as status")) };
      case "settlements": return { key: "s.id", query: d("merchant_period_statement as s").leftJoin("payable_settlement as p", "p.statement_id", "s.id")
        .whereNull("s.superseded_by").where(q => q.where("p.status", "FAILED")
          .orWhereExists(d("merchant_settlement_discrepancy as e").select("e.id").whereRaw("e.payable_id=p.id").where("e.status", "OPEN"))
          .orWhereExists(d("settlement_exclusion as e").select("e.statement_id").whereRaw("e.statement_id=s.id")))
        .select("s.id as key", "s.id as record_id", "s.id as reference", "s.generated_at as at").select(d.raw("coalesce(p.status,s.status) as status,null::text as reason")) };
      case "driver_payments": return { key: "p.id", query: d("driver_payment as p").leftJoin("driver_payment_resolution as r", "r.payment_id", "p.id")
        .where(q => q.whereExists(d("driver_payment_discrepancy as e").select("e.id").whereRaw("e.payment_id=p.id"))
          .orWhere(b => b.where("p.initial_outcome", "UNKNOWN").whereNull("r.payment_id"))
          .orWhere(b => b.where(q => q.where("p.initial_outcome", "PAID").orWhere("r.outcome", "CONFIRMED_PAID"))
            .whereNotExists(d("driver_payment_reconciliation as rc").select("rc.payment_id").whereRaw("rc.payment_id=p.id"))))
        .select("p.id as key", "p.id as record_id", "p.id as reference", "p.recorded_at as at")
        .select(d.raw("case when exists(select 1 from driver_payment_discrepancy e where e.payment_id=p.id) then 'DISCREPANCY' when p.initial_outcome='UNKNOWN' and r.payment_id is null then 'UNKNOWN_OUTCOME' else 'AWAITING_RECONCILIATION' end as status,null::text as reason")) };
      case "driver_recognition": return { key: "e.id", query: d("driver_earning_exception as e").select("e.id as key", "e.id as record_id", "e.delivery_id as reference", "e.reason", "e.recorded_at as at").select(d.raw("'UNRESOLVED'::text as status")) };
      case "compensation": return { key: "e.id", query: d("driver_compensation_exception as e").select("e.id as key", "e.id as record_id", "e.commitment_id as reference", "e.reason", "e.recorded_at as at").select(d.raw("'REVIEW_REQUIRED'::text as status")) };
      case "notifications": return { key: "i.id", query: d("notification_intent as i").join("notification_delivery as n", "n.intent_id", "i.id")
        .whereIn("n.state", ["ATTENTION_REQUIRED", "TERMINAL_FAILURE", "RETRYABLE_FAILURE", "SUPPRESSED"])
        .select("i.id as key", "i.id as record_id", "i.id as reference", "n.state as status", "i.created_at as at").select(d.raw("null::text as reason")) };
      case "merchant_review": return { key: "a.id", query: d("merchant_application as a").whereNull("a.deleted_at")
        .whereIn("a.status", ["SUBMITTED", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED"])
        .select("a.id as key", "a.id as record_id", "a.id as reference", "a.status", "a.created_at as at").select(d.raw("null::text as reason")) };
      case "driver_review": return { key: "p.id", query: d("driver_profile as p").whereNull("p.deleted_at").whereIn("p.status", ["PENDING_REVIEW", "CHANGES_REQUIRED"])
        .select("p.id as key", "p.id as record_id", "p.id as reference", "p.status", "p.created_at as at").select(d.raw("null::text as reason")) };
      case "restricted_review": return { key: "r.id", query: d("restricted_registration as r").whereNull("r.deleted_at").whereIn("r.status", ["PENDING_REVIEW", "CHANGES_REQUIRED", "SUSPENDED", "REVOKED"])
        .select("r.id as key", "r.id as record_id", "r.merchant_store_id as reference", "r.status", "r.created_at as at").select(d.raw("null::text as reason")) };
    }
  }
  async page(source: OperationsSource, value: unknown): Promise<AttentionPage> {
    const input = operationsPage.parse(value), after = readOperationsCursor("attention:" + source, input.cursor), { query, key } = this.query(source);
    if (after) query.where(key, ">", after);
    const rows = await query.orderBy(key).limit(input.limit + 1) as Row[], selected = rows.slice(0, input.limit), hasMore = rows.length > input.limit;
    const label = labels[source];
    const items: OperationalAttention[] = selected.map(row => ({ domain: label.domain, record_type: label.type, record_id: row.record_id,
      reference: row.reference, category: source, status: row.status, reason_code: safeOperationReason(row.reason), created_at: diagnosticTime(row.at),
      economic_at: null, summary: label.summary, link: source === "merchant_review" ? "/admin/merchant-applications/" + encodeURIComponent(row.record_id)
        : ["ORDER", "DELIVERY", "FINANCIAL_ADJUSTMENT", "MERCHANT_SETTLEMENT", "DRIVER_PAYMENT", "NOTIFICATION", "DRIVER"].includes(label.type)
          ? operationsLink(label.type as Parameters<typeof operationsLink>[0], row.record_id) : null }));
    const dates = items.flatMap(item => item.created_at ? [item.created_at] : []).sort(), last = selected.at(-1);
    return { source, observed_at: new Date().toISOString(), items, next_cursor: hasMore && last ? operationsCursor("attention:" + source, last.key) : null,
      has_more: hasMore, page_count: items.length, oldest_in_sample: dates[0] ?? null };
  }
}
