import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { OperationalTimelinePage, OperationsTimelineSource } from "@gospaza/contracts";
import { diagnosticTime, operationsCursor, readOperationsCursor } from "./operations-policy";

// All event bodies/notes/request/evidence fields are deliberately unselected.
export class OperationsTimelineRead {
  constructor(private readonly db: Knex) {}
  async page(order: string, delivery: string | null, source: OperationsTimelineSource, limit: number, cursor?: string): Promise<OperationalTimelinePage> {
    const d = this.db; let query: Knex.QueryBuilder;
    switch (source) {
      case "decision": query = d("order_decision_event as e").join("order_operation as o", "o.id", "e.order_operation_id").where("o.medusa_order_id", order)
        .select("e.id", "e.decided_at as at"); break;
      case "picking": query = d("pick_event as e").join("pick_session as p", "p.id", "e.pick_session_id").join("order_operation as o", "o.id", "p.order_operation_id")
        .where("o.medusa_order_id", order).select("e.id", "e.occurred_at as at"); break;
      case "delivery": query = d("dispatch_event as e").where({ "e.target_type": "DELIVERY", "e.target_id": delivery ?? "no_delivery" }).select("e.id", "e.occurred_at as at"); break;
      case "compliance": query = d("restricted_event as e").where(q => q.where("e.target_id", delivery ?? "no_delivery")
        .orWhereIn("e.target_id", d("restricted_return").where({ delivery_id: delivery ?? "no_delivery" }).select("id")))
        .select("e.id", "e.created_at as at"); break;
      case "finance": query = d("financial_adjustment_event as e").join("financial_adjustment as a", "a.id", "e.adjustment_id").where("a.medusa_order_id", order)
        .select("e.id", "e.occurred_at as at"); break;
      case "recognition": query = d("order_finance_exception as e").join("order_finance_snapshot as s", "s.id", "e.snapshot_id").where("s.order_id", order)
        .select("e.id", "e.recorded_at as at"); break;
    }
    const scope = "timeline:" + source + ":" + (delivery ?? order), after = readOperationsCursor(scope, cursor);
    if (after) query.where("e.id", ">", after);
    const rows = await query.orderBy("e.id").limit(limit + 1) as { id: string; at: Date | string }[], page = rows.slice(0, limit), last = page.at(-1);
    const titles: Record<OperationsTimelineSource, string> = { decision: "Merchant decision recorded", picking: "Picking event recorded", delivery: "Delivery event recorded",
      compliance: "Restricted custody event recorded", finance: "Adjustment event recorded", recognition: "Recognition review recorded" };
    return { source, items: page.map(row => ({ id: source + ":" + row.id, domain: source, timestamp: diagnosticTime(row.at) ?? "",
      label: titles[source], actor: "NOT_PROJECTED", summary: titles[source] })),
      next_cursor: rows.length > limit && last ? operationsCursor(scope, last.id) : null, has_more: rows.length > limit };
  }
}
