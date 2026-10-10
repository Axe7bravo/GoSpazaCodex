import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { CheckoutConfirmation, CheckoutQuote } from "@gospaza/contracts";
import { CartFoundationService } from "./cart-service";
import { DeliveryReservationService } from "./delivery-reservation-service";
import { commerceLock } from "./commerce";
import { refreshCheckoutCart, nativeCheckoutTotals, nativeCheckoutItems, ownedCheckoutAddress, requireUnpaidCart } from "./checkout-native";
import { checkoutAbandonInput, checkoutConfirmInput, checkoutId, checkoutPrepareInput,
  checkoutReadInput, checkoutRevision, checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import type { CheckoutSnapshot } from "../modules/marketplace/checkout-policy";
import { currentCheckout } from "../modules/marketplace/checkout-repository";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { schedulingInput } from "../modules/marketplace/scheduling-policy";

const conflict = (code: string) => new MedusaError(MedusaError.Types.CONFLICT, code);
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Checkout unavailable.");

function quote(snapshot: CheckoutSnapshot, revision: string, expires: Date | string): CheckoutQuote {
  return { address: snapshot.address, cart_id: snapshot.cart_id, address_id: snapshot.address_id,
    checkout_revision: revision, expires_at: new Date(expires).toISOString(),
    currency_code: snapshot.currency_code, totals: snapshot.totals };
}
function confirmation(row: Attempt): CheckoutConfirmation {
  return { id: row.id, state: row.state,
    ...(row.payment_deadline ? { payment_deadline: new Date(row.payment_deadline).toISOString() } : {}),
    quote: quote(checkoutSnapshot.parse(row.snapshot), row.checkout_revision, row.expires_at) };
}

export class CheckoutService {
  private db: Knex;
  private carts: CartFoundationService;
  constructor(private container: MedusaContainer, private customerId: string) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.carts = new CartFoundationService(container, customerId);
  }

  async read(value: unknown, attemptId?: string) {
    const input = schedulingInput(checkoutReadInput, value);
    if (attemptId !== undefined) schedulingInput(checkoutId, attemptId);
    return this.carts.withCurrent(input.cart_id, async ({ context }) => {
      const active = await currentCheckout(this.db, context.id);
      if (!attemptId) return { attempt: active ? confirmation(active) : null };
      const attempt = await this.db<Attempt>("checkout_attempt")
        .where({ id: attemptId, cart_context_id: context.id, medusa_cart_id: input.cart_id })
        .whereNull("deleted_at").first();
      if (!attempt) throw missing();
      return { attempt: confirmation(attempt) };
    });
  }

  async abandon(value: unknown) {
    const input = schedulingInput(checkoutAbandonInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ context }) => {
      // Never claim to cancel a hosted checkout.
      const current = await currentCheckout(this.db, context.id);
      if (current && (current.state === "PAYMENT_PENDING" || current.state === "RECOVERY_REQUIRED" || current.payment_accepted_at)) throw conflict("CHECKOUT_FROZEN");
      await requireUnpaidCart(this.container, input.cart_id);
      const attempt = await this.db<Attempt>("checkout_attempt")
        .where({ id: input.attempt_id, cart_context_id: context.id }).first();
      if (!attempt) throw missing();
      if (attempt.checkout_revision !== input.checkout_revision) throw conflict("CHECKOUT_RECONFIRM");
      if (attempt.closed_at) return { attempt: confirmation(attempt) };
      const now = await this.db.transaction(databaseTime);
      const [closed] = await this.db<Attempt>("checkout_attempt")
        .where({ id: attempt.id, closed_at: null })
        .update({ state: "ABANDONED", closed_at: now, updated_at: now }).returning("*");
      if (!closed) throw conflict("CHECKOUT_REFRESH_REQUIRED");
      return { attempt: confirmation(closed) };
    });
  }

  async prepare(value: unknown, confirm = false) {
    const input = confirm
      ? schedulingInput(checkoutConfirmInput, value)
      : schedulingInput(checkoutPrepareInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ cart, context, valid }) => {
      if (!valid || !cart.items?.length) throw conflict("CHECKOUT_CART_UNAVAILABLE");
      const existing = await currentCheckout(this.db, context.id);
      if (existing) {
        const snapshot = checkoutSnapshot.parse(existing.snapshot);
        if (confirm && "checkout_revision" in input && input.checkout_revision === existing.checkout_revision
          && input.address_id === snapshot.address_id
          && input.expected_reservation_revision === snapshot.reservation_revision) {
          return { attempt: confirmation(existing), quote: confirmation(existing).quote, reconfirmation_required: false };
        }
        throw conflict("CHECKOUT_FROZEN");
      }
      return commerceLock(this.container, "address:" + this.customerId, async () => {
        const owned = await ownedCheckoutAddress(this.container, this.customerId, input.address_id);
        return new DeliveryReservationService(this.container, this.customerId).withCheckoutReservation(
          context, input.address_id, input.expected_reservation_revision,
          async ({ trx, hold, shippingOptionId, assertFresh }) => {
            const native = await refreshCheckoutCart(this.container, cart.id, owned.address, shippingOptionId);
            if (native.customer_id !== this.customerId) throw missing();
            const method = native.shipping_methods?.[0];
            if (!method) throw conflict("CHECKOUT_NATIVE_STATE");
            const snapshot = checkoutSnapshot.parse({
              customer_id: this.customerId, cart_id: cart.id, cart_context_id: context.id,
              merchant_id: context.merchant_id, merchant_store_id: context.merchant_store_id,
              address_id: owned.id, address: owned.address, reservation_id: hold.id,
              reservation_revision: hold.selection_revision, configuration_revision: hold.configuration_revision,
              delivery_option_id: hold.delivery_option_id, shipping_option_id: shippingOptionId,
              shipping_method_id: method.id, currency_code: native.currency_code,
              totals: nativeCheckoutTotals(native), items: nativeCheckoutItems(native),
            });
            await assertFresh();
            const revision = checkoutRevision(snapshot);
            const result = quote(snapshot, revision, hold.expires_at);
            if (!confirm) return { quote: result, attempt: null, reconfirmation_required: false };
            if (!("checkout_revision" in input) || input.checkout_revision !== revision) {
              // Native refresh succeeded, but no snapshot is frozen. The caller
              // must explicitly confirm this new server-issued quote.
              return { quote: result, attempt: null, reconfirmation_required: true };
            }
            const now = await databaseTime(trx);
            await assertFresh();
            const [attempt] = await trx<Attempt>("checkout_attempt").insert({
              id: "chk_" + randomUUID(), cart_context_id: context.id, medusa_cart_id: cart.id,
              reservation_id: hold.id, checkout_revision: revision, snapshot,
              state: "CONFIRMED", expires_at: hold.expires_at, closed_at: null,
              created_at: now, updated_at: now,
            }).returning("*");
            if (!attempt) throw conflict("CHECKOUT_REFRESH_REQUIRED");
            return { quote: result, attempt: confirmation(attempt), reconfirmation_required: false };
          },
        );
      });
    });
  }
}
