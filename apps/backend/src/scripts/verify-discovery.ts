import { deleteProductsWorkflow, updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { CatalogueService } from "../lib/catalogue-service";
import type { storefrontProduct } from "../lib/storefront-product";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICustomerModuleService, IUserModuleService, ISalesChannelModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type MarketplaceService from "../modules/marketplace/service";
import { LocationService } from "../lib/location-service";
import { ensureCommerce } from "../lib/commerce";
import { cleanupFixtureCommerce } from "./fixture-commerce-cleanup";
import type { Geometry } from "../modules/marketplace/location-policy";

type PublicProduct = NonNullable<ReturnType<typeof storefrontProduct>>;

export default async function verifyDiscovery({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M7 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const channels = container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL);
  const market = container.resolve<MarketplaceService>("marketplace");
  const service = new LocationService(container);
  const prefix = "m7-" + randomUUID(), password = randomBytes(24).toString("hex");
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
    assert.equal(result.status, expected, "M7 HTTP status");
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

  try {
    await session("user", "admin");
    const a = await session("customer", "a"), b = await session("customer", "b");
    // Select an unserved synthetic point without changing any unrelated local data.
    let latitude = -70, longitude = 10;
    let found = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      latitude = -80 + Math.random() * 15;
      longitude = -150 + Math.random() * 30;
      if (!(await service.serviceability(latitude, longitude)).serviceable) { found = true; break; }
    }
    assert.ok(found, "No empty fixture location found; use an isolated local database.");
    const point = { latitude, longitude };
    const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) }).toString();
    const get = (path: string, cookie = a.cookie, extra = "") => call("/store/gospaza/" + path + "?" + query + extra, cookie);
    const discovery = async () => await (await status(call("/store/gospaza/discovery", a.cookie, "POST", point), 200)).json() as {
      mode: string; eligible_store_count: number; stores: { id: string; name: string }[];
    };
    assert.equal((await discovery()).mode, "none");
    await status(call("/store/gospaza/discovery", "", "POST", point), 401);
    const half = 0.005;
    const geometry: Geometry = { type: "Polygon", coordinates: [[
      [longitude - half, latitude - half], [longitude + half, latitude - half],
      [longitude + half, latitude + half], [longitude - half, latitude + half],
      [longitude - half, latitude - half],
    ]] };
    const zoneData = { name: prefix, active: true, geometry, delivery_fee_minor: 2500, currency_code: "zar" as const };
    for (let index = 0; index < 2; index++) {
      const zone = await service.save({ ...zoneData, name: prefix + "-" + index });
      zoneIds.push(zone.zone.id);
    }
    async function merchant(suffix: string) {
      const owner = await session("merchant", suffix);
      const app = await market.createDraft(owner.identity);
      assert.ok(app); appIds.push(app.id);
      await market.edit(app.id, owner.identity, {
        legal_name: prefix, trading_name: prefix + "-" + suffix, contact_name: "Fixture", contact_email: owner.email,
        contact_phone: "0123456789", address_line_1: "1 Fixture Street", address_line_2: "",
        city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "ZA",
        intends_to_sell_alcohol: false, notes: "M7 synthetic",
      });
      await market.submit(app.id, owner.identity);
      await market.review(app.id, userIds[0]!, "start-review");
      const tenant = await market.provision(app.id, userIds[0]!, "M7 fixture");
      merchantIds.push(tenant.merchant.id);
      const topology = await ensureCommerce(container, tenant.merchant.id);
      return { owner, topology, catalogue: new CatalogueService(container, owner.identity), merchantId: tenant.merchant.id };
    }
    const first = await merchant("first");
    await service.assign(zoneIds[0]!, first.topology.store.id, true);
    assert.equal((await discovery()).mode, "single");
    await service.assign(zoneIds[1]!, first.topology.store.id, true);
    assert.equal((await discovery()).eligible_store_count, 1, "overlap deduplicates");
    const second = await merchant("second");
    await service.assign(zoneIds[0]!, second.topology.store.id, true);
    assert.equal((await discovery()).mode, "multiple");
    assert.equal((await discovery()).eligible_store_count, 2);
    const productInput = {
      title: prefix + "-tomatoes", description: "Synthetic ripe produce", status: "published" as const,
      requires_age_verification: true,
      variants: [
        { title: "500g", sku: prefix + "-500", price_minor: 1099, stocked_quantity: 5 },
        { title: "1kg", sku: prefix + "-1000", price_minor: 2099, stocked_quantity: 0 },
      ],
    };
    const product = await first.catalogue.create(productInput);
    const draft = await first.catalogue.create({ ...productInput, title: prefix + "-draft", status: "draft",
      variants: [{ title: "Default", sku: prefix + "-draft", price_minor: 1500, stocked_quantity: 3 }] });
    const foreign = await second.catalogue.create({ ...productInput, title: prefix + "-foreign",
      variants: [{ title: "Default", sku: prefix + "-foreign", price_minor: 999, stocked_quantity: 2 }] });
    async function detail(id: string) {
      return (await (await status(get("products/" + id), 200)).json() as { product: PublicProduct }).product;
    }
    const outside = new URLSearchParams({ latitude: String(latitude + 0.05), longitude: String(longitude) });
    await status(call("/store/gospaza/stores/" + first.topology.store.id + "?" + outside, a.cookie), 404);
    await status(call("/store/gospaza/products/" + product.id + "?" + outside, a.cookie), 404);
    const dto = await detail(product.id);
    assert.equal(dto.store.id, first.topology.store.id);
    assert.equal(dto.min_price_minor, 1099);
    assert.equal(dto.max_price_minor, 2099);
    assert.equal(dto.variants.find((v) => v.title === "1kg")?.availability, "out_of_stock");
    assert.equal(dto.requires_age_verification, true);
    await status(get("products/" + draft.id), 404);
    const list = await (await status(get("stores/" + first.topology.store.id + "/products"), 200)).json() as { products: PublicProduct[] };
    assert.deepEqual(list.products.map((p) => p.id), [product.id]);
    // Native images are not public unless tracked by the M5 public media boundary.
    await updateProductsWorkflow(container).run({ input: { products: [{
      id: product.id, images: [{ url: "https://private.invalid/" + prefix }],
    }] } });
    assert.deepEqual((await detail(product.id)).images, []);
    const text = JSON.stringify(dto);
    for (const secret of ["merchant_id", "medusa_", "stocked_quantity", "reserved_quantity", "inventory_item_id", "auth_identity_id", "address_line_1"]) {
      assert.equal(text.includes(secret), false, secret);
    }
    // Native mutation is immediately reflected, without a storefront price/stock cache.
    await first.catalogue.update(product.id, { ...productInput, variants: product.variants.map((variant) => ({
      id: variant.id, title: variant.title, sku: variant.sku, price_minor: 1234, stocked_quantity: 0,
    })) });
    assert.equal((await detail(product.id)).min_price_minor, 1234);
    assert.ok((await detail(product.id)).variants.every((v) => v.availability === "out_of_stock"));
    const secondId = second.topology.store.id;
    await service.assign(zoneIds[0]!, secondId, false);
    await status(get("stores/" + secondId), 404);
    await status(get("products/" + foreign.id), 404);
    const search = await (await status(get("search", a.cookie, "&q=" + encodeURIComponent(prefix)), 200)).json() as {
      products: PublicProduct[]; stores: { id: string }[];
    };
    assert.deepEqual(search.products.map((p) => p.id), [product.id]);
    assert.deepEqual(search.stores.map((s) => s.id), [first.topology.store.id]);
    const byDescription = await (await status(get("search", a.cookie, "&q=ripe"), 200)).json() as { products: PublicProduct[] };
    assert.deepEqual(byDescription.products.map((p) => p.id), [product.id]);
    const byStore = await (await status(get("search", a.cookie, "&q=" + encodeURIComponent(prefix + "-first")), 200)).json() as { products: PublicProduct[] };
    assert.deepEqual(byStore.products.map((p) => p.id), [product.id]);
    const paged = await (await status(get("search", a.cookie, "&limit=1&offset=1"), 200)).json() as { products: PublicProduct[]; count: number };
    assert.equal(paged.count, 1); assert.equal(paged.products.length, 0);
    await db("merchant_store").where({ id: first.topology.store.id }).update({ active: false });
    assert.equal((await discovery()).mode, "none");
    await db("merchant_store").where({ id: first.topology.store.id }).update({ active: true });
    await db("merchant").where({ id: first.merchantId }).update({ status: "SUSPENDED" });
    assert.equal((await discovery()).mode, "none");
    await status(get("products/" + product.id), 404);
    await db("merchant").where({ id: first.merchantId }).update({ status: "ACTIVE" });
    for (const zoneId of zoneIds) await service.save({ ...zoneData, active: false }, zoneId);
    assert.equal((await discovery()).mode, "none");
    for (const zoneId of zoneIds) await service.save(zoneData, zoneId);
    // Missing commerce and disabled native channel cannot be a usable storefront.
    await channels.updateSalesChannels(first.topology.channelId, { is_disabled: true });
    assert.equal((await discovery()).mode, "none");
    await channels.updateSalesChannels(first.topology.channelId, { is_disabled: false });
    await db("merchant").where({ id: first.merchantId }).update({ medusa_sales_channel_id: null });
    try { assert.equal((await discovery()).mode, "none"); }
    finally { await db("merchant").where({ id: first.merchantId }).update({ medusa_sales_channel_id: first.topology.channelId }); }
    const link = container.resolve<{ dismiss(data: Record<string, Record<string, string>>): Promise<unknown>; create(data: Record<string, Record<string, string>>): Promise<unknown> }>(ContainerRegistrationKeys.LINK);
    const nativeLink = { [Modules.PRODUCT]: { product_id: product.id }, [Modules.SALES_CHANNEL]: { sales_channel_id: first.topology.channelId } };
    await link.dismiss(nativeLink);
    try { await status(get("products/" + product.id), 404); } finally { await link.create(nativeLink); }
    const address = { first_name: "Test", last_name: "Customer", address_1: "1 Test Street", address_2: "", city: "Fixture",
      province: "Fixture", postal_code: "1234", country_code: "za", phone: "", location: { ...point, source: "browser_geolocation" } };
    await status(call("/store/gospaza/addresses", a.cookie, "POST", address), 201);
    const saved = await (await status(call("/store/gospaza/addresses", a.cookie), 200)).json() as { addresses: { id: string }[] };
    const addressId = saved.addresses[0]!.id;
    await status(call("/store/gospaza/discovery", a.cookie, "POST", { address_id: addressId }), 200);
    await status(call("/store/gospaza/discovery", b.cookie, "POST", { address_id: addressId }), 404);
    await status(call("/store/gospaza/discovery", first.owner.cookie, "POST", point), 401);
    for (const bad of [{ ...point, zone_id: zoneIds[0] }, { ...point, merchant_id: first.merchantId }, { latitude: 91, longitude: 0 }]) {
      await status(call("/store/gospaza/discovery", a.cookie, "POST", bad), 400);
    }
  } catch (error) { failures.push(error); }
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await work(); return true; } catch (error) { failures.push(new Error("M7 cleanup failed: " + name + "; fixture prefix " + prefix, { cause: error })); return false; }
  };
  for (const cookie of cookies) await cleanup("session", async () => { await status(call("/auth/session", cookie, "DELETE"), 200); });
  const addressesRemoved = await cleanup("addresses", async () => {
    for (const customerId of customerIds) {
      const addresses = await customers.listCustomerAddresses({ customer_id: customerId }, { take: null });
      if (addresses.length) await db("customer_address_location").whereIn("medusa_customer_address_id", addresses.map((a) => a.id)).delete();
      await customers.deleteCustomers(customerId);
    }
  });
  const productsRemoved = await cleanup("products", async () => {
    const profiles = await db<{ medusa_product_id: string }>("product_marketplace_profile").whereIn("merchant_id", merchantIds);
    if (profiles.length) await deleteProductsWorkflow(container).run({ input: { ids: profiles.map((p) => p.medusa_product_id) } });
    await db("product_marketplace_profile").whereIn("merchant_id", merchantIds).delete();
  });
  const commerceRemoved = productsRemoved && await cleanup("commerce", () => cleanupFixtureCommerce(container, merchantIds));
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
  if (failures.length) throw new AggregateError(failures, "M7 verification failed.");
  console.log("M7 integration passed: discovery modes, location isolation, native catalogue, media privacy and owned addresses.");
}
