import type { Knex } from "@medusajs/framework/mikro-orm/knex";
// Caller supplies only invocation-owned Order IDs, while holding their merchant locks.
export async function cleanupShortages(trx: Knex.Transaction, orderIds: string[]) {
  const operations = trx("order_operation").select("id").whereIn("medusa_order_id", orderIds);
  await trx("shortage_event").whereIn("order_operation_id", operations).delete();
  await trx("shortage_resolution").whereIn("order_operation_id", operations).delete();
  await trx("order_shortage_preference").whereIn("order_operation_id", operations).delete();
}
