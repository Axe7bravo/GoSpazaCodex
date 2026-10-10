import type { CheckoutSnapshot } from "../modules/marketplace/checkout-policy";
import { currentCheckout } from "../modules/marketplace/checkout-repository";
import type { MedusaContainer, InferTypeOf } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { CartFoundationService } from "./cart-service";
import { DiscoveryService, discoveryInput } from "./discovery-service";
import type { DiscoveryInput } from "./discovery-service";
import { SchedulingService } from "./scheduling-service";
import { commerceLock } from "./commerce";
import type Policy from "../modules/marketplace/models/delivery-policy";
import type { CartContext } from "../modules/marketplace/cart-context-repository";
import { schedulingInput } from "../modules/marketplace/scheduling-policy";
import { deliveryReadInput, deliveryLocationInput, deliverySelectionInput, deliveryReleaseInput } from "../modules/marketplace/delivery-selection-policy";
import { activeHold, effectiveExpiry, databaseTime, finishHold, lockSlots, occupied, reservationId, selectionRevision } from "../modules/marketplace/delivery-reservation-repository";
import type { Hold, DeliveryWindow } from "../modules/marketplace/delivery-reservation-repository";

type PolicyRow = InferTypeOf<typeof Policy>;
const conflict = (code: string) => new MedusaError(MedusaError.Types.CONFLICT, code);
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Delivery selection unavailable.");
const iso = (date: Date | string) => new Date(date).toISOString();

