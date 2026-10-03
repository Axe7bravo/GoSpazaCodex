import { approveMerchantWorkflow } from "../workflows/approve-merchant";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICustomerModuleService, IUserModuleService, IFulfillmentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type MarketplaceService from "../modules/marketplace/service";
import { LocationService } from "../lib/location-service";
import { ensureCommerce } from "../lib/commerce";
import { cleanupFixtureCommerce } from "./fixture-commerce-cleanup";
import type { Geometry } from "../modules/marketplace/location-policy";

export default async function verifyLocation({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M6 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
  const market = container.resolve<MarketplaceService>("marketplace");
  const service = new LocationService(container);
  const prefix = "m6-" + randomUUID(), password = randomBytes(24).toString("hex");
  const identities: string[] = [], customerIds: string[] = [], userIds: string[] = [];
  const appIds: string[] = [], merchantIds: string[] = [], zoneIds: string[] = [], cookies: string[] = [];
  const failures: unknown[] = [];
  const key = await keys.createApiKeys({ title: prefix, type: "publishable", created_by: prefix });
  async function call(path: string, cookie = "", method = "GET", body?: unknown, token?: string) {
    return fetch(new URL(path, base), {
      method, signal: AbortSignal.timeout(30000),
      headers: { "x-publishable-api-key": key.token, ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function status(response: Promise<Response>, expected: number) {
    const result = await response;
    assert.equal(result.status, expected, "M6 HTTP status");
    return result;
  }
  async function session(actor: "customer" | "user" | "merchant", suffix: string) {
    const email = prefix + "-" + suffix + "@example.test";
    const result = await auth.register("emailpass", { body: { email, password } });
    assert.ok(result.authIdentity);
    identities.push(result.authIdentity.id);
    let actorId = result.authIdentity.id;
    if (actor === "customer") {
      const customer = await customers.createCustomers({ email, has_account: true });
      customerIds.push(customer.id); actorId = customer.id;
    } else if (actor === "user") {
      const user = await users.createUsers({ email });
      userIds.push(user.id); actorId = user.id;
    }
    await auth.updateAuthIdentities({ id: result.authIdentity.id, app_metadata: { [actor + "_id"]: actorId } });
    const login = await status(call("/auth/" + actor + "/emailpass", "", "POST", { email, password }), 200);
    const { token } = await login.json() as { token: string };
    const exchange = await status(call("/auth/session", "", "POST", undefined, token), 200);
    const cookie = exchange.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    assert.ok(cookie); cookies.push(cookie);
    return { cookie, identity: result.authIdentity.id, email };
  }
  const geometry: Geometry = { type: "Polygon", coordinates: [[[20, -20], [21, -20], [21, -19], [20, -19], [20, -20]]] };
  const zone = { name: prefix, active: true, geometry, delivery_fee_minor: 2500, currency_code: "zar" as const };
  try {
    const admin = await session("user", "admin"), a = await session("customer", "a"), b = await session("customer", "b");
    const merchant = await session("merchant", "merchant");
    await status(call("/admin/gospaza/service-zones", a.cookie), 401);
    await status(call("/admin/gospaza/service-zones", merchant.cookie, "POST", zone), 401);
    await status(call("/admin/gospaza/service-zones", "", "POST", zone), 401);
    const app = await market.createDraft(merchant.identity);
    assert.ok(app); appIds.push(app.id);
    await market.edit(app.id, merchant.identity, {
      legal_name: prefix, trading_name: prefix, contact_name: "Fixture", contact_email: merchant.email,
      contact_phone: "0123456789", address_line_1: "1 Fixture Street", address_line_2: "",
      city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "ZA",
      intends_to_sell_alcohol: false, notes: "M6 synthetic",
    });
    await market.submit(app.id, merchant.identity);
    await market.review(app.id, userIds[0]!, "start-review");
    const tenant = await market.provision(app.id, userIds[0]!, "M6 fixture");
    merchantIds.push(tenant.merchant.id);
    const commerce = await ensureCommerce(container, tenant.merchant.id);
    const storeId = commerce.store.id;
    await approveMerchantWorkflow(container).run({ input: { applicationId: app.id, platformUserId: userIds[0]!, reason: "M6 retry approval" } });
    const ids = await Promise.all([service.ensureFulfillment(storeId), service.ensureFulfillment(storeId)]);
    assert.equal(ids[0], ids[1]);
    assert.equal(await service.ensureFulfillment(storeId), ids[0], "repeated backfill reuses fulfillment");
    assert.equal((await fulfillment.listFulfillmentSets({ name: "gospaza:" + storeId })).length, 1);
    for (let i = 0; i < 2; i++) {
      const created = await status(call("/admin/gospaza/service-zones", admin.cookie, "POST", { ...zone, name: prefix + "-" + i }), 201);
      const data = await created.json() as { zone: { id: string } };
      zoneIds.push(data.zone.id);
      const event = await db("service_zone_event").where({ service_zone_id: data.zone.id, action: "CREATED" }).first();
      assert.equal(event.platform_user_id, userIds[0]);
      await assert.rejects(db("service_zone_event").where({ id: event.id }).update({ action: "UPDATED" }));
      await Promise.all([service.assign(data.zone.id, storeId, true), service.assign(data.zone.id, storeId, true)]);
      assert.equal(Number((await db("merchant_store_service_zone").where({ merchant_store_id: storeId, service_zone_id: data.zone.id }).count("* as count").first())?.count), 1);
      const mapping = await db("merchant_store_service_zone").where({ merchant_store_id: storeId, service_zone_id: data.zone.id }).first();
      assert.equal((await fulfillment.listServiceZones({ name: "gospaza:" + mapping.id })).length, 1);
      await assert.rejects(db("merchant_store_service_zone").insert({
        id: "mszone_" + randomUUID(), merchant_store_id: storeId, service_zone_id: data.zone.id, active: false,
      }), "database enforces mapping uniqueness");
    }
    const point = { latitude: -19.5, longitude: 20.5 };
    const baseline = await service.serviceability(point.latitude, point.longitude);
    assert.ok(baseline.serviceable);
    // Other local data may overlap; compare deltas without changing unrelated rows.
    await db("merchant_store").where({ id: storeId }).update({ active: false });
    assert.equal((await service.serviceability(point.latitude, point.longitude)).eligible_store_count, baseline.eligible_store_count - 1);
    await db("merchant_store").where({ id: storeId }).update({ active: true });
    await db("merchant").where({ id: tenant.merchant.id }).update({ status: "SUSPENDED" });
    assert.equal((await service.serviceability(point.latitude, point.longitude)).eligible_store_count, baseline.eligible_store_count - 1);
    await db("merchant").where({ id: tenant.merchant.id }).update({ status: "ACTIVE" });
    for (const zoneId of zoneIds) await service.assign(zoneId, storeId, false);
    assert.equal((await service.serviceability(point.latitude, point.longitude)).eligible_store_count, baseline.eligible_store_count - 1);
    for (const zoneId of zoneIds) {
      await service.assign(zoneId, storeId, true);
      await service.save({ ...zone, active: false }, zoneId);
    }
    assert.equal((await service.serviceability(point.latitude, point.longitude)).eligible_store_count, baseline.eligible_store_count - 1);
    for (const zoneId of zoneIds) await service.save(zone, zoneId);
    const eligible = await status(call("/store/gospaza/serviceability", a.cookie, "POST", point), 200);
    const summary = await eligible.json() as { serviceable: boolean; eligible_store_count: number; zone_ids: string[] };
    assert.deepEqual(Object.keys(summary).sort(), ["eligible_store_count", "serviceable", "zone_ids"]);
    assert.equal(summary.eligible_store_count, baseline.eligible_store_count);
    for (const id of zoneIds) assert.ok(summary.zone_ids.includes(id));
    await status(call("/store/gospaza/addresses", "", "GET"), 401);
    await status(call("/store/gospaza/addresses", merchant.cookie, "GET"), 401);
    for (const bad of [{ ...point, zone_id: zoneIds[0] }, { ...point, merchant_store_id: storeId }, { latitude: 91, longitude: 0 }]) {
      await status(call("/store/gospaza/serviceability", a.cookie, "POST", bad), 400);
    }
    const address = { first_name: "Fixture", last_name: "Customer", address_1: "1 Example Street",
      address_2: "", city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "za",
      phone: "", location: { ...point, source: "browser_geolocation" } };
    await status(call("/store/gospaza/addresses", a.cookie, "POST", address), 201);
    const addresses = await (await status(call("/store/gospaza/addresses", a.cookie), 200)).json() as { addresses: { id: string; location: { latitude: number } }[] };
    assert.equal(addresses.addresses.length, 1);
    const addressId = addresses.addresses[0]!.id;
    assert.equal(addresses.addresses[0]!.location.latitude, point.latitude);
    assert.equal((await (await status(call("/store/gospaza/addresses", b.cookie), 200)).json() as { addresses: unknown[] }).addresses.length, 0);
    await status(call("/store/gospaza/addresses/" + addressId, b.cookie, "PATCH", address), 404);
    await status(call("/store/gospaza/addresses/" + addressId, b.cookie, "DELETE"), 404);
    await status(call("/store/gospaza/addresses", a.cookie, "POST", { ...address, customer_id: customerIds[1] }), 400);
    await status(call("/store/gospaza/addresses/" + addressId, a.cookie, "PATCH", { ...address, address_1: "2 Example Street", location: null }), 200);
    assert.equal(await db("customer_address_location").where({ medusa_customer_address_id: addressId }).first(), undefined);
    await status(call("/store/gospaza/addresses/" + addressId, a.cookie, "DELETE"), 200);
  } catch (error) { failures.push(error); }
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await work(); return true; } catch { failures.push(new Error("M6 cleanup failed: " + name + "; fixture prefix " + prefix)); return false; }
  };
  for (const cookie of cookies) await cleanup("session", async () => { await status(call("/auth/session", cookie, "DELETE"), 200); });
  const addressesRemoved = await cleanup("addresses", async () => {
    for (const customerId of customerIds) {
      const addresses = await customers.listCustomerAddresses({ customer_id: customerId }, { take: null });
      if (addresses.length) await db("customer_address_location").whereIn("medusa_customer_address_id", addresses.map((a) => a.id)).delete();
      await customers.deleteCustomers(customerId);
    }
  });
  const commerceRemoved = await cleanup("commerce", () => cleanupFixtureCommerce(container, merchantIds));
  const marketplaceRemoved = commerceRemoved && await cleanup("marketplace", () => db.transaction(async (trx) => {
    if (zoneIds.length) {
      await trx("merchant_store_service_zone").whereIn("service_zone_id", zoneIds).delete();
      await trx("service_zone_event").whereIn("service_zone_id", zoneIds).delete();
      await trx("marketplace_service_zone").whereIn("id", zoneIds).delete();
    }
    if (merchantIds.length) {
      await trx("merchant_member").whereIn("merchant_id", merchantIds).delete();
      await trx("merchant_store").whereIn("merchant_id", merchantIds).delete();
      await trx("merchant").whereIn("id", merchantIds).delete();
    }
    if (appIds.length) {
      await trx("merchant_application_review").whereIn("application_id", appIds).delete();
      await trx("merchant_application").whereIn("id", appIds).delete();
    }
  }));
  if (addressesRemoved && marketplaceRemoved) {
    for (const id of userIds) await cleanup("platform user", () => users.deleteUsers([id]));
    for (const id of identities) await cleanup("identity", () => auth.deleteAuthIdentities([id]));
  }
  await cleanup("publishable key", async () => {
    await keys.revoke(key.id, { revoked_by: prefix, revoke_in: 0 });
    await keys.deleteApiKeys(key.id);
  });
  if (failures.length) throw new AggregateError(failures, "M6 verification failed.");
  console.log("M6 integration passed: topology, uniqueness, eligibility, real sessions and address ownership.");
}
