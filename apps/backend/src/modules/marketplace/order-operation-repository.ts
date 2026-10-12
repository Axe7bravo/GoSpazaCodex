import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { InferTypeOf } from "@medusajs/framework/types";
import type OrderOperation from "./models/order-operation";
import { completedOrderHandoff, orderUnavailable } from "./order-operation-policy";
import type { CompletedOrderHandoff } from "./order-operation-policy";
import { randomUUID } from "node:crypto";

export type OrderOperationRow = InferTypeOf<typeof OrderOperation>;
export type OrderTenant = { merchant: { id: string }; store: { id: string } };
export type OrderDatabase = Knex | Knex.Transaction;

// All joined persistence belongs to Marketplace. No native commerce SQL.
export function completedOrderCandidates(db: OrderDatabase, tenant?: OrderTenant) {
  const query = db("checkout_completion as c")
    .join("checkout_attempt as a", "a.id", "c.checkout_attempt_id")
    .join("delivery_reservation as r", "r.id", "a.reservation_id")
    .join("cart_marketplace_context as x", "x.id", "a.cart_context_id")
    .join("merchant_store as s", function () { this.on("s.id", "x.merchant_store_id").andOn("s.merchant_id", "x.merchant_id"); })
    .where({ "c.state": "SUCCEEDED", "a.state": "COMPLETED", "c.native_state": "done" })
    .where((capacity) => capacity.where("r.status", "COMMITTED").orWhere((released) => released
      .where({ "r.status": "RELEASED", "r.release_reason": "ORDER_REJECTED" })
      .whereExists(db("order_operation as rejected")
        .join("order_decision_event as decision", "decision.order_operation_id", "rejected.id")
        .select("rejected.id")
        .whereRaw("rejected.checkout_completion_id = c.id and rejected.medusa_order_id = c.order_id")
        .whereRaw("rejected.merchant_id = x.merchant_id and rejected.merchant_store_id = x.merchant_store_id")
        .where({ "rejected.status": "REJECTED", "decision.to_status": "REJECTED" })
        .whereRaw("rejected.rejected_at = r.released_at and decision.decided_at = r.released_at")
        .whereNull("rejected.deleted_at").whereNull("decision.deleted_at"))))
    .whereNotNull("c.terminal_receipt").whereNotNull("c.order_id").whereNotNull("a.closed_at").whereNotNull("a.payment_accepted_at").whereNotNull("r.payment_accepted_at")
    .whereRaw("r.medusa_order_id = c.order_id and r.cart_context_id = x.id and r.merchant_store_id = s.id and a.medusa_cart_id = x.medusa_cart_id")
    .whereNull("c.deleted_at").whereNull("a.deleted_at").whereNull("r.deleted_at").whereNull("x.deleted_at").whereNull("s.deleted_at");
  if (tenant) query.where({ "x.merchant_id": tenant.merchant.id, "x.merchant_store_id": tenant.store.id });
  return query;
}
export function selectHandoff(query: ReturnType<typeof completedOrderCandidates>) {
  return query.select("c.id as completion_id", "c.order_id", "c.terminal_receipt", "a.snapshot",
    "c.workflow_id", "c.transaction_id", "c.execution_id", "c.run_id",
    "x.medusa_cart_id as cart_id", "x.id as context_id", "x.merchant_id", "x.merchant_store_id",
    "r.id as reservation_id", "r.delivery_slot_id as slot_id");
}
export async function readOrderHandoff(db: OrderDatabase, orderId: string, tenant?: OrderTenant): Promise<CompletedOrderHandoff | null> {
  const rows: unknown[] = await selectHandoff(completedOrderCandidates(db, tenant).where("c.order_id", orderId)).limit(2);
  if (!rows.length) return null;
  if (rows.length !== 1) throw orderUnavailable();
  return completedOrderHandoff(rows[0]);
}
export async function insertOrderOperation(db: OrderDatabase, handoff: CompletedOrderHandoff): Promise<OrderOperationRow> {
  // Avoid INSERT triggers for an already-authorized historical rejection.
  const existing = await db<OrderOperationRow>("order_operation").where({ medusa_order_id: handoff.order_id }).first();
  if (!existing) await db("order_operation").insert({ id: "oop_" + randomUUID(), medusa_order_id: handoff.order_id,
    checkout_completion_id: handoff.completion_id, merchant_id: handoff.merchant_id, merchant_store_id: handoff.merchant_store_id })
    .onConflict("medusa_order_id").ignore();
  const row = await db<OrderOperationRow>("order_operation").where({ medusa_order_id: handoff.order_id }).first();
  if (!row || row.deleted_at || row.checkout_completion_id !== handoff.completion_id
    || row.merchant_id !== handoff.merchant_id || row.merchant_store_id !== handoff.merchant_store_id) throw orderUnavailable();
  return row;
}
