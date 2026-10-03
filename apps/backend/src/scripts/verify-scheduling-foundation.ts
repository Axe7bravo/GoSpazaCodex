import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICustomerModuleService, IUserModuleService, IFulfillmentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { createProductsWorkflow, deleteProductsWorkflow, deleteShippingOptionsWorkflow, updateProductsWorkflow, updateServiceZonesWorkflow, updateShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";
import type MarketplaceService from "../modules/marketplace/service";
import { LocationService } from "../lib/location-service";
import { SchedulingService } from "../lib/scheduling-service";
import { ensureShippingProfile } from "../lib/scheduling-native";
import { ensureCommerce } from "../lib/commerce";
import { cleanupFixtureCommerce } from "./fixture-commerce-cleanup";
import type { Geometry } from "../modules/marketplace/location-policy";

export default async function verifySchedulingFoundation({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M9-B verification is local-only.");
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
  const prefix = "m9b-" + randomUUID(), password = randomBytes(24).toString("hex");
  const identities: string[] = [], customerIds: string[] = [], userIds: string[] = [];
  const appIds: string[] = [], merchantIds: string[] = [], zoneIds: string[] = [], cookies: string[] = [];
  const failures: unknown[] = [];
  const key = await keys.createApiKeys({ title: prefix, type: "publishable", created_by: prefix });
  async function call(
    path: string,
    cookie = "",
    method = "GET",
    body?: unknown,
    token?: string,
    provisioningCall?: "first" | "repeated",
  ) {
    const url = new URL(path, base);
    const headers = new Headers({
      "x-publishable-api-key": key.token,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    });
    const result = await fetch(url, {
      method,
      signal: AbortSignal.timeout(30000),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (provisioningCall) {
      // Only scheduling provisioning opts in; never log authentication headers.
      console.log("M9-B provisioning HTTP: " + JSON.stringify({
        provisioning_call: provisioningCall,
        request_url: url.href,
        request_method: method,
        request_idempotency_key: headers.get("Idempotency-Key"),
        response_status: result.status,
        response_idempotency_key: result.headers.get("Idempotency-Key"),
        response_body: await result.clone().text(),
      }));
    }
    return result;
  }
  async function status(response: Promise<Response>, expected: number) {
    const result = await response;
    if (result.status !== expected) assert.fail("M9-B HTTP " + result.status + " expected " + expected + ": " + await result.text());
    return result;
  }
  async function session(actor: "customer" | "user" | "merchant" | "driver", suffix: string) {
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

  const scheduling = new SchedulingService(container);
  const storeIds: string[] = [], productIds: string[] = [], extraProfileIds: string[] = [];
  const geometry: Geometry = { type: "Polygon", coordinates: [[[20,-20],[21,-20],[21,-19],[20,-19],[20,-20]]] };
  const zoneData = { name: prefix, active: true, geometry, delivery_fee_minor: 2599, currency_code: "zar" as const };
  const reason = "M9-B synthetic verification";
  const requestReason = { confirmed: true, reason };
  const point = { latitude: -19.5, longitude: 20.5 };
  const policy = { timezone: "Africa/Johannesburg", enabled: true, asap_enabled: true, scheduled_enabled: true,
    minimum_lead_minutes: 60, booking_horizon_days: 7, hold_minutes: 15 };
  try {
    const admin = await session("user", "admin"), customer = await session("customer", "customer");
    const merchant = await session("merchant", "merchant"), driver = await session("driver", "driver");
    const adminId = userIds[0];
    assert.ok(adminId);
    for (let i = 0; i < 2; i++) {
      const app = await market.createDraft(i === 0 ? merchant.identity : prefix + "-identity-" + i);
      assert.ok(app); appIds.push(app.id);
      await market.edit(app.id, app.applicant_identity_id, { legal_name: prefix + i, trading_name: prefix + i,
        contact_name: "Fixture", contact_email: merchant.email, contact_phone: "0123456789", address_line_1: "1 Fixture Street",
        address_line_2: "", city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "ZA",
        intends_to_sell_alcohol: false, notes: reason });
      await market.submit(app.id, app.applicant_identity_id);
      await market.review(app.id, adminId, "start-review");
      const tenant = await market.provision(app.id, adminId, reason);
      merchantIds.push(tenant.merchant.id); storeIds.push(tenant.store.id);
      await ensureCommerce(container, tenant.merchant.id);
    }
    const storeId = storeIds[0], otherStoreId = storeIds[1];
    assert.ok(storeId && otherStoreId);
    const basePath = "/admin/gospaza/scheduling/" + storeId;
    for (const cookie of ["", customer.cookie, merchant.cookie, driver.cookie]) {
      await status(call(basePath, cookie), 401);
      await status(call(basePath + "/policy", cookie, "PUT", { ...requestReason, policy }), 401);
      await status(call(basePath + "/synchronize", cookie, "POST", requestReason), 401);
    }
    for (const cookie of ["", customer.cookie, merchant.cookie, driver.cookie, admin.cookie]) {
      for (const [route, method] of [["/store/shipping-options?cart_id=cart_known_foreign", "GET"],
        ["/store/shipping-options/so_known_foreign/calculate", "POST"], ["/store/carts/cart_known_foreign/shipping-methods", "POST"]]) {
        assert.ok(route && method);
        await status(call(route, cookie, method, method === "POST" ? { cart_id: "cart_known_foreign", option_id: "so_known_foreign" } : undefined), 404);
      }
    }
    await status(call(basePath + "/policy", admin.cookie, "PUT", { ...requestReason, policy }), 200);
    await status(call(basePath + "/policy", admin.cookie, "PUT", { ...requestReason, policy: { ...policy, merchant_store_id: otherStoreId } }), 400);
    await status(call(basePath + "/policy", admin.cookie, "PUT", { reason, policy }), 400);
    const zone = await service.save(zoneData); zoneIds.push(zone.zone.id);
    const secondZone = await service.save({ ...zoneData, name: prefix + "-overlap", delivery_fee_minor: 3999 }); zoneIds.push(secondZone.zone.id);
    await service.assign(zone.zone.id, storeId, true);
    await service.assign(secondZone.zone.id, storeId, true);
    const assignment = await db<{ id: string; medusa_service_zone_id: string }>("merchant_store_service_zone")
      .where({ merchant_store_id: storeId, service_zone_id: zone.zone.id }).first();
    const otherAssignment = await db<{ id: string }>("merchant_store_service_zone")
      .where({ merchant_store_id: storeId, service_zone_id: secondZone.zone.id }).first();
    assert.ok(assignment && otherAssignment);
    // Reproduce real legacy M6 native shape, using a supported native workflow.
    await updateServiceZonesWorkflow(container).run({ input: { selector: { id: assignment.medusa_service_zone_id }, update: { geo_zones: [] } } });
    // Medusa 2.18 requires a nonempty option list even for this draft profile-backfill fixture.
    const { result: products } = await createProductsWorkflow(container).run({ input: { products: [{
      title: prefix, handle: prefix,
      options: [{ title: "Variant", values: ["Default"] }], variants: [],
    }] } });
    const product = products[0]; assert.ok(product); productIds.push(product.id);
    await updateProductsWorkflow(container).run({ input: { products: [{ id: product.id, shipping_profile_id: null }] } });
    await db("product_marketplace_profile").insert({ id: "pmprof_" + randomUUID(), merchant_id: merchantIds[0],
      medusa_product_id: product.id, requires_age_verification: false });
    const profileId = await ensureShippingProfile(container);
    assert.equal(await ensureShippingProfile(container), profileId, "default profile is reused");
    for (const id of [assignment.id, otherAssignment.id]) {
      await status(call(basePath + "/assignments/" + id, admin.cookie, "PUT", {
        ...requestReason, priority: id === assignment.id ? 10 : 0, asap_enabled: true, scheduled_enabled: true,
      }), 200);
    }
    const location = await db<{ medusa_stock_location_id: string }>("merchant_store").where({ id: storeId }).first();
    assert.ok(location?.medusa_stock_location_id);
    const locationQuery = container.resolve<{
      graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }):
        Promise<{ data: { id: string; fulfillment_providers: { id: string }[] }[] }>;
    }>(ContainerRegistrationKeys.QUERY);
    const linkedProviders = async () => {
      const { data } = await locationQuery.graph({ entity: "stock_location", fields: ["id", "fulfillment_providers.id"],
        filters: { id: location.medusa_stock_location_id } });
      assert.equal(data.length, 1);
      assert.ok(data[0]);
      return data[0].fulfillment_providers.filter((provider) => provider.id === "manual_manual");
    };
    assert.equal((await linkedProviders()).length, 0, "new fixture location starts without provider enablement");
    await status(call(basePath + "/synchronize", admin.cookie, "POST", requestReason, undefined, "first"), 200);
    assert.equal((await linkedProviders()).length, 1, "synchronization enables the installed provider for this location");
    const initialOptions = await db<{ id: string; medusa_shipping_option_id: string; revision: number; sync_state: string }>("delivery_option_configuration")
      .where({ merchant_store_id: storeId }).orderBy("id");
    assert.equal(initialOptions.length, 4);
    assert.ok(initialOptions.every((o) => o.medusa_shipping_option_id && o.sync_state === "READY"));
    // Medusa 2.18 exposes Shipping Option prices through the public prices alias.
    // Exercise the actual module link, not a mocked nested price_set response.
    const priceQuery = container.resolve<{
      graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }):
        Promise<{ data: { id: string; prices?: { currency_code: string; price_rules?: { id: string }[] }[] }[] }>;
    }>(ContainerRegistrationKeys.QUERY);
    const nativePrices = await priceQuery.graph({
      entity: "shipping_option",
      fields: ["id", "prices.currency_code", "prices.price_rules.id"],
      filters: { id: initialOptions.map((o) => o.medusa_shipping_option_id) },
    });
    assert.equal(nativePrices.data.length, initialOptions.length);
    for (const nativeOption of nativePrices.data) {
      assert.equal(nativeOption.prices?.length, 1, "native option exposes one flat price through prices");
      assert.equal(nativeOption.prices?.[0]?.currency_code, "zar");
      assert.deepEqual(nativeOption.prices?.[0]?.price_rules, [], "flat tariff has no conditional price rules");
    }
    // Await a separate HTTP operation: prove domain convergence without replaying a key.
    await status(call(basePath + "/synchronize", admin.cookie, "POST", requestReason, undefined, "repeated"), 200);
    assert.deepEqual((await db("delivery_option_configuration").where({ merchant_store_id: storeId }).orderBy("id").select("medusa_shipping_option_id"))
      .map((o) => o.medusa_shipping_option_id), initialOptions.map((o) => o.medusa_shipping_option_id));
    assert.equal((await linkedProviders()).length, 1, "repeated synchronization reuses the location/provider link");
    const geo = await fulfillment.retrieveServiceZone(assignment.medusa_service_zone_id, { relations: ["geo_zones"] });
    assert.equal(geo.geo_zones?.length, 1);
    assert.equal(geo.geo_zones?.[0]?.type, "country");
    assert.equal(geo.geo_zones?.[0]?.country_code, "za");
    const addressedOptions = await fulfillment.listShippingOptionsForContext({
      fulfillment_set_id: geo.fulfillment_set_id, address: { country_code: "za" },
      context: { enabled_in_store: "true", is_return: "false" },
    });
    for (const item of initialOptions) assert.ok(addressedOptions.some((o) => o.id === item.medusa_shipping_option_id), "ZA address matches the provisioned native envelope");
    const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }):
      Promise<{ data: { id: string; shipping_profile: { id: string } }[] }> }>(ContainerRegistrationKeys.QUERY);
    assert.equal((await query.graph({ entity: "product", fields: ["id", "shipping_profile.id"], filters: { id: product.id } })).data[0]?.shipping_profile.id, profileId);
    assert.equal((await scheduling.resolveAssignment(storeId, point.latitude, point.longitude)).id, assignment.id);
    await scheduling.configureAssignment(storeId, otherAssignment.id, 10, true, true, adminId, reason);
    await assert.rejects(scheduling.resolveAssignment(storeId, point.latitude, point.longitude), /DELIVERY_ZONE_AMBIGUOUS/);
    await scheduling.configureAssignment(storeId, otherAssignment.id, 0, true, true, adminId, reason);
    await scheduling.synchronize(storeId, adminId, reason);
    // Existing M6 tariff writes invalidate READY, including paths outside M9 admin routes.
    await service.save({ ...zoneData, delivery_fee_minor: 2601 }, zone.zone.id, adminId);
    await assert.rejects(scheduling.resolveAssignment(storeId, point.latitude, point.longitude), /STALE/);
    await scheduling.synchronize(storeId, adminId, reason);
    assert.equal((await scheduling.resolveAssignment(storeId, point.latitude, point.longitude)).delivery_fee_minor, 2601);
    const option = await db<{ id: string; medusa_shipping_option_id: string; revision: number }>("delivery_option_configuration")
      .where({ store_service_zone_id: assignment.id, mode: "ASAP" }).first();
    assert.ok(option);
    // Native drift cannot be hidden by Marketplace READY state.
    await updateShippingOptionsWorkflow(container).run({ input: [{ id: option.medusa_shipping_option_id,
      prices: [{ currency_code: "zar", amount: 0.01 }] }] });
    await assert.rejects(scheduling.resolveAssignment(storeId, point.latitude, point.longitude), /STALE/);
    await scheduling.synchronize(storeId, adminId, reason);
    // Ambiguous/incompatible geo configuration is not silently overwritten.
    await updateServiceZonesWorkflow(container).run({ input: { selector: { id: assignment.medusa_service_zone_id },
      update: { geo_zones: [{ type: "country", country_code: "us" }] } } });
    await assert.rejects(scheduling.synchronize(storeId, adminId, reason), /Incompatible native geo/);
    await updateServiceZonesWorkflow(container).run({ input: { selector: { id: assignment.medusa_service_zone_id }, update: { geo_zones: [] } } });
    // Incompatible product profiles are detected, never overwritten.
    const extra = await fulfillment.createShippingProfiles({ name: prefix + "-special", type: "custom" });
    extraProfileIds.push(extra.id);
    await updateProductsWorkflow(container).run({ input: { products: [{ id: product.id, shipping_profile_id: extra.id }] } });
    await assert.rejects(scheduling.synchronize(storeId, adminId, reason), /incompatible Shipping Profile/);
    await updateProductsWorkflow(container).run({ input: { products: [{ id: product.id, shipping_profile_id: profileId }] } });
    await scheduling.synchronize(storeId, adminId, reason);
    // Observable failure after native write: prevent publication on this fixture only.
    await db.raw(`create function "${prefix}-fail"() returns trigger language plpgsql as $$ begin
      if new.id = '${option.id}' and new.sync_state = 'READY' then raise exception 'M9 fixture publication failure'; end if;
      return new; end; $$`);
    await db.raw(`create trigger "${prefix}-fail" before update on delivery_option_configuration for each row execute function "${prefix}-fail"()`);
    try {
      await assert.rejects(scheduling.synchronize(storeId, adminId, reason), /publication failure/);
      assert.equal((await db("delivery_option_configuration").where({ id: option.id }).first()).sync_state, "FAILED");
    } finally {
      await db.raw(`drop trigger "${prefix}-fail" on delivery_option_configuration`);
      await db.raw(`drop function "${prefix}-fail"()`);
    }
    await scheduling.synchronize(storeId, adminId, reason);
    assert.equal((await db("delivery_option_configuration").where({ id: option.id }).first()).medusa_shipping_option_id, option.medusa_shipping_option_id);
    const start = new Date(Date.now() + 86400000), end = new Date(start.getTime() + 3600000);
    const slotData = { start_at: start.toISOString(), end_at: end.toISOString(),
      booking_cutoff_at: new Date(start.getTime() - 3600000).toISOString(), capacity: 2, enabled: true };
    const response = await status(call(basePath + "/slots", admin.cookie, "POST", { ...requestReason, slot: slotData }), 200);
    const { slot } = await response.json() as { slot: { id: string } };
    await assert.rejects(db("delivery_slot").where({ id: slot.id }).update({ capacity: 0 }));
    await assert.rejects(db("delivery_slot").where({ id: slot.id }).update({ capacity: 1.5 }));
    await assert.rejects(db("delivery_slot").where({ id: slot.id }).update({ end_at: slotData.start_at }));
    await assert.rejects(db("delivery_slot").where({ id: slot.id }).update({ booking_cutoff_at: slotData.end_at }));
    await status(call(basePath + "/slots", admin.cookie, "POST", { ...requestReason, slot: slotData }), 409);
    await scheduling.savePolicy(otherStoreId, policy, adminId, reason);
    const otherSlot = await scheduling.saveSlot(otherStoreId, slotData, adminId, reason);
    await status(call(basePath + "/slots/" + otherSlot.id, admin.cookie, "PUT", { ...requestReason, slot: slotData }), 404);
    const otherOption = initialOptions.find((candidate) => candidate.id !== option.id);
    assert.ok(otherOption);
    await assert.rejects(db("delivery_option_configuration").where({ id: otherOption.id })
      .update({ medusa_shipping_option_id: option.medusa_shipping_option_id }));
    const contextId = "cmctx_" + randomUUID();
    // Custom schema test only: no reservation API or native cart mutation is exercised here.
    await db("cart_marketplace_context").insert({ id: contextId, medusa_cart_id: prefix + "-schema-cart",
      merchant_id: merchantIds[0], merchant_store_id: storeId });
    const hold = { id: "dhold_" + randomUUID(), cart_context_id: contextId, merchant_store_id: storeId,
      delivery_option_id: option.id, store_service_zone_id: assignment.id, delivery_slot_id: slot.id,
      expires_at: new Date(Date.now() + 900000), configuration_revision: option.revision,
      quoted_fee_minor: 2601, latitude: point.latitude, longitude: point.longitude };
    await db("delivery_reservation").insert(hold);
    await assert.rejects(db("delivery_reservation").insert({ ...hold, id: "dhold_" + randomUUID() }));
    await assert.rejects(db("delivery_reservation").where({ id: hold.id }).update({ delivery_slot_id: otherSlot.id }));
    await assert.rejects(db("delivery_reservation").where({ id: hold.id }).update({ store_service_zone_id: otherAssignment.id }));
    await assert.rejects(db("delivery_reservation").where({ id: hold.id }).update({ quoted_fee_minor: -1 }));
    await assert.rejects(db("delivery_reservation").where({ id: hold.id }).update({ currency_code: "usd" }));
    await assert.rejects(db("delivery_reservation").where({ id: hold.id }).update({ status: "COMMITTED" }));
    await assert.rejects(db("delivery_option_configuration").insert({ id: "doption_" + randomUUID(), merchant_store_id: otherStoreId,
      store_service_zone_id: assignment.id, mode: "ASAP" }));
    const audit = await db("scheduling_event").where({ target_id: storeId, action: "POLICY_CONFIGURED" }).first();
    assert.equal(audit.platform_user_id, adminId);
    await assert.rejects(db("scheduling_event").where({ id: audit.id }).update({ reason: "changed" }));
  } catch (error) { failures.push(error); }
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await work(); return true; } catch (cause) { failures.push(new Error("M9-B cleanup failed: " + name + "; " + prefix, { cause })); return false; }
  };
  // Remove any interrupted fixture-only fault injector before normal cleanup.
  await cleanup("fault trigger", () => db.raw(`drop trigger if exists "${prefix}-fail" on delivery_option_configuration`));
  await cleanup("fault function", () => db.raw(`drop function if exists "${prefix}-fail"()`));
  for (const cookie of cookies) await cleanup("session", async () => { await status(call("/auth/session", cookie, "DELETE"), 200); });
  const nativeRemoved = await cleanup("native options/products", async () => {
    const options = storeIds.length ? await db<{ id: string; medusa_shipping_option_id: string | null }>("delivery_option_configuration").whereIn("merchant_store_id", storeIds) : [];
    for (const option of options) {
      // Recover options created just before a publication failure; never search unrelated data.
      const matches = await fulfillment.listShippingOptions({ name: "gospaza:" + option.id }, { take: null });
      if (matches.length) await deleteShippingOptionsWorkflow(container).run({ input: { ids: matches.map((o) => o.id) } });
    }
    if (productIds.length) await deleteProductsWorkflow(container).run({ input: { ids: productIds } });
    for (const id of extraProfileIds) await fulfillment.deleteShippingProfiles(id);
  });
  const schedulingRemoved = nativeRemoved && await cleanup("scheduling", () => db.transaction(async (trx) => {
    if (storeIds.length) {
      await trx("delivery_reservation").whereIn("merchant_store_id", storeIds).delete();
      await trx("cart_marketplace_context").whereIn("merchant_store_id", storeIds).delete();
      await trx("delivery_slot").whereIn("merchant_store_id", storeIds).delete();
      await trx("delivery_option_configuration").whereIn("merchant_store_id", storeIds).delete();
      await trx("store_delivery_policy").whereIn("merchant_store_id", storeIds).delete();
    }
    if (userIds.length) await trx("scheduling_event").whereIn("platform_user_id", userIds).delete();
    if (productIds.length) await trx("product_marketplace_profile").whereIn("medusa_product_id", productIds).delete();
  }));
  const commerceRemoved = schedulingRemoved && await cleanup("commerce", () => cleanupFixtureCommerce(container, merchantIds));
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
  if (marketplaceRemoved) {
    for (const id of customerIds) await cleanup("customer", () => customers.deleteCustomers(id));
    for (const id of userIds) await cleanup("user", () => users.deleteUsers([id]));
    for (const id of identities) await cleanup("identity", () => auth.deleteAuthIdentities([id]));
  }
  await cleanup("publishable key", async () => { await keys.revoke(key.id, { revoked_by: prefix, revoke_in: 0 }); await keys.deleteApiKeys(key.id); });
  if (failures.length) throw new AggregateError(failures, "M9-B foundation verification failed.");
  console.log("M9-B passed: native compatibility/reuse, priorities, price synchronization, schema constraints and HTTP boundaries.");
}
