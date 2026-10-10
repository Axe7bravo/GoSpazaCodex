import type { InferTypeOf } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { MedusaError } from "@medusajs/framework/utils";
import type { Hold } from "./delivery-reservation-repository";
import type CheckoutAttempt from "./models/checkout-attempt";
import { databaseTime, lockSlots, finishHold } from "./delivery-reservation-repository";

export type Attempt = InferTypeOf<typeof CheckoutAttempt>;

// Caller owns the customer advisory lock. PAYMENT_PENDING has its own immutable
// deadline. Capacity reads independently ignore expired commitments.
export async function currentCheckout(db: Knex, contextId: string): Promise<Attempt | undefined> {
  return db.transaction(async (trx) => {
    const attempt = await trx<Attempt>("checkout_attempt")
      .where({ cart_context_id: contextId }).whereNull("closed_at").forUpdate().first();
    if (!attempt) return undefined;
    // Durable acceptance/recovery outlives native workflow history and deadlines.
    if (attempt.payment_accepted_at || attempt.state === "RECOVERY_REQUIRED") return attempt;
    const hold = await trx<Hold>("delivery_reservation")
      .where({ id: attempt.reservation_id, cart_context_id: contextId }).whereNull("deleted_at").first();
    if (attempt.state === "PAYMENT_PENDING" && hold) await lockSlots(trx, [hold.delivery_slot_id]);
    const now = await databaseTime(trx);
    const effective = attempt.state === "PAYMENT_PENDING"
      ? !!hold && hold.status === "PAYMENT_PENDING" && !!attempt.payment_deadline
        && !!hold.payment_deadline && new Date(attempt.payment_deadline).getTime() === new Date(hold.payment_deadline).getTime()
        && new Date(attempt.payment_deadline) > now
      : !!hold && hold.status === "HELD" && new Date(hold.expires_at) > now && new Date(attempt.expires_at) > now;
    if (!effective) {
      // An inconsistent live commitment is recovery-required, not permission
      // to unfreeze a possibly payable cart.
      if (attempt.state === "PAYMENT_PENDING" && attempt.payment_deadline && new Date(attempt.payment_deadline) > now) {
        throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_REFRESH_REQUIRED");
      }
      if (hold?.status === "PAYMENT_PENDING") await finishHold(trx, hold, now, "PAYMENT_DEADLINE");
      await trx("checkout_attempt").where({ id: attempt.id, closed_at: null })
        .update({ state: "EXPIRED", closed_at: now, updated_at: now });
      return undefined;
    }
    return attempt;
  });
}

export async function assertCheckoutMutable(db: Knex, contextId: string): Promise<void> {
  if (await currentCheckout(db, contextId)) {
    throw new MedusaError(MedusaError.Types.CONFLICT, "CHECKOUT_FROZEN");
  }
}
