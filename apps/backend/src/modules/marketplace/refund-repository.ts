import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { refundConflict, type RefundRow } from "./refund-policy";

export async function assertCheckoutRefundAvailable(trx: Knex.Transaction, providerOperation: string, except = "") {
  const busy = await trx("refund_operation").where({ provider_operation_id: providerOperation }).whereNot({ id: except })
    .whereNotIn("status", ["SETTLED", "FAILED_NOT_CREATED", "FAILED"]).first();
  if (busy) throw refundConflict();
}

export async function refundEvent(trx: Knex.Transaction, row: RefundRow, action: string, actor: string | null) {
  await trx("refund_event").insert({ id: "rfev_" + randomUUID(), refund_operation_id: row.id,
    revision: row.revision, action, actor_id: actor, status: row.status,
    evidence: JSON.stringify({ adjustment_id: row.adjustment_id, order_id: row.order_id, customer_id: row.customer_id,
      merchant_id: row.merchant_id, store_id: row.store_id, amount_minor: Number(row.amount_minor), currency: row.currency,
      attempt_id: row.current_attempt_id, attention_reason: row.attention_reason }) });
}
export async function updateRefund(trx: Knex.Transaction, row: RefundRow, patch: Partial<RefundRow>, action: string, actor: string | null = null) {
  const [updated] = await trx<RefundRow>("refund_operation").where({ id: row.id, revision: row.revision })
    .update({ ...patch, revision: row.revision + 1, updated_at: trx.fn.now() }).returning("*");
  if (!updated) throw refundConflict();
  await refundEvent(trx, updated, action, actor);
  return updated;
}
// No network work is performed while this boundary is held. Payment/provider
// serialization precedes adjustment and operation locks everywhere in C1.
export async function withRefund<T>(db: Knex, id: string, work: (trx: Knex.Transaction, row: RefundRow) => Promise<T>) {
  const initial = await db<RefundRow>("refund_operation").where({ id }).first();
  if (!initial) throw refundConflict();
  return db.transaction(async trx => {
    await trx("provider_operation").where({ id: initial.provider_operation_id }).forUpdate().first();
    await trx("financial_adjustment").where({ id: initial.adjustment_id }).forUpdate().first();
    const row = await trx<RefundRow>("refund_operation").where({ id }).forUpdate().first();
    if (!row) throw refundConflict();
    return work(trx, row);
  });
}
