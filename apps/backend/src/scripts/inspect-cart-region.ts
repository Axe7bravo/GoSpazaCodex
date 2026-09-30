import type { ExecArgs, IRegionModuleService, IStoreModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

// Read-only M8-B prerequisite diagnosis. Never creates or changes configuration.
export default async function inspectCartRegion({ container }: ExecArgs) {
  const stores = await container.resolve<IStoreModuleService>(Modules.STORE)
    .listStores({}, { select: ["id", "default_region_id"], take: null });
  const regions = await container.resolve<IRegionModuleService>(Modules.REGION)
    .listRegions({}, { relations: ["countries"], take: null });
  console.log(JSON.stringify({
    stores: stores.map((store) => ({ id: store.id, default_region_id: store.default_region_id ?? null })),
    regions: regions.map((region) => ({
      id: region.id, currency_code: region.currency_code,
      countries: region.countries.map((country) => country.iso_2),
    })),
  }, null, 2));
}
