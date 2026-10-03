import type { AuthenticatedMedusaRequest, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { ICustomerModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { deleteCustomerAddressesWorkflow } from "@medusajs/medusa/core-flows";
import { LocationService } from "./location-service";
import { commerceLock } from "./commerce";
import { addressInput, coordinates, input, zoneInput } from "../modules/marketplace/location-policy";
import { createAddressLocationWorkflow, updateAddressLocationWorkflow } from "../workflows/save-customer-location";

function actor(req: MedusaRequest, type: "customer" | "user") {
  const context = (req as AuthenticatedMedusaRequest).auth_context;
  if (!context?.actor_id || context.actor_type !== type) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Sign in required.");
  return context.actor_id;
}
function param(req: MedusaRequest, name = "id") {
  return input(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), req.params[name]);
}
function reply(res: MedusaResponse, body: unknown, status = 200) {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json(body);
}
export async function listZones(req: MedusaRequest, res: MedusaResponse) {
  actor(req, "user");
  const service = new LocationService(req.scope);
  reply(res, { zones: await service.zones(), stores: await service.stores() });
}
export async function getZone(req: MedusaRequest, res: MedusaResponse) {
  actor(req, "user");
  reply(res, await new LocationService(req.scope).zone(param(req)));
}
export const saveZone = (create: boolean) => async (req: MedusaRequest, res: MedusaResponse) => {
  const user = actor(req, "user");
  reply(res, await new LocationService(req.scope).save(input(zoneInput, req.body), create ? undefined : param(req), user), create ? 201 : 200);
};
export const assignStore = (active: boolean) => async (req: MedusaRequest, res: MedusaResponse) => {
  const user = actor(req, "user");
  const storeId = active ? input(z.object({ merchant_store_id: z.string().regex(/^mstore_[a-zA-Z0-9-]{1,80}$/) }).strict(), req.body).merchant_store_id : param(req, "storeId");
  reply(res, await new LocationService(req.scope).assign(param(req), storeId, active, user));
};
export async function serviceability(req: MedusaRequest, res: MedusaResponse) {
  actor(req, "customer");
  const point = input(coordinates, req.body);
  reply(res, await new LocationService(req.scope).serviceability(point.latitude, point.longitude));
}
function customer(req: MedusaRequest) { return req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER); }
async function owned(req: MedusaRequest, customerId: string, id: string) {
  const [address] = await customer(req).listCustomerAddresses({ id, customer_id: customerId });
  if (!address) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Address not found.");
  return address;
}
export async function listAddresses(req: MedusaRequest, res: MedusaResponse) {
  const customerId = actor(req, "customer");
  const addresses = await customer(req).listCustomerAddresses({ customer_id: customerId }, { take: null });
  const db = req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const locations = addresses.length ? await db("customer_address_location")
    .whereIn("medusa_customer_address_id", addresses.map((a) => a.id)).whereNull("deleted_at")
    .select("medusa_customer_address_id", "latitude", "longitude", "source") : [];
  reply(res, { addresses: addresses.map((address) => {
    const location = locations.find((l) => l.medusa_customer_address_id === address.id);
    return { id: address.id, first_name: address.first_name, last_name: address.last_name,
      address_1: address.address_1, address_2: address.address_2, city: address.city,
      province: address.province, postal_code: address.postal_code, country_code: address.country_code,
      phone: address.phone, location: location ? { latitude: location.latitude, longitude: location.longitude, source: location.source } : null };
  }) });
}
export const saveAddress = (create: boolean) => async (req: MedusaRequest, res: MedusaResponse) => {
  const customerId = actor(req, "customer"), data = input(addressInput, req.body);
  await commerceLock(req.scope, "address:" + customerId, async () => {
    if (create) {
      await createAddressLocationWorkflow(req.scope).run({ input: { customerId, data } });
    } else {
      const id = param(req);
      await owned(req, customerId, id);
      await updateAddressLocationWorkflow(req.scope).run({ input: { customerId, id, data } });
    }
  });
  reply(res, { success: true }, create ? 201 : 200);
};
export async function deleteAddress(req: MedusaRequest, res: MedusaResponse) {
  const customerId = actor(req, "customer"), id = param(req);
  await commerceLock(req.scope, "address:" + customerId, async () => {
    await owned(req, customerId, id);
    // Remove coordinates first: a native-delete failure leaves an owned, usable address
    // without stale coordinates. A retry is safe and no orphan coordinates can escape.
    await req.scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("customer_address_location")
      .where({ medusa_customer_address_id: id }).delete();
    await deleteCustomerAddressesWorkflow(req.scope).run({ input: { ids: [id] } });
  });
  reply(res, { success: true });
}
