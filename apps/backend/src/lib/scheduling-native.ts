import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { IFulfillmentModuleService, MedusaContainer } from "@medusajs/framework/types";
import { batchLinksWorkflow, createShippingProfilesWorkflow, updateProductsWorkflow, updateServiceZonesWorkflow } from "@medusajs/medusa/core-flows";
import { commerceLock } from "./commerce";
import { schedulingConflict } from "../modules/marketplace/scheduling-policy";

export async function ensureShippingProfile(container: MedusaContainer) {
  return commerceLock(container, "shipping-profile", async () => {
    const native = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
    const profiles = await native.listShippingProfiles({ type: "default" }, { take: null });
    if (profiles.length > 1) throw schedulingConflict("Multiple default Shipping Profiles; resolve explicitly.");
    if (profiles[0]) return profiles[0].id;
    const { result } = await createShippingProfilesWorkflow(container).run({ input: {
      data: [{ name: "Default Shipping Profile", type: "default" }],
    } });
    const profile = result[0];
    if (!profile || result.length !== 1) throw schedulingConflict("Shipping Profile provisioning incomplete.");
    return profile.id;
  });
}

export async function backfillProductProfiles(container: MedusaContainer, productIds: string[], profileId: string) {
  if (!productIds.length) return;
  const query = container.resolve<{
    graph(input: { entity: string; fields: string[]; filters: Record<string, unknown>; pagination: { take: null } }):
      Promise<{ data: { id: string; shipping_profile?: { id: string } | null }[] }>;
  }>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "product", fields: ["id", "shipping_profile.id"],
    filters: { id: productIds }, pagination: { take: null } });
  if (data.length !== new Set(productIds).size || data.some((p) => p.shipping_profile && p.shipping_profile.id !== profileId)) {
    throw schedulingConflict("Missing product or incompatible Shipping Profile; no profiles overwritten.");
  }
  const missing = data.filter((p) => !p.shipping_profile);
  if (missing.length) await updateProductsWorkflow(container).run({ input: {
    products: missing.map((p) => ({ id: p.id, shipping_profile_id: profileId })),
  } });
}

export async function ensureSouthAfricaGeoZone(container: MedusaContainer, zoneId: string, setId: string, assignmentId: string) {
  const native = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
  const zone = await native.retrieveServiceZone(zoneId, { relations: ["geo_zones"] });
  if (zone.name !== "gospaza:" + assignmentId || zone.fulfillment_set_id !== setId) {
    throw schedulingConflict("Native Service Zone does not match the existing store assignment.");
  }
  const geos = zone.geo_zones;
  if (!geos) throw schedulingConflict("Native geo-zone relation was not loaded.");
  if (geos.length === 1 && geos[0]?.type === "country" && geos[0].country_code === "za") return;
  if (geos.length) throw schedulingConflict("Incompatible native geo zones; explicit reconciliation required.");
  await updateServiceZonesWorkflow(container).run({ input: {
    selector: { id: zoneId }, update: { geo_zones: [{ type: "country", country_code: "za" }] },
  } });
}

// Caller holds the existing store fulfillment lock. Provider registration and
// location enablement are separate native concerns in Medusa 2.18.
export async function ensureLocationFulfillmentProvider(container: MedusaContainer, locationId: string) {
  const native = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
  const providers = await native.listFulfillmentProviders({ id: "manual_manual" });
  const provider = providers[0];
  if (providers.length !== 1 || !provider || !("is_enabled" in provider) || provider.is_enabled !== true) {
    throw schedulingConflict("Configured manual fulfillment provider is not enabled.");
  }
  const query = container.resolve<{
    graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }):
      Promise<{ data: { id: string; fulfillment_providers: { id: string }[] }[] }>;
  }>(ContainerRegistrationKeys.QUERY);
  const read = async () => {
    const { data } = await query.graph({ entity: "stock_location", fields: ["id", "fulfillment_providers.id"], filters: { id: locationId } });
    const location = data[0];
    if (data.length !== 1 || !location || !Array.isArray(location.fulfillment_providers)) {
      throw schedulingConflict("Stock Location provider associations could not be loaded.");
    }
    const matches = location.fulfillment_providers.filter((item) => item.id === provider.id);
    if (matches.length > 1) throw schedulingConflict("Duplicate Stock Location provider associations.");
    return matches.length === 1;
  };
  if (await read()) return;
  // Same public workflow and link shape used by the pinned native Admin API.
  await batchLinksWorkflow(container).run({ input: { create: [{
    [Modules.STOCK_LOCATION]: { stock_location_id: locationId },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: provider.id },
  }] } });
  if (!await read()) throw schedulingConflict("Stock Location provider association is incomplete.");
}
