import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { deleteSalesChannelsWorkflow, deleteStockLocationsWorkflow } from "@medusajs/medusa/core-flows";

// Caller supplies only IDs resolved from this run's tracked synthetic applications.
export async function cleanupFixtureCommerce(container: MedusaContainer, merchantIds: string[]) {
  if (!merchantIds.length) return;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const channels = await db<{ medusa_sales_channel_id: string | null }>("merchant").whereIn("id", merchantIds).select("medusa_sales_channel_id");
  const locations = await db<{ medusa_stock_location_id: string | null }>("merchant_store").whereIn("merchant_id", merchantIds).select("medusa_stock_location_id");
  const locationIds = locations.flatMap((row) => row.medusa_stock_location_id ? [row.medusa_stock_location_id] : []);
  const channelIds = channels.flatMap((row) => row.medusa_sales_channel_id ? [row.medusa_sales_channel_id] : []);
  if (locationIds.length) await deleteStockLocationsWorkflow(container).run({ input: { ids: locationIds } });
  if (channelIds.length) await deleteSalesChannelsWorkflow(container).run({ input: { ids: channelIds } });
}
