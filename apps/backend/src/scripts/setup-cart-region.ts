import type { ExecArgs, IRegionModuleService, IStoreModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { createRegionsWorkflow, updateStoresWorkflow } from "@medusajs/medusa/core-flows";
import { commerceLock } from "../lib/commerce";
import { assertCartRegion } from "../modules/marketplace/cart-policy";

// Explicit local setup, never called by cart reads, creation, or verification.
export default async function setupCartRegion({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("This setup script is for development/test only.");
  }
  await commerceLock(container, "cart-region-setup", async () => {
    const storeModule = container.resolve<IStoreModuleService>(Modules.STORE);
    const regionModule = container.resolve<IRegionModuleService>(Modules.REGION);
    const stores = await storeModule.listStores({}, { take: 2 });
    const store = stores[0];
    if (stores.length !== 1 || !store) throw new Error("Expected exactly one native Store; no configuration changed.");

    if (store.default_region_id) {
      const region = await regionModule.retrieveRegion(store.default_region_id, { relations: ["countries"] });
      assertCartRegion(region);
      console.log("Existing default ZA/ZAR region is valid: " + region.id);
      return;
    }

    const regions = await regionModule.listRegions({}, { relations: ["countries"], take: null });
    const candidates = regions.filter((region) => region.countries.some((country) => country.iso_2 === "za"));
    if (candidates.length > 1) throw new Error("Multiple ZA regions found; choose the intended default explicitly.");
    let regionId: string;
    if (candidates[0]) {
      assertCartRegion(candidates[0]);
      regionId = candidates[0].id;
    } else {
      const { result } = await createRegionsWorkflow(container).run({ input: {
        regions: [{ name: "South Africa", currency_code: "zar", countries: ["za"] }],
      } });
      const created = result[0];
      if (!created) throw new Error("Native region creation returned no region.");
      regionId = created.id;
    }

    // If this update fails, keep the valid region for a safe rerun rather than
    // deleting configuration that may already be in use.
    await updateStoresWorkflow(container).run({ input: {
      selector: { id: store.id }, update: { default_region_id: regionId },
    } });
    const updated = await storeModule.retrieveStore(store.id);
    if (updated.default_region_id !== regionId) throw new Error("Default region assignment was not persisted.");
    const region = await regionModule.retrieveRegion(regionId, { relations: ["countries"] });
    assertCartRegion(region);
    console.log("Native Store " + store.id + " now defaults to ZA/ZAR region " + region.id);
  });
}
