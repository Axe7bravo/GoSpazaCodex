import { MedusaError } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { InferTypeOf } from "@medusajs/framework/types";
import type Reservation from "./models/delivery-reservation";
import type Slot from "./models/delivery-slot";

export type Hold = InferTypeOf<typeof Reservation>;
export type DeliveryWindow = InferTypeOf<typeof Slot>;

export async function databaseTime(trx: Knex.Transaction) {
  const result = await trx.raw<{ rows: { now: Date }[] }>("select clock_timestamp() as now");
  const now = new Date(result.rows[0]?.now ?? NaN);
  if (!Number.isFinite(now.getTime())) throw new Error("Scheduling database time unavailable.");
  return now;
}

export async function lockSlots(trx: Knex.Transaction, ids: string[]) {
  return trx<DeliveryWindow>("delivery_slot").whereIn("id", [...new Set(ids)].sort()).orderBy("id").forUpdate();
}

export async function selectionRevision(trx: Knex.Transaction, contextId: string) {
  const latest = await trx<Hold>("delivery_reservation").where({ cart_context_id: contextId })
    .orderBy("selection_revision", "desc").first();
  return latest?.selection_revision ?? 0;
}

export async function activeHold(trx: Knex.Transaction, contextId: string) {
  return trx<Hold>("delivery_reservation").where({ cart_context_id: contextId }).whereIn("status", ["HELD", "PAYMENT_PENDING", "COMMITTED"]).first();
}

export async function occupied(trx: Knex.Transaction, slotId: string, now: Date, excludingContext?: string) {
  const query = trx("delivery_reservation as r")
    .join("cart_marketplace_context as c", "c.id", "r.cart_context_id")
    .where({ "r.delivery_slot_id": slotId })
    .whereNull("r.deleted_at")
    .where((scope) => scope.where("r.status", "COMMITTED")
      .orWhere((accepted) => accepted.where("r.status", "PAYMENT_PENDING").whereNotNull("r.payment_accepted_at"))
      .orWhere((shopping) => shopping.whereNull("c.superseded_at").whereNull("c.deleted_at")
        .where((active) => active.where((held) => held.where("r.status", "HELD").where("r.expires_at", ">", now))
          .orWhere((pending) => pending.where("r.status", "PAYMENT_PENDING").where("r.payment_deadline", ">", now)))));

  if (excludingContext) query.whereNot("r.cart_context_id", excludingContext);
  const count = await query.count<{ count: string }[]>("r.id as count").first();
  return Number(count?.count ?? 0);
}

// Caller holds the customer lock. Slot locks precede lifecycle writes. This can
// compose with context publication in the same Marketplace transaction.
export async function releaseContextHold(trx: Knex.Transaction, contextId: string, reason: string) {
  const hold = await activeHold(trx, contextId);
  if (!hold) return;
  await lockSlots(trx, [hold.delivery_slot_id]);
  const now = await databaseTime(trx);
  await finishHold(trx, hold, now, reason);
}

export function effectiveExpiry(hold: Hold): Date {
  return new Date(hold.status === "PAYMENT_PENDING" ? hold.payment_deadline ?? NaN : hold.expires_at);
}

export async function finishHold(trx: Knex.Transaction, hold: Hold, now: Date, reason: string) {
  if (hold.payment_accepted_at || hold.status === "COMMITTED" || hold.status === "PAYMENT_PENDING" && effectiveExpiry(hold) > now) {
    throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_FROZEN");
  }
  const revision = await selectionRevision(trx, hold.cart_context_id);
  await trx("delivery_reservation").where({ id: hold.id }).whereIn("status", ["HELD", "PAYMENT_PENDING"]).update({
    status: effectiveExpiry(hold).getTime() <= now.getTime() ? "EXPIRED" : "RELEASED",
    released_at: now, release_reason: reason, selection_revision: revision + 1, updated_at: now,
  });
}

export const reservationId = () => "dhold_" + randomUUID();
