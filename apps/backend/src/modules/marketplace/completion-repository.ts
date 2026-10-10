import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Attempt } from "./checkout-repository";
import type { CompletionRow } from "./reconciliation-types";
import { fingerprint } from "../yoco/request";

export const completionInputFingerprint = (cartId: string) => fingerprint(JSON.stringify({ id: cartId }));

// Caller holds the customer advisory boundary. Each write commits BEFORE any
// native dispatch. A process dying after claim loses availability, never safety.
export async function designateCompletion(db: Knex, attempt: Attempt, operationId: string) {
  await db("checkout_completion").insert({ id: "cpl_" + randomUUID(), checkout_attempt_id: attempt.id,
    operation_id: operationId, workflow_id: "complete-cart", transaction_id: "gospaza_" + randomUUID(),
    input_fingerprint: completionInputFingerprint(attempt.medusa_cart_id), state: "READY",
  }).onConflict("checkout_attempt_id").ignore();
  const row = await db<CompletionRow>("checkout_completion").where({ checkout_attempt_id: attempt.id }).first();
  if (!row || row.operation_id !== operationId || row.input_fingerprint !== completionInputFingerprint(attempt.medusa_cart_id)) {
    throw new Error("COMPLETION_IDENTITY_CONFLICT");
  }
  return row;
}
export async function claimCompletion(db: Knex, id: string) {
  const rows = await db<CompletionRow>("checkout_completion").where({ id, state: "READY" }).whereNull("dispatched_at")
    .update({ state: "DISPATCHED", dispatched_at: db.fn.now(), updated_at: db.fn.now() }).returning("*");
  return rows[0];
}
export async function requireCompletionRecovery(db: Knex, attemptId: string, reason: string) {
  await db.transaction(async (trx) => {
    await trx("checkout_completion").where({ checkout_attempt_id: attemptId }).whereNot({ state: "SUCCEEDED" })
      .whereNotNull("dispatched_at").update({ state: "RECOVERY_REQUIRED", recovery_reason: reason, updated_at: trx.fn.now() });
    await trx("checkout_attempt").where({ id: attemptId, closed_at: null })
      .update({ state: "RECOVERY_REQUIRED", updated_at: trx.fn.now() });
  });
}