export class DeliveryReservationService {
  private db: Knex;
  private carts: CartFoundationService;
  constructor(private container: MedusaContainer, private customerId: string) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.carts = new CartFoundationService(container, customerId);
  }

  // Reuse the existing configuration/provisioning lock order, then lock rows
  // against M6 tariff changes. Customer advisory lock is already held here.
  private configured<T>(context: CartContext, work: (trx: Knex.Transaction, policy: PolicyRow) => Promise<T>) {
    return commerceLock(this.container, "scheduling-configuration", () =>
      commerceLock(this.container, "fulfillment:" + context.merchant_store_id, () =>
        this.db.transaction(async (trx) => {
          await trx("merchant").where({ id: context.merchant_id }).forShare();
          await trx("merchant_store").where({ id: context.merchant_store_id }).forShare();
          const assignments = await trx<{ service_zone_id: string }>("merchant_store_service_zone")
            .where({ merchant_store_id: context.merchant_store_id }).select("service_zone_id");
          await trx("marketplace_service_zone").whereIn("id", assignments.map((a) => a.service_zone_id)).orderBy("id").forShare();
          await trx("merchant_store_service_zone").where({ merchant_store_id: context.merchant_store_id }).orderBy("id").forShare();
          const policy = await trx<PolicyRow>("store_delivery_policy").where({ merchant_store_id: context.merchant_store_id })
            .whereNull("deleted_at").forShare().first();
          if (!policy) throw conflict("DELIVERY_UNAVAILABLE");
          await trx("delivery_option_configuration").where({ merchant_store_id: context.merchant_store_id }).orderBy("id").forShare();
          return work(trx, policy);
        })));
  }

  private async resolve(context: CartContext, location: DiscoveryInput) {
    const point = await new DiscoveryService(this.container, this.customerId).point(location);
    const assignment = await new SchedulingService(this.container).resolveAssignment(context.merchant_store_id, point.latitude, point.longitude);
    return { point, assignment, options: assignment.options.filter((option) => option.enabled &&
      (option.mode === "ASAP" ? assignment.asap_enabled : assignment.scheduled_enabled)) };
  }


  // Shared by restoration and checkout; M9 remains the sole configuration,
  // serviceability and native option/pricing authority.
  private async resolveHeld(context: CartContext, hold: Hold) {
    const location = discoveryInput.parse(hold.medusa_customer_address_id
      ? { address_id: hold.medusa_customer_address_id }
      : { latitude: Number(hold.latitude), longitude: Number(hold.longitude) });
    const resolved = await this.resolve(context, location);
    const option = resolved.options.find((candidate) => candidate.id === hold.delivery_option_id);
    if (!option || option.revision !== hold.configuration_revision
      || resolved.assignment.id !== hold.store_service_zone_id
      || resolved.assignment.delivery_fee_minor !== hold.quoted_fee_minor) {
      throw conflict("DELIVERY_SELECTION_STALE");
    }
    return { ...resolved, option };
  }

  // Caller already holds M8's customer lock. Keep M9 configuration and slot
  // locks through native shipping and snapshot publication; never reacquire M8.
  async withCheckoutReservation<T>(
    context: CartContext,
    addressId: string,
    expectedRevision: number,
    work: (data: {
      trx: Knex.Transaction; hold: Hold; shippingOptionId: string;
      assertFresh(): Promise<void>;
    }) => Promise<T>,
    frozen?: CheckoutSnapshot,
  ): Promise<T> {
    return this.configured(context, async (trx) => {
      const hold = await activeHold(trx, context.id);
      if (!hold || hold.status !== "HELD" || hold.deleted_at) throw conflict("DELIVERY_SELECTION_STALE");
      const [slot] = await lockSlots(trx, [hold.delivery_slot_id]);
      const assertFresh = async () => {
        const now = await databaseTime(trx);
        if (new Date(hold.expires_at) <= now || !slot?.enabled || slot.deleted_at
          || new Date(slot.booking_cutoff_at) <= now) throw conflict("DELIVERY_SELECTION_STALE");
      };
      await assertFresh();
      if (await selectionRevision(trx, context.id) !== expectedRevision) {
        throw conflict("DELIVERY_SELECTION_STALE");
      }
      const discovery = new DiscoveryService(this.container, this.customerId);
      const point = await discovery.point(discoveryInput.parse({ address_id: addressId }));
      if (frozen) {
        // The original configuration and native shipping price were validated
        // before confirmation. Later tariffs cannot rewrite that frozen amount.
        // Revalidate owned destination, geography, slot and option identity.
        const eligible = await discovery.eligible(discoveryInput.parse({ address_id: addressId }));
        await new SchedulingService(this.container).assertConfirmedOption(
          context.merchant_store_id, point.latitude, point.longitude, hold.store_service_zone_id,
          hold.delivery_option_id, frozen.shipping_option_id,
        );
        if (hold.id !== frozen.reservation_id || hold.configuration_revision !== frozen.configuration_revision
          || hold.delivery_option_id !== frozen.delivery_option_id
          || !eligible.some((store) => store.id === context.merchant_store_id)
          || point.latitude !== Number(hold.latitude) || point.longitude !== Number(hold.longitude)
          || hold.medusa_customer_address_id && hold.medusa_customer_address_id !== addressId) {
          throw conflict("DELIVERY_SELECTION_STALE");
        }
        return work({ trx, hold, shippingOptionId: frozen.shipping_option_id, assertFresh });
      }
      const resolved = await this.resolveHeld(context, hold);
      if (hold.medusa_customer_address_id && hold.medusa_customer_address_id !== addressId
        || point.latitude !== resolved.point.latitude || point.longitude !== resolved.point.longitude
        || !resolved.option.medusa_shipping_option_id) throw conflict("DELIVERY_SELECTION_STALE");
      return work({ trx, hold, shippingOptionId: resolved.option.medusa_shipping_option_id, assertFresh });
    });
  }

  private eligible(slot: DeliveryWindow, policy: PolicyRow, now: Date) {
    return slot.enabled && !slot.deleted_at && new Date(slot.booking_cutoff_at) > now
      && new Date(slot.start_at).getTime() >= now.getTime() + policy.minimum_lead_minutes * 60000
      && new Date(slot.end_at).getTime() <= now.getTime() + policy.booking_horizon_days * 86400000;
  }

  private async windows(trx: Knex.Transaction, storeId: string, old?: Hold) {
    const ids = await trx<DeliveryWindow>("delivery_slot").where({ merchant_store_id: storeId }).whereNull("deleted_at").select("id");
    return lockSlots(trx, [...ids.map((slot) => slot.id), ...(old ? [old.delivery_slot_id] : [])]);
  }

  private dto(hold: Hold | undefined, slot: DeliveryWindow | undefined, revision: number, state: string, timezone?: string) {
    return { state, revision, timezone: timezone ?? null, selection: hold && slot ? {
      id: hold.id, option_id: hold.delivery_option_id, slot_id: slot.id,
      start_at: iso(slot.start_at), end_at: iso(slot.end_at), expires_at: iso(effectiveExpiry(hold)),
      fee_minor: hold.quoted_fee_minor, currency_code: hold.currency_code,
    } : null };
  }

  async availability(value: unknown) {
    const input = schedulingInput(deliveryLocationInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ cart, context, valid }) => {
      if (!valid || !cart.items?.length) throw conflict("DELIVERY_UNAVAILABLE");
      return this.configured(context, async (trx, policy) => {
        const resolved = await this.resolve(context, input.location);
        const old = await activeHold(trx, context.id);
        const slots = await this.windows(trx, context.merchant_store_id, old);
        const now = await databaseTime(trx);
        const available = [];
        for (const slot of slots.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime() || a.id.localeCompare(b.id))) {
          if (!this.eligible(slot, policy, now)) continue;
          const remaining = Math.max(0, slot.capacity - await occupied(trx, slot.id, now, context.id));
          if (remaining) available.push({ id: slot.id, revision: slot.revision, start_at: iso(slot.start_at), end_at: iso(slot.end_at), remaining });
        }
        return { revision: await selectionRevision(trx, context.id), timezone: policy.timezone, as_of: iso(now),
          options: resolved.options.map((option) => ({ id: option.id, mode: option.mode, revision: option.revision,
            fee_minor: resolved.assignment.delivery_fee_minor, currency_code: "zar" })), slots: available };
      });
    });
  }

  private async assertSelectionMutable(contextId: string) {
    const attempt = await currentCheckout(this.db, contextId);
    if (attempt && (attempt.state === "PAYMENT_PENDING" || attempt.state === "RECOVERY_REQUIRED" || attempt.payment_accepted_at)) throw conflict("CHECKOUT_FROZEN");
  }

  async select(value: unknown) {
    const input = schedulingInput(deliverySelectionInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ cart, context, valid }) => {
      await this.assertSelectionMutable(context.id);
      if (!valid || !cart.items?.length) throw conflict("DELIVERY_UNAVAILABLE");
      return this.configured(context, async (trx, policy) => {
        const resolved = await this.resolve(context, input.location);
        const option = resolved.options.find((candidate) => candidate.id === input.option_id);
        if (!option) throw missing();
        if (option.revision !== input.expected_option_revision) throw conflict("DELIVERY_SELECTION_STALE");
        if (option.mode === "SCHEDULED" && !input.slot_id || option.mode === "ASAP" && input.slot_id) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose a slot only for scheduled delivery.");
        }
        const old = await activeHold(trx, context.id);
        const slots = await this.windows(trx, context.merchant_store_id, old);
        const now = await databaseTime(trx);
        const revision = await selectionRevision(trx, context.id);
        if (revision !== input.expected_revision) throw conflict("DELIVERY_SELECTION_STALE");
        const sameBasis = old && old.delivery_option_id === option.id && old.configuration_revision === option.revision
          && old.quoted_fee_minor === resolved.assignment.delivery_fee_minor
          && old.medusa_customer_address_id === (input.location.address_id ?? null)
          && Number(old.latitude) === resolved.point.latitude && Number(old.longitude) === resolved.point.longitude;
        // Preserve an effective identical ASAP selection even if a newly freed
        // earlier slot appears. Selection is not an implicit renewal or move.
        const oldSlot = slots.find((slot) => slot.id === old?.delivery_slot_id);
        if (old && sameBasis && oldSlot && (option.mode === "ASAP" || input.slot_id === oldSlot.id)
          && new Date(old.expires_at) > now && oldSlot.enabled && !oldSlot.deleted_at
          && new Date(oldSlot.booking_cutoff_at) > now) {
          return this.dto(old, oldSlot, revision, "held", policy.timezone);
        }
        const candidates = slots.filter((slot) => slot.merchant_store_id === context.merchant_store_id
          && (option.mode === "ASAP" || slot.id === input.slot_id))
          .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime() || a.id.localeCompare(b.id));
        let chosen: DeliveryWindow | undefined;
        for (const slot of candidates) {
          if (this.eligible(slot, policy, now) && await occupied(trx, slot.id, now, context.id) < slot.capacity) {
            chosen = slot; break;
          }
        }
        if (!chosen) throw conflict("DELIVERY_SLOT_UNAVAILABLE");
        const publicationTime = await databaseTime(trx);
        if (!this.eligible(chosen, policy, publicationTime)) throw conflict("DELIVERY_SLOT_UNAVAILABLE");
        // No old hold is changed until target eligibility and capacity are proven.
        if (old) await finishHold(trx, old, publicationTime, "REPLACED");
        const nextRevision = await selectionRevision(trx, context.id) + 1;
        const expiresAt = new Date(Math.min(publicationTime.getTime() + policy.hold_minutes * 60000, new Date(chosen.booking_cutoff_at).getTime()));
        const [hold] = await trx<Hold>("delivery_reservation").insert({
          id: reservationId(), cart_context_id: context.id, merchant_store_id: context.merchant_store_id,
          delivery_option_id: option.id, store_service_zone_id: resolved.assignment.id, delivery_slot_id: chosen.id,
          status: "HELD", expires_at: expiresAt, created_at: publicationTime, updated_at: publicationTime,
          configuration_revision: option.revision, selection_revision: nextRevision,
          quoted_fee_minor: resolved.assignment.delivery_fee_minor, currency_code: "zar",
          medusa_customer_address_id: input.location.address_id ?? null,
          latitude: resolved.point.latitude, longitude: resolved.point.longitude,
        }).returning("*");
        if (!hold) throw new Error("Reservation publication failed.");
        return this.dto(hold, chosen, nextRevision, "held", policy.timezone);
      });
    });
  }

  async release(value: unknown) {
    const input = schedulingInput(deliveryReleaseInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ context }) => {
      await this.assertSelectionMutable(context.id);
      return this.db.transaction(async (trx) => {
        const old = await activeHold(trx, context.id);
        if (input.reservation_id) {
          const owned = await trx<Hold>("delivery_reservation").where({ id: input.reservation_id, cart_context_id: context.id }).first();
          if (!owned) throw missing();
          if (old && old.id !== owned.id) throw conflict("DELIVERY_SELECTION_STALE");
        }
        if (!old) return this.dto(undefined, undefined, await selectionRevision(trx, context.id), "unselected");
        await lockSlots(trx, [old.delivery_slot_id]);
        const now = await databaseTime(trx);
        if (await selectionRevision(trx, context.id) !== input.expected_revision) throw conflict("DELIVERY_SELECTION_STALE");
        await finishHold(trx, old, now, "CUSTOMER_RELEASED");
        return this.dto(undefined, undefined, await selectionRevision(trx, context.id), "unselected");
      });
    });
  }

  async restore(value: unknown) {
    const input = schedulingInput(deliveryReadInput, value);
    return this.carts.withCurrent(input.cart_id, async ({ cart, context, valid }) => {
      const checkout = await currentCheckout(this.db, context.id);
      if (checkout && (checkout.state === "PAYMENT_PENDING" || checkout.state === "RECOVERY_REQUIRED")) {
        return this.db.transaction(async (trx) => {
          const pending = await activeHold(trx, context.id);
          const slot = pending ? (await lockSlots(trx, [pending.delivery_slot_id]))[0] : undefined;
          const now = await databaseTime(trx);
          if (!pending || !slot) throw conflict("CHECKOUT_REFRESH_REQUIRED");
          if (!pending.payment_accepted_at && effectiveExpiry(pending) <= now) {
            await finishHold(trx, pending, now, "PAYMENT_DEADLINE");
            await trx("checkout_attempt").where({ id: checkout.id, closed_at: null })
              .update({ state: "EXPIRED", closed_at: now, updated_at: now });
            return this.dto(undefined, undefined, await selectionRevision(trx, context.id), "expired");
          }
          return this.dto(pending, slot, await selectionRevision(trx, context.id), "held");
        });
      }
      const existing = await this.db<Hold>("delivery_reservation").where({ cart_context_id: context.id, status: "HELD" }).first();
      if (!existing) {
        return this.db.transaction(async (trx) => this.dto(undefined, undefined, await selectionRevision(trx, context.id), "unselected"));
      }
      // Revalidation failure must not roll back the release; catch domain
      // unavailability inside the transaction, while operational failures escape.
      return this.configured(context, async (trx, policy) => {
        const old = await activeHold(trx, context.id);
        if (!old) return this.dto(undefined, undefined, await selectionRevision(trx, context.id), "unselected", policy.timezone);
        const [slot] = await lockSlots(trx, [old.delivery_slot_id]);
        const now = await databaseTime(trx);
        let state = "held";
        if (new Date(old.expires_at) <= now) state = "expired";
        else if (!valid || !cart.items?.length || !slot?.enabled || slot.deleted_at || new Date(slot.booking_cutoff_at) <= now) state = "unavailable";
        else {
          try {
            await this.resolveHeld(context, old);
          } catch (error) {
            if (!(error instanceof MedusaError) || ![MedusaError.Types.CONFLICT, MedusaError.Types.NOT_FOUND, MedusaError.Types.INVALID_DATA].includes(error.type)) throw error;
            state = "stale";
          }
        }
        const finalNow = await databaseTime(trx);
        if (new Date(old.expires_at) <= finalNow) state = "expired";
        else if (slot && new Date(slot.booking_cutoff_at) <= finalNow) state = "unavailable";
        if (state !== "held") {
          await finishHold(trx, old, finalNow, state.toUpperCase());
          return this.dto(undefined, undefined, await selectionRevision(trx, context.id), state, policy.timezone);
        }
        return this.dto(old, slot, await selectionRevision(trx, context.id), state, policy.timezone);
      }).catch(async (error: unknown) => {
        if (!(error instanceof MedusaError) || error.message !== "DELIVERY_UNAVAILABLE") throw error;
        // A deleted policy cannot prevent ending the old hold. This only handles
        // the explicit missing-policy result, never a database/native outage.
        return this.db.transaction(async (trx) => {
          const old = await activeHold(trx, context.id);
          if (old) {
            await lockSlots(trx, [old.delivery_slot_id]);
            await finishHold(trx, old, await databaseTime(trx), "UNAVAILABLE");
          }
          return this.dto(undefined, undefined, await selectionRevision(trx, context.id), "unavailable");
        });
      });
    });
  }
}
