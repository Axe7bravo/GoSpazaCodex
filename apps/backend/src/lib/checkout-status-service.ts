import type { ICartModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import type { CustomerCheckoutStatus } from "@gospaza/contracts";
import { cartOperation } from "./cart-lock";
import { checkoutId, checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import { currentCheckout } from "../modules/marketplace/checkout-repository";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import type { CompletionRow } from "../modules/marketplace/reconciliation-types";
import { verifiedPayment } from "../modules/yoco/webhook";
import { schedulingInput } from "../modules/marketplace/scheduling-policy";

const inputSchema = z.object({ attempt_id: checkoutId.optional() }).strict();
const empty: CustomerCheckoutStatus = { attempt: null, state: "none", order_id: null, delivery_window: null };

// Display evidence only. This never dispatches/retries completion or initiates payment.
export function customerCheckoutOutcome(
  attempt: Pick<Attempt, "state" | "closed_at" | "payment_accepted_at">,
  operation?: Pick<OperationRow, "state" | "verified_payment" | "terminal_refunded">,
  completion?: Pick<CompletionRow, "state" | "order_id" | "terminal_receipt" | "dispatched_at">,
): CustomerCheckoutStatus["state"] {
  if (attempt.state === "RECOVERY_REQUIRED") return "recovery_required";
  if (completion?.state === "SUCCEEDED" && completion.order_id && completion.terminal_receipt
    && attempt.state === "COMPLETED") return "succeeded";
  if (attempt.state === "COMPLETED") return "recovery_required";
  if (operation?.terminal_refunded) return "refunded";
  const evidence = operation?.verified_payment ? verifiedPayment.parse(operation.verified_payment) : null;
  if (evidence?.type === "payment.succeeded") return attempt.closed_at ? "refund_pending" : "reconciliation_pending";
  if (attempt.state === "EXPIRED") return "expired";
  if (attempt.state === "FAILED") return "failed";
  if (attempt.state === "ABANDONED") return "abandoned";
  if (attempt.payment_accepted_at || completion?.dispatched_at || (operation && ["sending", "uncertain", "mismatch"].includes(operation.state))) return "reconciliation_pending";
  return attempt.state === "CONFIRMED" ? "ready_to_pay" : "awaiting_payment";
}

export class CheckoutStatusService {
  constructor(private container: MedusaContainer, private customerId: string) {}

  async read(value: unknown): Promise<CustomerCheckoutStatus> {
    const input = schedulingInput(inputSchema, value);
    return cartOperation(this.container, this.customerId, async () => {
      const db = this.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
      // Native customer ownership is still authoritative for completed/historical carts.
      const carts = await this.container.resolve<ICartModuleService>(Modules.CART)
        .listCarts({ customer_id: this.customerId }, { select: ["id"], take: null });
      const query = db<Attempt>("checkout_attempt").whereIn("medusa_cart_id", carts.map((cart) => cart.id)).whereNull("deleted_at");
      let attempt = input.attempt_id
        ? await query.where({ id: input.attempt_id }).first()
        : await query.orderByRaw("closed_at IS NULL DESC").orderBy("created_at", "desc").orderBy("id", "desc").first();
      if (!attempt) {
        if (input.attempt_id) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Checkout unavailable.");
        return empty;
      }
      // Use the existing deadline/locking owner; browser clocks do not expire attempts.
      await currentCheckout(db, attempt.cart_context_id);
      attempt = await db<Attempt>("checkout_attempt").where({ id: attempt.id }).whereNull("deleted_at").first();
      if (!attempt) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Checkout unavailable.");
      const snapshot = checkoutSnapshot.parse(attempt.snapshot);
      if (snapshot.customer_id !== this.customerId || snapshot.cart_id !== attempt.medusa_cart_id) {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, "Checkout unavailable.");
      }
      const operation = await db<OperationRow>("provider_operation").where({ checkout_attempt_id: attempt.id }).whereNull("deleted_at").first();
      const completion = await db<CompletionRow>("checkout_completion").where({ checkout_attempt_id: attempt.id }).whereNull("deleted_at").first();
      const state = customerCheckoutOutcome(attempt, operation, completion);
      const window = await db<{ start_at: Date | string; end_at: Date | string }>("delivery_reservation as hold").join("delivery_slot as slot", "slot.id", "hold.delivery_slot_id")
        .where({ "hold.id": attempt.reservation_id, "hold.cart_context_id": attempt.cart_context_id })
        .select("slot.start_at", "slot.end_at").first();
      return {
        state, order_id: state === "succeeded" ? completion?.order_id ?? null : null,
        delivery_window: window ? { start_at: new Date(window.start_at).toISOString(), end_at: new Date(window.end_at).toISOString() } : null,
        attempt: { id: attempt.id, state: attempt.state,
          ...(attempt.payment_deadline ? { payment_deadline: new Date(attempt.payment_deadline).toISOString() } : {}),
          quote: { cart_id: snapshot.cart_id, address_id: snapshot.address_id, address: snapshot.address,
            checkout_revision: attempt.checkout_revision, expires_at: new Date(attempt.expires_at).toISOString(),
            currency_code: snapshot.currency_code, totals: snapshot.totals } },
      };
    });
  }
}