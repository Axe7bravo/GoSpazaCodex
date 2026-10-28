import type { MedusaContainer } from "@medusajs/framework/types";
import { RestrictedCommerce } from "./restricted-commerce";
import type { PurchaserEligibilityProvider } from "../modules/marketplace/restricted-policy";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { PaymentInitiationResult } from "@gospaza/contracts";
import { CartFoundationService } from "./cart-service";
import { DeliveryReservationService } from "./delivery-reservation-service";
import { commerceLock } from "./commerce";
import { checkoutAbandonInput, checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import { currentCheckout } from "../modules/marketplace/checkout-repository";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import { databaseTime, selectionRevision } from "../modules/marketplace/delivery-reservation-repository";
import { schedulingInput } from "../modules/marketplace/scheduling-policy";
import { assertNativeCheckoutSnapshot, ownedCheckoutAddress } from "./checkout-native";
import { establishPaymentCollection, establishPaymentSession } from "./payment-native";
import { paymentDeadlineMinutes, yocoConfiguration } from "./yoco-config";
import { fingerprint } from "../modules/yoco/request";
import { hostedRedirect } from "../modules/yoco/validation";
import { YocoProviderError } from "../modules/yoco/types";

const conflict = (code: string) => new MedusaError(MedusaError.Types.CONFLICT, code);
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Checkout unavailable.");

export class PaymentInitiationService {
  private db: Knex;
  private operations: PgYocoOperationStore;
  private compliance: RestrictedCommerce;
  constructor(private container: MedusaContainer, private customerId: string, purchaser?: PurchaserEligibilityProvider) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.operations = new PgYocoOperationStore(this.db);
    this.compliance = new RestrictedCommerce(container, purchaser);
  }

  private result(attempt: Attempt, state: PaymentInitiationResult["state"], redirect: string | null = null): PaymentInitiationResult {
    return { attempt_id: attempt.id, state, redirect_url: redirect,
      payment_deadline: attempt.payment_deadline ? new Date(attempt.payment_deadline).toISOString() : null };
  }


  async initiate(value: unknown, recover = false): Promise<PaymentInitiationResult> {
    const input = schedulingInput(checkoutAbandonInput, value);
    return new CartFoundationService(this.container, this.customerId).withCurrent(input.cart_id, async ({ context, valid }) => {
      let active = await currentCheckout(this.db, context.id);
      const initialAttempt = await this.db<Attempt>("checkout_attempt")
        .where({ id: input.attempt_id, cart_context_id: context.id, medusa_cart_id: input.cart_id })
        .whereNull("deleted_at").first();
      if (!initialAttempt) throw missing();
      const attempt = initialAttempt;
      if (attempt.checkout_revision !== input.checkout_revision) throw conflict("CHECKOUT_RECONFIRM");
      if (attempt.closed_at || active?.id !== attempt.id) return this.result(attempt, "expired");
      if (attempt.payment_accepted_at || attempt.state === "RECOVERY_REQUIRED") {
        return this.result(attempt, "reconciliation_required");
      }
      const configuration = yocoConfiguration(process.env);
      if (!configuration) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Payment initiation is disabled.");
      const snapshot = checkoutSnapshot.parse(attempt.snapshot);
      if (snapshot.customer_id !== this.customerId || snapshot.merchant_id !== context.merchant_id
        || snapshot.merchant_store_id !== context.merchant_store_id) throw missing();
      return commerceLock(this.container, context.merchant_id, async () => {
      let attempt: Attempt = initialAttempt;
      if (attempt.state === "CONFIRMED") {
        if (!valid) throw conflict("CHECKOUT_CART_UNAVAILABLE");
        const confirmed = attempt;
        await commerceLock(this.container, "address:" + this.customerId, async () => {
          const owned = await ownedCheckoutAddress(this.container, this.customerId, snapshot.address_id);
          if (JSON.stringify(owned.address) !== JSON.stringify(snapshot.address)) throw conflict("CHECKOUT_RECONFIRM");
          await new DeliveryReservationService(this.container, this.customerId).withCheckoutReservation(
            context, snapshot.address_id, snapshot.reservation_revision,
            async ({ trx, hold, assertFresh }) => {
              await assertNativeCheckoutSnapshot(this.container, snapshot);
              await assertFresh();
              const restriction = await this.compliance.evaluate(trx, this.customerId,
                context.merchant_store_id, snapshot.items.map(item => item.variant_id));
              if (!snapshot.restricted_commerce || JSON.stringify(restriction) !== JSON.stringify(snapshot.restricted_commerce)) {
                throw conflict("CHECKOUT_RECONFIRM");
              }
              const now = await databaseTime(trx);
              const deadline = new Date(now.getTime() + paymentDeadlineMinutes(process.env) * 60000);
              const [pending] = await trx<Attempt>("checkout_attempt")
                .where({ id: confirmed.id, state: "CONFIRMED", closed_at: null })
                .update({ state: "PAYMENT_PENDING", payment_deadline: deadline, updated_at: now }).returning("*");
              if (!pending) throw conflict("CHECKOUT_REFRESH_REQUIRED");
              await trx("delivery_reservation").where({ id: hold.id, status: "HELD" }).update({
                status: "PAYMENT_PENDING", payment_deadline: deadline,
                selection_revision: await selectionRevision(trx, context.id) + 1, updated_at: now,
              });
              await this.operations.prepare(trx, pending, configuration);
            }, snapshot,
          );
        });
        const refreshed = await this.db<Attempt>("checkout_attempt").where({ id: confirmed.id }).first();
        if (!refreshed) throw missing();
        attempt = refreshed;
      }

      // Re-enter after a lost response using committed state, not a replay of
      // confirmation, capacity extension, totals refresh or session workflow.
      active = await currentCheckout(this.db, context.id);
      if (!active || active.id !== attempt.id) return this.result(attempt, "expired");
      const row = await this.db<{ id: string }>("provider_operation").where({ checkout_attempt_id: attempt.id }).first();
      if (!row) throw conflict("CHECKOUT_REFRESH_REQUIRED");
      try {
        // Recovery may replay the SAME external operation, never a new licence
        // decision. Revalidate before any further checkout-creation side effect.
        const restriction = await this.db.transaction(trx => this.compliance.evaluate(trx,
          this.customerId, context.merchant_store_id, snapshot.items.map(item => item.variant_id)));
        if (!snapshot.restricted_commerce || JSON.stringify(restriction) !== JSON.stringify(snapshot.restricted_commerce)) throw conflict("CHECKOUT_RECONFIRM");
        await assertNativeCheckoutSnapshot(this.container, snapshot);
        const operation = await this.operations.row(row.id);
        if (operation.account_fingerprint !== fingerprint(configuration.secretKey)) {
          throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
        }
        await establishPaymentCollection(this.container, operation, input.cart_id);
        await establishPaymentSession(this.container, row.id, recover);
      } catch (error) {
        // Native errors can wrap provider errors. Durable state, rather than
        // error-message parsing, determines whether this operation is uncertain.
        const operation = await this.operations.row(row.id);
        if (!await currentCheckout(this.db, context.id)) return this.result(attempt, "expired");
        if (operation.state === "mismatch") throw conflict("PAYMENT_IDEMPOTENCY_MISMATCH");
        if (["sending", "uncertain"].includes(operation.state)) return this.result(attempt, "uncertain");
        throw error;
      }
      // A slow provider response cannot revive a deadline that expired in flight.
      if (!await currentCheckout(this.db, context.id)) return this.result(attempt, "expired");
      const operation = await this.operations.read(row.id);
      if (!operation || operation.terminalRefunded) return this.result(attempt, "reconciliation_required");
      if (operation.payment || operation.checkout?.status === "completed") {
        return this.result(attempt, "reconciliation_required");
      }
      if (!operation.checkout || operation.state !== "created") return this.result(attempt, "uncertain");
      hostedRedirect(operation.checkout.redirectUrl);
      return this.result(attempt, "ready", operation.checkout.redirectUrl);
      });
    });
  }
}
