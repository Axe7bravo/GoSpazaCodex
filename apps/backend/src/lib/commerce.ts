import { createHash } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer, IStockLocationService, ISalesChannelModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { provisionCommerceWorkflow } from "../workflows/provision-commerce";

export interface StoreRow {
  id: string; merchant_id: string; name: string;
  address_line_1: string; address_line_2: string; city: string; province: string;
  postal_code: string; country_code: string; medusa_stock_location_id: string | null;
}
export const commerceUnavailable = () => new MedusaError(MedusaError.Types.CONFLICT, "Catalogue infrastructure is unavailable. Contact support.");
export async function commerceLock<T>(container: MedusaContainer, merchantId: string, work: () => Promise<T>): Promise<T> {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  return db.transaction(async (trx) => {
    const key = createHash("sha256").update("gospaza:commerce:" + merchantId).digest().readBigInt64BE().toString();
    await trx.raw("SET LOCAL lock_timeout = '10s'");
    await trx.raw("select pg_advisory_xact_lock(?::bigint)", [key]);
    return work();
  });
}
export async function commerceContext(container: MedusaContainer, merchantId: string) {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const merchant = await db<{ medusa_sales_channel_id: string | null }>("merchant")
    .where({ id: merchantId, status: "ACTIVE" }).whereNull("deleted_at").first();
  const store = await db<StoreRow>("merchant_store").where({ merchant_id: merchantId }).whereNull("deleted_at").first();
  const unavailable = () => {
    container.resolve<{ error(message: string): void }>(ContainerRegistrationKeys.LOGGER).error("Catalogue infrastructure unavailable for merchant " + merchantId);
    return commerceUnavailable();
  };
  if (!merchant?.medusa_sales_channel_id || !store?.medusa_stock_location_id) throw unavailable();
  const channel = await container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL)
    .retrieveSalesChannel(merchant.medusa_sales_channel_id).catch(() => { throw unavailable(); });
  await container.resolve<IStockLocationService>(Modules.STOCK_LOCATION)
    .retrieveStockLocation(store.medusa_stock_location_id).catch(() => { throw unavailable(); });
  const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: { stock_location_id: string }[] }> }>(ContainerRegistrationKeys.QUERY);
  const links = await query.graph({ entity: "sales_channel_location", fields: ["stock_location_id"], filters: { sales_channel_id: channel.id } });
  if (channel.is_disabled || links.data.length !== 1 || links.data[0]?.stock_location_id !== store.medusa_stock_location_id) {
    container.resolve<{ error(message: string): void }>(ContainerRegistrationKeys.LOGGER).error("Invalid catalogue topology for merchant " + merchantId);
    throw commerceUnavailable();
  }
  return { channelId: channel.id, locationId: store.medusa_stock_location_id, store };
}
// Call only from explicit provisioning/backfill or a write workflow, never from GET.
export async function ensureCommerce(container: MedusaContainer, merchantId: string) {
  return commerceLock(container, merchantId, async () => {
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const merchant = await db<{ id: string; medusa_sales_channel_id: string | null }>("merchant")
      .where({ id: merchantId, status: "ACTIVE" }).whereNull("deleted_at").first();
    const store = await db<StoreRow>("merchant_store").where({ merchant_id: merchantId }).whereNull("deleted_at").first();
    if (!merchant || !store) throw commerceUnavailable();
    if (merchant.medusa_sales_channel_id && store.medusa_stock_location_id) return commerceContext(container, merchantId);
    if (merchant.medusa_sales_channel_id || store.medusa_stock_location_id) throw commerceUnavailable();
    await provisionCommerceWorkflow(container).run({ input: {
      merchantId, storeId: store.id, name: store.name,
      address: { address_1: store.address_line_1, address_2: store.address_line_2, city: store.city,
        province: store.province, postal_code: store.postal_code, country_code: store.country_code.toLowerCase() },
    } });
    return commerceContext(container, merchantId);
  });
}

export interface CommerceReference {
  id: string;
  merchant_id: string;
  name: string;
  medusa_sales_channel_id: string | null;
  medusa_stock_location_id: string | null;
}

// Batch the same native topology check used by merchant catalogue reads.
// Missing/disabled infrastructure is excluded; operational query failures propagate.
export async function usableCommerceStores(container: MedusaContainer, stores: CommerceReference[]) {
  const candidates = stores.filter((store) => store.medusa_sales_channel_id && store.medusa_stock_location_id);
  if (!candidates.length) return [];
  const channelIds = candidates.map((store) => store.medusa_sales_channel_id!);
  const locationIds = candidates.map((store) => store.medusa_stock_location_id!);
  const query = container.resolve<{
    graph(input: { entity: string; fields: string[]; filters: Record<string, unknown>; pagination: { take: null } }):
      Promise<{ data: { sales_channel_id: string; stock_location_id: string }[] }>;
  }>(ContainerRegistrationKeys.QUERY);
  const [channels, locations, links] = await Promise.all([
    container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL).listSalesChannels({ id: channelIds }, { take: null }),
    container.resolve<IStockLocationService>(Modules.STOCK_LOCATION).listStockLocations({ id: locationIds }, { take: null }),
    query.graph({ entity: "sales_channel_location", fields: ["sales_channel_id", "stock_location_id"],
      filters: { sales_channel_id: channelIds }, pagination: { take: null } }),
  ]);
  const enabled = new Set(channels.filter((channel) => !channel.is_disabled).map((channel) => channel.id));
  const existing = new Set(locations.map((location) => location.id));
  return candidates.filter((store) => {
    const linked = links.data.filter((link) => link.sales_channel_id === store.medusa_sales_channel_id);
    return enabled.has(store.medusa_sales_channel_id!) && existing.has(store.medusa_stock_location_id!)
      && linked.length === 1 && linked[0]?.stock_location_id === store.medusa_stock_location_id;
  });
}
