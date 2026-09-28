import type { MedusaContainer, ICustomerModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { coordinates, input } from "../modules/marketplace/location-policy";
import { LocationService } from "./location-service";
import { usableCommerceStores } from "./commerce";
import type { CommerceReference } from "./commerce";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const numeric = z.union([z.number(), z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).transform(Number)]);
export const discoveryInput = z.object({
  address_id: identifier.optional(),
  latitude: numeric.pipe(z.number().finite().min(-90).max(90)).optional(),
  longitude: numeric.pipe(z.number().finite().min(-180).max(180)).optional(),
  q: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict().refine((value) => value.address_id
  ? value.latitude === undefined && value.longitude === undefined
  : value.latitude !== undefined && value.longitude !== undefined, "Choose one location source.");
export type DiscoveryInput = z.infer<typeof discoveryInput>;
export const publicIdentifier = (value: unknown) => input(identifier, value);
export const publicStore = (store: CommerceReference) => ({
  id: store.id, name: store.name, availability: "available" as const,
});
export const marketplaceMode = (count: number) => count === 0 ? "none" as const : count === 1 ? "single" as const : "multiple" as const;
export const storefrontMissing = () => new MedusaError(MedusaError.Types.NOT_FOUND, "Store or product is unavailable at this location.");

export class DiscoveryService {
  private db: Knex;
  constructor(private container: MedusaContainer, private customerId: string) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  }
  private async point(filters: DiscoveryInput) {
    if (!filters.address_id) return input(coordinates, { latitude: filters.latitude, longitude: filters.longitude });
    const [address] = await this.container.resolve<ICustomerModuleService>(Modules.CUSTOMER)
      .listCustomerAddresses({ id: filters.address_id, customer_id: this.customerId }, { take: 1 });
    if (!address) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Address unavailable.");
    const location = await this.db<{ latitude: number; longitude: number }>("customer_address_location")
      .where({ medusa_customer_address_id: address.id }).whereNull("deleted_at").first();
    if (!location) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Choose an address with coordinates or use current location.");
    return input(coordinates, { latitude: Number(location.latitude), longitude: Number(location.longitude) });
  }
  async eligible(filters: DiscoveryInput) {
    const point = await this.point(filters);
    const eligible = await new LocationService(this.container).eligibleLocation(point.latitude, point.longitude);
    if (!eligible.store_ids.length) return [];
    const stores = await this.db("merchant_store as s").join("merchant as m", "m.id", "s.merchant_id")
      .whereIn("s.id", eligible.store_ids).where({ "s.active": true, "m.status": "ACTIVE" })
      .whereNull("s.deleted_at").whereNull("m.deleted_at")
      .select("s.id", "s.merchant_id", "s.name", "s.medusa_stock_location_id", "m.medusa_sales_channel_id")
      .orderBy("s.name").orderBy("s.id") as CommerceReference[];
    return usableCommerceStores(this.container, stores);
  }
  async list(filters: DiscoveryInput) {
    const stores = await this.eligible(filters);
    return {
      mode: marketplaceMode(stores.length), eligible_store_count: stores.length,
      stores: stores.slice(filters.offset, filters.offset + filters.limit).map(publicStore),
      count: stores.length, limit: filters.limit, offset: filters.offset,
    };
  }
  async store(filters: DiscoveryInput, id: string) {
    const store = (await this.eligible(filters)).find((row) => row.id === id);
    if (!store) throw storefrontMissing();
    return { store: publicStore(store) };
  }
}
