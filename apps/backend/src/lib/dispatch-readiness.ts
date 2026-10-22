import { DriverService } from "../modules/marketplace/driver-service";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { PickingService } from "./picking-service";
import { coordinates, geometryService, validateGeometry } from "../modules/marketplace/location-policy";
import type { Geometry } from "../modules/marketplace/location-policy";
import { dispatchConflict, dispatchNotBefore, dispatchParse } from "../modules/marketplace/dispatch-policy";
import type { DispatchPolicy } from "../modules/marketplace/dispatch-policy";
import type { DispatchConfigRow } from "../modules/marketplace/dispatch-rows";

interface Reservation { id: string; store_service_zone_id: string; delivery_option_id: string; delivery_slot_id: string; latitude: number | string | null; longitude: number | string | null }
interface Mapping { id: string; service_zone_id: string; medusa_service_zone_id: string | null }
interface Zone { id: string; geometry: Geometry }
interface Option { mode: "ASAP" | "SCHEDULED"; medusa_shipping_option_id: string | null }
interface Profile { medusa_product_id: string; merchant_id: string; requires_age_verification: boolean }

// Internal owner composition. Caller holds the target merchant lock before this
// method; PickingService owns physical accounting and M10/native linkage.
export async function dispatchReadiness(container: MedusaContainer, trx: Knex.Transaction,
  scope: { merchant_id: string; merchant_store_id: string; medusa_order_id: string }, policy: DispatchPolicy) {
  if (!await new DriverService(container).activeStore(scope.merchant_store_id, trx)) return dispatchConflict("DISPATCH_STORE_UNAVAILABLE");
  const state = await new PickingService(container).completedForDispatch(trx, scope.merchant_id, scope.merchant_store_id, scope.medusa_order_id);
  const hold = await trx<Reservation>("delivery_reservation").where({ id: state.handoff.reservation_id,
    status: "COMMITTED", medusa_order_id: scope.medusa_order_id, merchant_store_id: scope.merchant_store_id }).whereNull("deleted_at").first();
  if (!hold || hold.latitude === null || hold.longitude === null) return dispatchConflict("DISPATCH_READINESS");
  const mapping = await trx<Mapping>("merchant_store_service_zone").where({ id: hold.store_service_zone_id,
    merchant_store_id: scope.merchant_store_id, active: true }).whereNull("deleted_at").forShare().first();
  const zone = mapping ? await trx<Zone>("marketplace_service_zone").where({ id: mapping.service_zone_id, active: true }).whereNull("deleted_at").forShare().first() : undefined;
  if (!mapping?.medusa_service_zone_id || !zone) return dispatchConflict("DISPATCH_SERVICE_AREA");
  const geometry = validateGeometry(zone.geometry);
  const destination = dispatchParse(coordinates, { latitude: Number(hold.latitude), longitude: Number(hold.longitude) });
  if (!geometryService.contains(geometry, destination.latitude, destination.longitude)) return dispatchConflict("DISPATCH_SERVICE_AREA");
  const option = await trx<Option>("delivery_option_configuration").where({ id: hold.delivery_option_id,
    merchant_store_id: scope.merchant_store_id, store_service_zone_id: mapping.id }).whereNull("deleted_at").forShare().first();
  const slot = await trx<{ start_at: Date }>("delivery_slot").where({ id: hold.delivery_slot_id, merchant_store_id: scope.merchant_store_id }).whereNull("deleted_at").forShare().first();
  if (!option || !slot || option.medusa_shipping_option_id !== state.handoff.snapshot.shipping_option_id) return dispatchConflict("DISPATCH_SHIPPING");
  const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
  const fulfillment = await query.graph({ entity: "order_fulfillment", fields: ["order_id","fulfillment_id"], filters: { order_id: scope.medusa_order_id } });
  if (fulfillment.data.length) return dispatchConflict("DISPATCH_NATIVE_FULFILLMENT_EXISTS");
  const shipping = await query.graph({ entity: "shipping_option", fields: ["id", "service_zone_id", "service_zone.fulfillment_set.type"],
    filters: { id: option.medusa_shipping_option_id } });
  const shippingRows = z.array(z.object({ id: z.string(), service_zone_id: z.string(), service_zone: z.object({ fulfillment_set: z.object({ type: z.literal("shipping") }) }) })).safeParse(shipping.data);
  if (!shippingRows.success || shippingRows.data.length !== 1 || shippingRows.data[0]?.service_zone_id !== mapping.medusa_service_zone_id) return dispatchConflict("DISPATCH_SHIPPING");
  const variants = [...new Set(state.handoff.snapshot.items.map(item => item.variant_id))];
  const native = await query.graph({ entity: "product_variant", fields: ["id", "product.id"], filters: { id: variants } });
  const products = z.array(z.object({ id: z.string(), product: z.object({ id: z.string() }) })).parse(native.data);
  if (products.length !== variants.length || variants.some(id => !products.some(p => p.id === id))) return dispatchConflict("DISPATCH_PRODUCT_EVIDENCE");
  const productIds = [...new Set(products.map(p => p.product.id))];
  const profiles = await trx<Profile>("product_marketplace_profile").whereIn("medusa_product_id", productIds)
    .where({ merchant_id: scope.merchant_id }).whereNull("deleted_at").orderBy("medusa_product_id").forShare();
  if (profiles.length !== productIds.length) return dispatchConflict("DISPATCH_PRODUCT_EVIDENCE");
  const config = await trx<DispatchConfigRow>("store_dispatch_configuration").where({ merchant_store_id: scope.merchant_store_id }).forShare().first();
  return { operation: state.operation, session: state.session, hold, zone: { id: zone.id, geometry },
    config, notBefore: dispatchNotBefore(option.mode, new Date(slot.start_at), policy),
    restricted: profiles.some(p => p.requires_age_verification) };
}
