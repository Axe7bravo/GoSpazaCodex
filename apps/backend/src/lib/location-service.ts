import { createHash, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer, IFulfillmentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { createLocationFulfillmentSetWorkflow, createServiceZonesWorkflow } from "@medusajs/medusa/core-flows";
import { commerceLock } from "./commerce";
import { coordinates, input, zoneInput, geometryService, validateGeometry } from "../modules/marketplace/location-policy";
import type { Geometry, ZoneInput } from "../modules/marketplace/location-policy";

export interface ZoneRow extends ZoneInput { id: string }
interface StoreRow { id: string; merchant_id: string; name: string; active: boolean; medusa_stock_location_id: string | null; medusa_fulfillment_set_id: string | null }
interface MappingRow { id: string; merchant_store_id: string; service_zone_id: string; active: boolean; medusa_service_zone_id: string | null }
const missing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Zone or store not found.");
const conflict = () => new MedusaError(MedusaError.Types.CONFLICT, "Fulfillment infrastructure needs attention. Run the fulfillment backfill or contact support.");
export const zoneDTO = (z: ZoneRow) => ({
  id: z.id, name: z.name, active: z.active, geometry: z.geometry,
  delivery_fee_minor: z.delivery_fee_minor, currency_code: z.currency_code,
});
export class LocationService {
  private db: Knex;
  constructor(private container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  async zones() {
    return (await this.db<ZoneRow>("marketplace_service_zone").whereNull("deleted_at").orderBy("name")).map(zoneDTO);
  }
  async stores() {
    return this.db("merchant_store as s").join("merchant as m", "m.id", "s.merchant_id")
      .whereNull("s.deleted_at").whereNull("m.deleted_at")
      .select("s.id", "s.name", "s.active", "m.status as merchant_status").orderBy("s.name");
  }
  async zone(id: string) {
    const zone = await this.db<ZoneRow>("marketplace_service_zone").where({ id }).whereNull("deleted_at").first();
    if (!zone) throw missing();
    const assignments = await this.db("merchant_store_service_zone as a")
      .join("merchant_store as s", "s.id", "a.merchant_store_id")
      .where({ "a.service_zone_id": id }).whereNull("a.deleted_at").whereNull("s.deleted_at")
      .select("s.id", "s.name", "a.active").orderBy("s.name");
    return { zone: zoneDTO(zone), assignments };
  }
  private async audit(trx: Knex.Transaction, zoneId: string, user: string | undefined,
    action: string, before: unknown, after: unknown) {
    if (!user) return; // Internal backfill does not impersonate a platform user.
    await trx("service_zone_event").insert({
      id: "szevt_" + randomUUID(), service_zone_id: zoneId, platform_user_id: user, action,
      before_state: before === null ? null : JSON.stringify(before), after_state: JSON.stringify(after),
    });
  }
  async save(data: ZoneInput, id?: string, platformUserId?: string) {
    data = input(zoneInput, data);
    const geometry = validateGeometry(data.geometry);
    const fields = { ...data, geometry: JSON.stringify(geometry), updated_at: new Date() };
    const zoneId = id ?? "gszone_" + randomUUID();
    const snapshot = (row: ZoneInput) => ({
      name: row.name, active: row.active, delivery_fee_minor: row.delivery_fee_minor, currency_code: row.currency_code,
      geometry_sha256: createHash("sha256").update(JSON.stringify(row.geometry)).digest("hex"),
    });
    await this.db.transaction(async (trx) => {
      const before = id ? await trx<ZoneRow>("marketplace_service_zone").where({ id }).whereNull("deleted_at").forUpdate().first() : null;
      if (id && !before) throw missing();
      if (id) await trx("marketplace_service_zone").where({ id }).update(fields);
      else await trx("marketplace_service_zone").insert({ id: zoneId, ...fields });
      await this.audit(trx, zoneId, platformUserId, id ? "UPDATED" : "CREATED", before ? snapshot(before) : null, snapshot(data));
    });
    return this.zone(zoneId);
  }
  // Only explicit writes/backfill invoke this. Deterministic names recover a completed native
  // step after a process interruption before the custom reference was recorded.
  async ensureFulfillment(storeId: string) {
    return commerceLock(this.container, "fulfillment:" + storeId, () => this.ensureUnlocked(storeId));
  }
  private async ensureUnlocked(storeId: string) {
    const store = await this.db<StoreRow>("merchant_store").where({ id: storeId }).whereNull("deleted_at").first();
    if (!store) throw missing();
    if (!store.medusa_stock_location_id) throw conflict();
    const native = this.container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
    const name = "gospaza:" + storeId;
    let sets = await native.listFulfillmentSets({ name });
    if (store.medusa_fulfillment_set_id) {
      const set = await native.retrieveFulfillmentSet(store.medusa_fulfillment_set_id);
      if (set.name !== name || set.type !== "shipping") throw conflict();
      sets = [set];
    }
    if (!sets.length) {
      await createLocationFulfillmentSetWorkflow(this.container).run({ input: {
        location_id: store.medusa_stock_location_id, fulfillment_set_data: { name, type: "shipping" },
      } });
      sets = await native.listFulfillmentSets({ name });
    }
    const set = sets[0];
    if (sets.length !== 1 || !set || set.type !== "shipping") throw conflict();
    const query = this.container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: { stock_location_id: string }[] }> }>(ContainerRegistrationKeys.QUERY);
    const links = await query.graph({ entity: "location_fulfillment_set", fields: ["stock_location_id"], filters: { fulfillment_set_id: set.id } });
    if (links.data.some((link) => link.stock_location_id !== store.medusa_stock_location_id)) throw conflict();
    if (!links.data.length) {
      const link = this.container.resolve<{ create(input: Record<string, Record<string, string>>): Promise<unknown> }>(ContainerRegistrationKeys.LINK);
      await link.create({ [Modules.STOCK_LOCATION]: { stock_location_id: store.medusa_stock_location_id }, [Modules.FULFILLMENT]: { fulfillment_set_id: set.id } });
    }
    await this.db("merchant_store").where({ id: storeId }).update({ medusa_fulfillment_set_id: set.id, updated_at: new Date() });
    return set.id;
  }
  async assign(zoneId: string, storeId: string, active: boolean, platformUserId?: string) {
    return commerceLock(this.container, "fulfillment:" + storeId, async () => {
      await this.zone(zoneId);
      const store = await this.db<StoreRow>("merchant_store").where({ id: storeId }).whereNull("deleted_at").first();
      if (!store) throw missing();
      if (!active) {
        await this.db.transaction(async (trx) => {
          const previous = await trx<MappingRow>("merchant_store_service_zone")
            .where({ service_zone_id: zoneId, merchant_store_id: storeId }).first();
          await trx("merchant_store_service_zone").where({ service_zone_id: zoneId, merchant_store_id: storeId })
            .update({ active: false, updated_at: new Date() });
          if (previous?.active) await this.audit(trx, zoneId, platformUserId, "STORE_UNASSIGNED",
            { store_id: storeId, active: true }, { store_id: storeId, active: false });
        });
        return this.zone(zoneId);
      }
      const setId = await this.ensureUnlocked(storeId);
      await this.db("merchant_store_service_zone").insert({
        id: "mszone_" + randomUUID(), merchant_store_id: storeId, service_zone_id: zoneId, active: false,
      }).onConflict(["merchant_store_id", "service_zone_id"]).ignore();
      const mapping = await this.db<MappingRow>("merchant_store_service_zone").where({ merchant_store_id: storeId, service_zone_id: zoneId }).first();
      if (!mapping) throw conflict();
      const native = this.container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
      const name = "gospaza:" + mapping.id;
      let zones = await native.listServiceZones({ name });
      if (mapping.medusa_service_zone_id) zones = [await native.retrieveServiceZone(mapping.medusa_service_zone_id)];
      if (!zones.length) {
        const { result } = await createServiceZonesWorkflow(this.container).run({ input: { data: [{ name, fulfillment_set_id: setId, geo_zones: [] }] } });
        zones = result;
      }
      const zone = zones[0];
      if (zones.length !== 1 || !zone || zone.name !== name || zone.fulfillment_set_id !== setId) throw conflict();
      await this.db.transaction(async (trx) => {
        await trx("merchant_store_service_zone").where({ id: mapping.id })
          .update({ medusa_service_zone_id: zone.id, active: true, updated_at: new Date() });
        if (!mapping.active) await this.audit(trx, zoneId, platformUserId, "STORE_ASSIGNED",
          { store_id: storeId, active: false }, { store_id: storeId, active: true });
      });
      return this.zone(zoneId);
    });
  }
  // Internal authoritative result. Public M6 responses deliberately omit store IDs.
  async eligibleLocation(latitude: number, longitude: number) {
    input(coordinates, { latitude, longitude });
    // One SQL statement provides a coherent eligibility snapshot, including concurrent deactivation.
    const rows = await this.db("marketplace_service_zone as z")
      .leftJoin("merchant_store_service_zone as a", function () { this.on("a.service_zone_id", "=", "z.id"); })
      .leftJoin("merchant_store as s", "s.id", "a.merchant_store_id")
      .leftJoin("merchant as m", "m.id", "s.merchant_id")
      .where({ "z.active": true }).whereNull("z.deleted_at")
      .select("z.id", "z.geometry", "a.active as mapping_active", "a.deleted_at as mapping_deleted",
        "s.id as store_id", "s.active as store_active", "s.deleted_at as store_deleted",
        "m.status as merchant_status", "m.deleted_at as merchant_deleted") as {
          id: string; geometry: Geometry; mapping_active: boolean | null; mapping_deleted: Date | null;
          store_id: string | null; store_active: boolean | null; store_deleted: Date | null;
          merchant_status: string | null; merchant_deleted: Date | null;
        }[];
    const zones = new Set<string>(), stores = new Set<string>();
    const matches = new Map<string, boolean>();
    for (const row of rows) {
      if (!matches.has(row.id)) matches.set(row.id, geometryService.contains(row.geometry, latitude, longitude));
      if (!matches.get(row.id)) continue;
      zones.add(row.id);
      if (row.store_id && row.mapping_active && !row.mapping_deleted && row.store_active && !row.store_deleted &&
          row.merchant_status === "ACTIVE" && !row.merchant_deleted) stores.add(row.store_id);
    }
    return { store_ids: [...stores].sort(), zone_ids: [...zones].sort() };
  }
  async serviceability(latitude: number, longitude: number) {
    const result = await this.eligibleLocation(latitude, longitude);
    return { serviceable: result.store_ids.length > 0, eligible_store_count: result.store_ids.length, zone_ids: result.zone_ids };
  }
}
