import { databaseTime, occupied } from "../modules/marketplace/delivery-reservation-repository";
import { randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { InferTypeOf, IFulfillmentModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { createShippingOptionsWorkflow, updateShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";
import type Policy from "../modules/marketplace/models/delivery-policy";
import type Option from "../modules/marketplace/models/delivery-option";
import type Slot from "../modules/marketplace/models/delivery-slot";
import { nativePrice, minorPrice } from "../modules/marketplace/catalogue-policy";
import { coordinates, geometryService } from "../modules/marketplace/location-policy";
import type { Geometry } from "../modules/marketplace/location-policy";
import { assertDeliverySynchronized, policyInput, slotInput, schedulingDefaults, schedulingInput,
  schedulingConflict, resolveDeliveryAssignment } from "../modules/marketplace/scheduling-policy";
import { commerceLock } from "./commerce";
import { LocationService } from "./location-service";
import { ensureShippingProfile, backfillProductProfiles, ensureSouthAfricaGeoZone, ensureLocationFulfillmentProvider } from "./scheduling-native";

type PolicyRow = InferTypeOf<typeof Policy>;
type OptionRow = InferTypeOf<typeof Option>;
type SlotRow = InferTypeOf<typeof Slot>;
interface Assignment {
  id: string; merchant_store_id: string; service_zone_id: string; priority: number; active: boolean;
  medusa_service_zone_id: string | null; deleted_at: Date | null;
}
interface Store { id: string; merchant_id: string; active: boolean; medusa_fulfillment_set_id: string | null; medusa_stock_location_id: string | null }
interface Zone { id: string; active: boolean; geometry: Geometry; delivery_fee_minor: number; currency_code: string }
interface NativePrice {
  id: string; amount: Parameters<typeof minorPrice>[0]; currency_code: string; min_quantity: number | null;
  max_quantity: number | null; price_list_id: string | null; price_rules?: { id: string }[];
}
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Scheduling configuration not found.");

export class SchedulingService {
  private db: Knex;
  constructor(private container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private lock<T>(work: () => Promise<T>) {
    // Configuration only. M9-C reservations must use the M8 customer lock + slot row locks.
    return commerceLock(this.container, "scheduling-configuration", work);
  }
  private async store(id: string) {
    const row = await this.db<Store, Store[]>("merchant_store").where({ id }).whereNull("deleted_at").first();
    if (!row) throw missing();
    return row;
  }
  private async audit(trx: Knex.Transaction, user: string, target: string, action: string, reason: string, before: unknown, after: unknown) {
    await trx("scheduling_event").insert({ id: "schevt_" + randomUUID(), platform_user_id: user,
      target_id: target, action, reason, before_state: before == null ? null : JSON.stringify(before), after_state: JSON.stringify(after) });
  }
  async configuration(storeId: string) {
    await this.store(storeId);
    const policy = await this.db<PolicyRow, PolicyRow[]>("store_delivery_policy").where({ merchant_store_id: storeId }).whereNull("deleted_at").first();
    const options = await this.db<OptionRow, OptionRow[]>("delivery_option_configuration").where({ merchant_store_id: storeId }).whereNull("deleted_at").orderBy("id");
    const assignments = await this.db<Assignment, Assignment[]>("merchant_store_service_zone").where({ merchant_store_id: storeId }).whereNull("deleted_at").orderBy("id");
    // Explicit admin DTOs: no ORM entities/location snapshots/reservations exposed.
    return { policy: policy ? { id: policy.id, timezone: policy.timezone, enabled: policy.enabled,
      asap_enabled: policy.asap_enabled, scheduled_enabled: policy.scheduled_enabled,
      minimum_lead_minutes: policy.minimum_lead_minutes, booking_horizon_days: policy.booking_horizon_days,
      hold_minutes: policy.hold_minutes, revision: policy.revision } : null,
      assignments: assignments.map((a) => ({ id: a.id, service_zone_id: a.service_zone_id, active: a.active, priority: a.priority })),
      options: options.map((o) => ({ id: o.id, assignment_id: o.store_service_zone_id, mode: o.mode, enabled: o.enabled,
        revision: o.revision, synced_revision: o.synced_revision, sync_state: o.sync_state, sync_error: o.sync_error })) };
  }
  async savePolicy(storeId: string, value: unknown, user: string, reason: string) {
    const data = schedulingInput(policyInput, value);
    return this.lock(async () => {
      await this.store(storeId);
      await this.db.transaction(async (trx) => {
        const before = await trx<PolicyRow>("store_delivery_policy").where({ merchant_store_id: storeId }).forUpdate().first();
        if (before?.deleted_at) throw schedulingConflict("Archived scheduling policy needs explicit recovery.");
        if (before) await trx("store_delivery_policy").where({ id: before.id }).update({ ...data, revision: before.revision + 1, updated_at: new Date() });
        else await trx("store_delivery_policy").insert({ id: "dpolicy_" + randomUUID(), merchant_store_id: storeId, ...data });
        await this.audit(trx, user, storeId, "POLICY_CONFIGURED", reason, before ?? null, data);
      });
      return this.configuration(storeId);
    });
  }
  async configureAssignment(storeId: string, assignmentId: string, priority: number, asap: boolean, scheduled: boolean, user: string, reason: string) {
    return this.lock(async () => {
      await this.db.transaction(async (trx) => {
        const before = await trx<Assignment>("merchant_store_service_zone").where({ id: assignmentId, merchant_store_id: storeId }).whereNull("deleted_at").forUpdate().first();
        if (!before) throw missing();
        const previousOptions = await trx<OptionRow>("delivery_option_configuration").where({ store_service_zone_id: assignmentId }).select("mode", "enabled");
        await trx("merchant_store_service_zone").where({ id: assignmentId }).update({ priority, updated_at: new Date() });
        for (const mode of ["ASAP", "SCHEDULED"] as const) {
          const enabled = mode === "ASAP" ? asap : scheduled;
          const option = await trx<OptionRow>("delivery_option_configuration").where({ store_service_zone_id: assignmentId, mode }).first();
          if (option?.deleted_at) throw schedulingConflict("Archived option needs explicit recovery.");
          if (option) await trx("delivery_option_configuration").where({ id: option.id }).update({ enabled,
            revision: option.revision + 1, sync_state: "PENDING", sync_error: null, updated_at: new Date() });
          else await trx("delivery_option_configuration").insert({ id: "doption_" + randomUUID(), merchant_store_id: storeId,
            store_service_zone_id: assignmentId, mode, enabled });
        }
        await this.audit(trx, user, assignmentId, "ASSIGNMENT_CONFIGURED", reason, { priority: before.priority, options: previousOptions },
          { priority, asap_enabled: asap, scheduled_enabled: scheduled });
      });
      return this.configuration(storeId);
    });
  }
  async saveSlot(storeId: string, value: unknown, user: string, reason: string, slotId?: string) {
    const data = schedulingInput(slotInput, value);
    return this.lock(async () => this.db.transaction(async (trx) => {
      const policy = await trx<PolicyRow>("store_delivery_policy").where({ merchant_store_id: storeId }).whereNull("deleted_at").forUpdate().first();
      if (!policy) throw missing();
      const before = slotId ? await trx<SlotRow>("delivery_slot").where({ id: slotId, merchant_store_id: storeId }).whereNull("deleted_at").forUpdate().first() : null;
      if (slotId && !before) throw missing();
      const now = (await databaseTime(trx)).getTime();
      const timesChanged = !before || new Date(before.start_at).toISOString() !== new Date(data.start_at).toISOString()
        || new Date(before.end_at).toISOString() !== new Date(data.end_at).toISOString()
        || new Date(before.booking_cutoff_at).toISOString() !== new Date(data.booking_cutoff_at).toISOString();
      if (timesChanged && (Date.parse(data.start_at) < now + policy.minimum_lead_minutes * 60000
        || Date.parse(data.end_at) > now + policy.booking_horizon_days * 86400000
        || Date.parse(data.booking_cutoff_at) > Date.parse(data.start_at) - policy.minimum_lead_minutes * 60000)) {
        throw schedulingConflict("Slot must fit the configured lead time and booking horizon.");
      }
      if (before && await trx("delivery_reservation").where({ delivery_slot_id: before.id }).first()) {
        // Referenced windows remain immutable; enablement/capacity may change
        // under this same slot row lock used by every capacity writer.
        if (timesChanged) {
          throw schedulingConflict("Referenced slot windows cannot be changed.");
        }
        const lockedNow = await databaseTime(trx);
        if (data.capacity < await occupied(trx, before.id, lockedNow)) {
          throw schedulingConflict("Slot capacity is below effective occupancy.");
        }
      }
      const overlap = trx("delivery_slot").where({ merchant_store_id: storeId, enabled: true }).whereNull("deleted_at")
        .where("start_at", "<", data.end_at).where("end_at", ">", data.start_at);
      if (slotId) overlap.whereNot("id", slotId);
      if (data.enabled && await overlap.first()) throw schedulingConflict("Enabled store capacity windows must not overlap.");
      const id = slotId ?? "dslot_" + randomUUID();
      if (before) await trx("delivery_slot").where({ id }).update({ ...data, revision: before.revision + 1, updated_at: new Date() });
      else await trx("delivery_slot").insert({ id, merchant_store_id: storeId, ...data });
      await this.audit(trx, user, id, "SLOT_CONFIGURED", reason, before ?? null, data);
      return { id, ...data, revision: (before?.revision ?? 0) + 1 };
    }));
  }
  async slots(storeId: string) {
    await this.store(storeId);
    return this.db<SlotRow, SlotRow[]>("delivery_slot").where({ merchant_store_id: storeId }).whereNull("deleted_at")
      .where("end_at", ">", this.db.fn.now()).select("id", "start_at", "end_at", "booking_cutoff_at", "capacity", "enabled", "revision")
      .orderBy("start_at").limit(500);
  }

  async synchronize(storeId: string, user: string, reason: string) {
    return this.lock(async () => {
      const store = await this.store(storeId);
      await this.db("store_delivery_policy").insert({ id: "dpolicy_" + randomUUID(), merchant_store_id: storeId, ...schedulingDefaults })
        .onConflict("merchant_store_id").ignore();
      await this.db.transaction(async (trx) => {
        await trx("delivery_option_configuration").where({ merchant_store_id: storeId })
          .update({ sync_state: "PENDING", sync_error: null, updated_at: new Date() });
        await this.audit(trx, user, storeId, "SYNCHRONIZATION_REQUESTED", reason, null, { state: "PENDING" });
      });
      const profileId = await ensureShippingProfile(this.container);
      await commerceLock(this.container, store.merchant_id, async () => {
        const products = await this.db<{ medusa_product_id: string }>("product_marketplace_profile")
          .where({ merchant_id: store.merchant_id }).whereNull("deleted_at").select("medusa_product_id");
        await backfillProductProfiles(this.container, products.map((p) => p.medusa_product_id), profileId);
      });
      await new LocationService(this.container).ensureFulfillment(storeId);
      await commerceLock(this.container, "fulfillment:" + storeId, async () => {
        const current = await this.store(storeId);
        if (!current.medusa_fulfillment_set_id || !current.medusa_stock_location_id) throw missing();
        await ensureLocationFulfillmentProvider(this.container, current.medusa_stock_location_id);
        const assignments = await this.db<Assignment, Assignment[]>("merchant_store_service_zone").where({ merchant_store_id: storeId }).whereNull("deleted_at").orderBy("id");
        for (const assignment of assignments) {
          if (!assignment.medusa_service_zone_id) {
            if (assignment.active) throw schedulingConflict("Active assignment lacks native topology.");
            continue;
          }
          await ensureSouthAfricaGeoZone(this.container, assignment.medusa_service_zone_id, current.medusa_fulfillment_set_id, assignment.id);
          for (const mode of ["ASAP", "SCHEDULED"] as const) {
            await this.db("delivery_option_configuration").insert({ id: "doption_" + randomUUID(), merchant_store_id: storeId,
              store_service_zone_id: assignment.id, mode, enabled: false }).onConflict(["store_service_zone_id", "mode"]).ignore();
          }
          const options = await this.db<OptionRow, OptionRow[]>("delivery_option_configuration").where({ store_service_zone_id: assignment.id }).whereNull("deleted_at");
          for (const option of options) await this.syncOption(option, assignment, profileId, user, reason);
        }
      });
      return this.configuration(storeId);
    });
  }
  private async syncOption(option: OptionRow, assignment: Assignment, profileId: string, user: string, reason: string) {
    const started = await this.db("delivery_option_configuration").where({ id: option.id, revision: option.revision })
      .update({ sync_state: "SYNCING", sync_error: null });
    if (started !== 1) throw schedulingConflict("Configuration changed before synchronization.");
    try {
      const zone = await this.db<Zone, Zone[]>("marketplace_service_zone").where({ id: assignment.service_zone_id }).whereNull("deleted_at").first();
      const policy = await this.db<PolicyRow, PolicyRow[]>("store_delivery_policy").where({ merchant_store_id: assignment.merchant_store_id }).whereNull("deleted_at").first();
      if (!zone || !policy || !assignment.medusa_service_zone_id) throw missing();
      const native = this.container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
      const name = "gospaza:" + option.id;
      const matches = await native.listShippingOptions({ name }, { take: null });
      if (matches.length > 1) throw schedulingConflict("Ambiguous native Shipping Options.");
      let existing = matches[0];
      if (option.medusa_shipping_option_id) {
        if (existing?.id !== option.medusa_shipping_option_id) throw schedulingConflict("Native Shipping Option mapping changed.");
        existing = await native.retrieveShippingOption(option.medusa_shipping_option_id);
      }
      if (existing && (existing.service_zone_id !== assignment.medusa_service_zone_id
        || existing.shipping_profile_id !== profileId || existing.provider_id !== "manual_manual"
        || existing.price_type !== "flat" || existing.data?.gospaza_configuration_id !== option.id)) {
        throw schedulingConflict("Incompatible native Shipping Option; no existing option overwritten.");
      }
      const enabled = zone.active && assignment.active && policy.enabled && option.enabled
        && (option.mode === "ASAP" ? policy.asap_enabled : policy.scheduled_enabled);
      const data = { gospaza_configuration_id: option.id, gospaza_revision: option.revision, id: "manual-fulfillment" };
      const prices = [{ currency_code: "zar", amount: Number(nativePrice(zone.delivery_fee_minor)) }];
      const rules = [{ attribute: "enabled_in_store", operator: "eq" as const, value: String(enabled) },
        { attribute: "is_return", operator: "eq" as const, value: "false" }];
      if (!existing) {
        const { result } = await createShippingOptionsWorkflow(this.container).run({ input: [{ name,
          service_zone_id: assignment.medusa_service_zone_id, shipping_profile_id: profileId, provider_id: "manual_manual",
          price_type: "flat", prices, data, rules,
          type: { label: option.mode === "ASAP" ? "ASAP delivery" : "Scheduled delivery", code: "gospaza_" + option.mode.toLowerCase() },
        }] });
        existing = result[0];
        if (!existing || result.length !== 1) throw schedulingConflict("Native option creation incomplete.");
      } else await updateShippingOptionsWorkflow(this.container).run({ input: [{ id: existing.id, price_type: "flat", prices, data, rules }] });
      // Persist native reference even if publication subsequently fails. The stable
      // name/data also recover creation interrupted before this write.
      await this.db("delivery_option_configuration").where({ id: option.id }).update({ medusa_shipping_option_id: existing.id });
      await this.assertNativePrice(existing.id, zone.delivery_fee_minor, option.revision);
      await this.db.transaction(async (trx) => {
        const published = await trx("delivery_option_configuration").where({ id: option.id, revision: option.revision, sync_state: "SYNCING" })
          .update({ synced_revision: option.revision, sync_state: "READY", sync_error: null, updated_at: new Date() });
        if (published !== 1) throw schedulingConflict("Configuration changed during synchronization; synchronize again.");
        await this.audit(trx, user, option.id, "OPTION_SYNCHRONIZED", reason, null,
          { revision: option.revision, fee_minor: zone.delivery_fee_minor, currency_code: "zar", enabled });
      });
    } catch (error) {
      await this.db("delivery_option_configuration").where({ id: option.id, revision: option.revision })
        .update({ sync_state: "FAILED", sync_error: "Native synchronization incomplete; explicitly synchronize again.", updated_at: new Date() });
      throw error;
    }
  }
  private async nativePrice(optionId: string) {
    const query = this.container.resolve<{
      graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }):
        Promise<{ data: { id: string; name: string; service_zone_id: string; provider_id: string; price_type: string;
          shipping_profile: { type: string } | null; rules: { attribute: string; operator: string; value: string | string[] }[];
          data: Record<string, unknown> | null; prices?: NativePrice[] }[] }>;
    }>(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({ entity: "shipping_option", fields: ["id", "name", "service_zone_id", "provider_id", "price_type", "shipping_profile.type", "rules.*", "data", "prices.*", "prices.price_rules.*"], filters: { id: optionId } });
    const option = data[0], prices = option?.prices;
    const price = prices?.[0];
    if (data.length !== 1 || prices?.length !== 1 || !price || price.currency_code !== "zar"
      || price.price_list_id || price.min_quantity != null || price.max_quantity != null || !price.price_rules || price.price_rules.length) {
      // Medusa's HTTP handler masks CONFLICT messages. Keep this readback
      // diagnostic in the server log without dumping native objects or metadata.
      const diagnostic = {
        option_count: data.length,
        price_count: prices?.length ?? "not_loaded",
        price_present: Boolean(price),
        currency_is_zar: price?.currency_code === "zar",
        has_price_list: Boolean(price?.price_list_id),
        has_min_quantity: price?.min_quantity != null,
        has_max_quantity: price?.max_quantity != null,
        price_rules_loaded: Array.isArray(price?.price_rules),
        price_rule_count: price?.price_rules?.length ?? "not_loaded",
      };
      throw schedulingConflict("Native shipping price is not the configured flat ZAR tariff. Readback: " + JSON.stringify(diagnostic));
    }
    if (!option || option.price_type !== "flat" || option.provider_id !== "manual_manual"
      || option.shipping_profile?.type !== "default") throw schedulingConflict("DELIVERY_CONFIGURATION_STALE");
    return { amount: price.amount, revision: option.data?.gospaza_revision, configurationId: option.data?.gospaza_configuration_id,
      name: option.name, serviceZoneId: option.service_zone_id, rules: option.rules };
  }
  private async assertNativePrice(id: string, tariff: number, revision: number) {
    const native = await this.nativePrice(id);
    if (minorPrice(native.amount) !== tariff || native.revision !== revision) throw schedulingConflict("DELIVERY_CONFIGURATION_STALE");
  }
  // Internal M9-C foundation only. No customer quote/selection route in M9-B.
  async resolveAssignment(storeId: string, latitude: number, longitude: number) {
    schedulingInput(coordinates, { latitude, longitude });
    const eligible = await new LocationService(this.container).eligibleLocation(latitude, longitude);
    if (!eligible.store_ids.includes(storeId)) throw schedulingConflict("Store is not serviceable.");
    const policy = await this.db<PolicyRow, PolicyRow[]>("store_delivery_policy").where({ merchant_store_id: storeId, enabled: true }).whereNull("deleted_at").first();
    if (!policy) throw schedulingConflict("Delivery is unavailable.");
    const rows = await this.db<Assignment, Assignment[]>("merchant_store_service_zone").where({ merchant_store_id: storeId, active: true }).whereNull("deleted_at");
    const candidates = [];
    for (const assignment of rows) {
      const zone = await this.db<Zone, Zone[]>("marketplace_service_zone").where({ id: assignment.service_zone_id, active: true }).whereNull("deleted_at").first();
      if (!zone || !geometryService.contains(zone.geometry, latitude, longitude)) continue;
      const options = await this.db<OptionRow, OptionRow[]>("delivery_option_configuration").where({ store_service_zone_id: assignment.id }).whereNull("deleted_at");
      candidates.push({ ...assignment, delivery_fee_minor: zone.delivery_fee_minor, currency_code: zone.currency_code,
        asap_enabled: policy.asap_enabled && options.some((o) => o.mode === "ASAP" && o.enabled),
        scheduled_enabled: policy.scheduled_enabled && options.some((o) => o.mode === "SCHEDULED" && o.enabled), options });
    }
    const winner = resolveDeliveryAssignment(candidates);
    if (!winner || !(winner.asap_enabled || winner.scheduled_enabled)) throw schedulingConflict("Delivery is unavailable.");
    for (const option of winner.options.filter((o) => o.enabled && (o.mode === "ASAP" ? winner.asap_enabled : winner.scheduled_enabled))) {
      if (!option.medusa_shipping_option_id) throw schedulingConflict("DELIVERY_CONFIGURATION_STALE");
      const native = await this.nativePrice(option.medusa_shipping_option_id);
      assertDeliverySynchronized(option, native.revision, native.amount, winner.delivery_fee_minor);
      if (native.configurationId !== option.id || native.name !== "gospaza:" + option.id
        || native.serviceZoneId !== winner.medusa_service_zone_id || native.rules.length !== 2
        || !native.rules.some((r) => r.attribute === "enabled_in_store" && r.operator === "eq" && r.value === "true")
        || !native.rules.some((r) => r.attribute === "is_return" && r.operator === "eq" && r.value === "false")) {
        throw schedulingConflict("DELIVERY_CONFIGURATION_STALE");
      }
    }
    return winner;
  }
}
