import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICartModuleService, ICustomerModuleService, IProductModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { createCartWorkflow, deleteProductsWorkflow } from "@medusajs/medusa/core-flows";
import type MarketplaceService from "../modules/marketplace/service";
import { bindCart, supersedeCart } from "../modules/marketplace/cart-context-repository";
import { CartFoundationService, cartRegion } from "../lib/cart-service";
import { cartOperation } from "../lib/cart-lock";
import { ensureCommerce } from "../lib/commerce";
import { LocationService } from "../lib/location-service";
import { createCatalogueProductWorkflow } from "../workflows/create-catalogue-product";
import { createMarketplaceCartWorkflow } from "../workflows/create-marketplace-cart";
import { PUBLIC_PREFIX } from "../modules/routed-file/storage";
import { nativeProducts } from "../lib/catalogue-native";
import { cleanupFixtureCommerce } from "./fixture-commerce-cleanup";
import type { CartFoundation } from "@gospaza/contracts";
import type { DiscoveryInput } from "../lib/discovery-service";

function initializationDiagnostics(attempts: PromiseSettledResult<string>[]): string {
  function describeError(error: unknown, depth = 0): object {
    if (!(error instanceof Error)) {
      return { message: typeof error === "string" ? error : "Non-Error rejection" };
    }
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...("type" in error && typeof error.type === "string" ? { type: error.type } : {}),
      ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      ...(depth < 5 && error.cause !== undefined
        ? { cause: describeError(error.cause, depth + 1) } : {}),
      ...(depth < 5 && error instanceof AggregateError
        ? { errors: error.errors.map((cause: unknown) => describeError(cause, depth + 1)) } : {}),
    };
  }
  // M8-B initializes through internal services, not HTTP. Report both outcomes
  // without dumping containers, credentials, request headers or workflow inputs.
  return JSON.stringify(attempts.map((attempt, index) => ({
    attempt: index + 1,
    status: attempt.status,
    ...(attempt.status === "fulfilled"
      ? { cartId: attempt.value }
      : { error: describeError(attempt.reason) }),
  })), null, 2);
}

export interface CartVerificationFixture {
  container: ExecArgs["container"];
  createCustomer(suffix: string): Promise<{ id: string; cookie: string }>;
  request(path: string, cookie?: string, method?: string, body?: unknown): Promise<Response>;
  first: { merchantId: string; store: { id: string }; channelId: string; variantId: string };
  second: { merchantId: string; store: { id: string }; channelId: string; variantId: string };
  location: DiscoveryInput;
  regionId: string;
}

export default async function verifyCartFoundation(
  { container }: ExecArgs,
  verifyMutations?: (fixture: CartVerificationFixture) => Promise<void>,
) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M8-B verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  // Do not seed, select an arbitrary region, or alter the native Store default.
  const region = await cartRegion(container);
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const productService = container.resolve<IProductModuleService>(Modules.PRODUCT);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const market = container.resolve<MarketplaceService>("marketplace");
  const location = new LocationService(container);
  const prefix = "m8b-" + randomUUID();
  const customerIds: string[] = [], identities: string[] = [], applications: string[] = [];
  const merchants: string[] = [], zones: string[] = [], products: string[] = [], cookies: string[] = [];
  const mediaIds: string[] = [];
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
  async function expectStatus(response: Promise<Response>, code: number) {
    const result = await response;
    assert.equal(result.status, code, "M8-B HTTP status");
    return result;
  }
  async function customer(suffix: string) {
    const email = prefix + suffix + "@example.test", password = randomBytes(24).toString("hex");
    const registration = await auth.register("emailpass", { body: { email, password } });
    assert.ok(registration.authIdentity);
    identities.push(registration.authIdentity.id);
    const person = await customers.createCustomers({ email, has_account: true });
    customerIds.push(person.id);
    await auth.updateAuthIdentities({ id: registration.authIdentity.id, app_metadata: { customer_id: person.id } });
    const login = await expectStatus(call("/auth/customer/emailpass", "", "POST", { email, password }), 200);
    const { token } = await login.json() as { token: string };
    const exchange = await expectStatus(call("/auth/session", "", "POST", undefined, token), 200);
    const cookie = exchange.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie); cookies.push(cookie);
    return { id: person.id, cookie };
  }
  try {
    const a = await customer("a"), b = await customer("b");
    const service = new CartFoundationService(container, a.id);
    assert.equal((await service.restore()).state, "empty");
    assert.equal((await carts.listCarts({ customer_id: a.id }, { take: null })).length, 0, "GET must not create a native cart");
    await expectStatus(call("/store/gospaza/cart"), 401);
    await expectStatus(call("/store/gospaza/cart?merchant_id=injected", a.cookie), 400);
    const point = { latitude: -70 + Math.random(), longitude: 10 };
    const zone = await location.save({ name: prefix, active: true, currency_code: "zar", delivery_fee_minor: 0,
      geometry: { type: "Polygon", coordinates: [[
        [9.99, point.latitude - 0.01], [10.01, point.latitude - 0.01],
        [10.01, point.latitude + 0.01], [9.99, point.latitude + 0.01], [9.99, point.latitude - 0.01],
      ]] } });
    zones.push(zone.zone.id);
    async function merchant(suffix: string) {
      const identity = prefix + suffix;
      const application = await market.createDraft(identity);
      assert.ok(application); applications.push(application.id);
      await market.edit(application.id, identity, {
        legal_name: prefix, trading_name: prefix + suffix, contact_name: "Fixture",
        contact_email: prefix + "@example.test", contact_phone: "0123456789",
        address_line_1: "1 Fixture Street", address_line_2: "", city: "Fixture",
        province: "Fixture", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "",
      });
      await market.submit(application.id, identity);
      await market.review(application.id, prefix, "start-review");
      const tenant = await market.provision(application.id, prefix, "M8-B fixture");
      merchants.push(tenant.merchant.id);
      const topology = await ensureCommerce(container, tenant.merchant.id);
      await location.assign(zone.zone.id, topology.store.id, true);
      const { result: productId } = await createCatalogueProductWorkflow(container).run({ input: {
        merchantId: tenant.merchant.id, channelId: topology.channelId, locationId: topology.locationId,
        product: { title: prefix + suffix, description: "", status: "published", requires_age_verification: false,
          variants: [{ title: "Default", sku: prefix + suffix, price_minor: 1099, stocked_quantity: 20 }] },
      } });
      products.push(productId);
      const [product] = await nativeProducts(container, [productId]);
      assert.ok(product?.variants[0]);
      return { merchantId: tenant.merchant.id, ...topology, variantId: product.variants[0].id };
    }
    const first = await merchant("first"), second = await merchant("second");
    const filters = { ...point, q: "", offset: 0, limit: 20 };
    const attempts = await Promise.allSettled([
      service.ensureFirstCart(first.variantId, 1, filters),
      service.ensureFirstCart(first.variantId, 1, filters),
    ]);
    assert.ok(
      attempts.every((attempt) => attempt.status === "fulfilled"),
      "both same-store initializations must succeed; service outcomes:\n" + initializationDiagnostics(attempts),
    );
    const ids = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
    assert.equal(ids[0], ids[1], "concurrent get-or-create must publish one cart");
    const cartId = ids[0]!;
    const initialized = await carts.listCarts({ customer_id: a.id }, { take: null });
    assert.equal(initialized.length, 1);
    const bindings = await db("cart_marketplace_context")
      .whereIn("medusa_cart_id", initialized.map((cart) => cart.id))
      .whereNull("superseded_at").whereNull("deleted_at");
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].merchant_id, first.merchantId);
    assert.equal(bindings[0].merchant_store_id, first.store.id);
    const native = await carts.retrieveCart(cartId, { relations: ["items"] });
    assert.equal(native.customer_id, a.id);
    assert.equal(native.sales_channel_id, first.channelId);
    assert.equal(native.region_id, region.id);
    assert.equal(native.currency_code, "zar");
    assert.ok(native.items);
    assert.equal(native.items.length, 1);
    assert.equal(Number(native.items[0]!.quantity), 1, "M8-B get-or-create is not an add operation");
    const restored = await service.restore(cartId);
    assert.equal(restored.state, "current");
    assert.equal(restored.eligibility, "pending", "reload without location must preserve cart");
    assert.equal((await service.restore()).cart?.id, cartId);
    await assert.rejects(() => new CartFoundationService(container, b.id).restore(cartId));
    await expectStatus(call("/store/gospaza/cart?cart_id=" + cartId, b.cookie), 404);
    const http = await (await expectStatus(call("/store/gospaza/cart", a.cookie), 200)).json() as CartFoundation;
    assert.equal(http.cart?.id, cartId);
    assert.equal(http.cart?.currency_code, "zar");
    assert.equal(http.cart?.items.length, 1);
    assert.equal(http.cart?.items[0]?.variant_id, first.variantId);
    assert.equal(http.cart?.items[0]?.unit_price_minor, 1099);
    assert.equal(http.cart?.items[0]?.quantity, 1);
    assert.equal(http.cart?.items[0]?.subtotal_minor, 1099);
    assert.equal(http.cart?.subtotal_minor, 1099);
    assert.equal(http.cart?.item_count, 1);
    for (const amount of [http.cart?.subtotal_minor, http.cart?.items[0]?.unit_price_minor,
      http.cart?.items[0]?.subtotal_minor]) {
      assert.ok(Number.isSafeInteger(amount), "customer money must be integer minor units");
    }

    // Exercise the actual cart mapper with hostile native image relationships.
    // These are metadata-only fixtures; no private objects are uploaded/exposed.
    const productId = native.items[0]!.product_id;
    assert.ok(productId);
    const profiles = await market.listProductMarketplaceProfiles({ merchant_id: first.merchantId });
    const profile = profiles.find((row) => row.medusa_product_id === productId);
    const [foreignProfile] = await market.listProductMarketplaceProfiles({ merchant_id: second.merchantId });
    assert.ok(profile && foreignProfile);
    const imageUrl = (name: string) => "https://media.example.test/" + prefix + "/" + name + ".png";
    const tracked = [
      { name: "public", profileId: profile.id, key: PUBLIC_PREFIX + prefix + "/public.png", pending: false },
      { name: "private", profileId: profile.id, key: "merchant-applications/" + prefix + ".png", pending: false },
      { name: "pending", profileId: profile.id, key: PUBLIC_PREFIX + prefix + "/pending.png", pending: true },
      { name: "foreign", profileId: foreignProfile.id, key: PUBLIC_PREFIX + prefix + "/foreign.png", pending: false },
    ];
    for (const image of tracked) {
      const id = "cmedia_" + randomUUID();
      mediaIds.push(id);
      await db("catalogue_media").insert({ id, profile_id: image.profileId,
        file_key: image.key, public_url: imageUrl(image.name), removal_pending: image.pending });
    }
    try {
      for (const names of [["private", "pending", "foreign", "untracked"], ["public"]]) {
        await productService.updateProducts(productId, {
          thumbnail: imageUrl("private"), images: names.map((name) => ({ url: imageUrl(name) })),
        });
        const mediaCart = await (await expectStatus(call("/store/gospaza/cart", a.cookie), 200)).json() as CartFoundation;
        assert.equal(mediaCart.cart?.items[0]?.image_url, names.includes("public") ? imageUrl("public") : null);
        for (const hidden of ["private", "pending", "foreign", "untracked"]) {
          assert.equal(JSON.stringify(mediaCart).includes(imageUrl(hidden)), false);
        }
      }
    } finally {
      await productService.updateProducts(productId, { thumbnail: null, images: [] });
    }
    const publicCart = JSON.stringify(http);
    for (const privateField of ["sales_channel", "merchant_id", "stock_location",
      "inventory_item", "reserved_quantity", "metadata"]) {
      assert.equal(publicCart.includes(privateField), false);
    }
    await assert.rejects(() => service.ensureFirstCart(second.variantId, 1, filters), /CART_MERCHANT_CONFLICT/);
    await assert.rejects(() => bindCart(db, { cartId, merchantId: first.merchantId, storeId: first.store.id }));
    await assert.rejects(() => bindCart(db, { cartId: "cart_" + randomUUID(), merchantId: first.merchantId, storeId: second.store.id }));
    await assert.rejects(() => db("cart_marketplace_context").where({ medusa_cart_id: cartId }).update({ merchant_id: second.merchantId, merchant_store_id: second.store.id }));
    await db("merchant_store").where({ id: first.store.id }).update({ active: false });
    assert.equal((await service.restore()).state, "stale");
    assert.equal((await service.restore()).cart?.id, cartId);
    await db("merchant_store").where({ id: first.store.id }).update({ active: true });

    // Separate customer, simultaneous first creations from different merchants.
    const race = await Promise.allSettled([
      new CartFoundationService(container, b.id).ensureFirstCart(first.variantId, 1, filters),
      new CartFoundationService(container, b.id).ensureFirstCart(second.variantId, 1, filters),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await carts.listCarts({ customer_id: b.id }, { take: null })).length, 1);

    // Native HTTP access is closed even for the legitimate owner.
    for (const [path, method] of [
      ["/store/carts", "POST"], ["/store/carts/" + cartId, "GET"], ["/store/carts/" + cartId, "POST"],
      ["/store/carts/" + cartId + "/line-items", "POST"],
      ["/store/carts/" + cartId + "/line-items/" + native.items[0]!.id, "DELETE"],
      ["/store/carts/" + cartId + "/line-items/" + native.items[0]!.id, "POST"],
      ["/store/carts/" + cartId + "/line-items/batch", "POST"],
      ["/store/carts/" + cartId + "/customer", "POST"], ["/store/carts/" + cartId + "/complete", "POST"],
    ]) {
      const blocked = await expectStatus(call(path!, a.cookie, method!, method === "POST" ? {
        variant_id: first.variantId, quantity: 2, customer_id: b.id, sales_channel_id: second.channelId,
      } : undefined), 404);
      assert.deepEqual(await blocked.json(), { message: "Use the GoSpaza cart API." });
      assert.equal(blocked.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(Number((await carts.retrieveCart(cartId, { relations: ["items"] })).items?.[0]?.quantity), 1);

    // A candidate with a failed binding must compensate native creation.
    const before = await carts.listCarts({ customer_id: b.id }, { take: null });
    await assert.rejects(() => cartOperation(container, b.id, () =>
      createMarketplaceCartWorkflow(container).run({ input: {
        customerId: b.id, merchantId: first.merchantId, storeId: second.store.id,
        channelId: first.channelId, regionId: region.id, variantId: first.variantId, quantity: 1,
      } })));
    assert.equal((await carts.listCarts({ customer_id: b.id }, { take: null })).length, before.length);

    // A crash-orphan native cart is not adopted; explicit hints are stale.
    const c = await customer("orphan");
    const { result: orphan } = await createCartWorkflow(container).run({ input: {
      customer_id: c.id, sales_channel_id: first.channelId, region_id: region.id,
    } });
    assert.equal((await new CartFoundationService(container, c.id).restore()).state, "empty");
    assert.equal((await new CartFoundationService(container, c.id).restore(orphan.id)).state, "stale");
    for (const path of ["/store/gospaza/cart/items", "/store/gospaza/cart/switch-store"]) {
      await expectStatus(call(path, c.cookie, "POST", {
        cart_id: orphan.id, variant_id: first.variantId, quantity: 1, location: filters,
        ...(path.endsWith("switch-store") ? { confirm: true } : {}),
      }), 404);
    }
    assert.equal((await carts.retrieveCart(orphan.id, { relations: ["items"] })).items?.length, 0);

    if (verifyMutations) {
      await verifyMutations({ container, createCustomer: customer, request: call, first, second, location: filters, regionId: region.id });
    }

    await cartOperation(container, a.id, () => db.transaction((trx) => supersedeCart(trx, cartId)));
    assert.equal((await service.restore(cartId)).state, "superseded");
    assert.equal((await service.restore()).state, "empty");
    await assert.rejects(() => db("cart_marketplace_context").where({ medusa_cart_id: cartId }).update({ superseded_at: null }));
    assert.equal((await carts.retrieveCart(cartId, { relations: ["items"] })).items?.length, 1, "supersession does not destroy lines");
  } catch (error) { failures.push(error); }

  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await work(); return true; }
    catch (error) { failures.push(new Error("M8-B cleanup failed: " + name + "; prefix " + prefix, { cause: error })); return false; }
  };
  for (const cookie of cookies) await cleanup("session", () => expectStatus(call("/auth/session", cookie, "DELETE"), 200));
  const cartsRemoved = await cleanup("carts", async () => {
    const owned = customerIds.length ? await carts.listCarts({ customer_id: customerIds }, { take: null }) : [];
    if (owned.length) {
      await db("cart_marketplace_context").whereIn("medusa_cart_id", owned.map((cart) => cart.id)).delete();
      await carts.deleteCarts(owned.map((cart) => cart.id));
    }
  });
  const productsRemoved = cartsRemoved && await cleanup("products", async () => {
    if (mediaIds.length) await db("catalogue_media").whereIn("id", mediaIds).delete();
    if (products.length) await deleteProductsWorkflow(container).run({ input: { ids: products } });
    if (merchants.length) await db("product_marketplace_profile").whereIn("merchant_id", merchants).delete();
  });
  const commerceRemoved = productsRemoved && await cleanup("commerce", () => cleanupFixtureCommerce(container, merchants));
  if (commerceRemoved) await cleanup("marketplace", () => db.transaction(async (trx) => {
    if (zones.length) {
      await trx("merchant_store_service_zone").whereIn("service_zone_id", zones).delete();
      await trx("service_zone_event").whereIn("service_zone_id", zones).delete();
      await trx("marketplace_service_zone").whereIn("id", zones).delete();
    }
    if (merchants.length) {
      await trx("merchant_member").whereIn("merchant_id", merchants).delete();
      await trx("merchant_store").whereIn("merchant_id", merchants).delete();
      await trx("merchant").whereIn("id", merchants).delete();
    }
    if (applications.length) {
      await trx("merchant_application_review").whereIn("application_id", applications).delete();
      await trx("merchant_application").whereIn("id", applications).delete();
    }
  }));
  if (cartsRemoved) {
    for (const id of customerIds) await cleanup("customer", () => customers.deleteCustomers(id));
    for (const id of identities) await cleanup("identity", () => auth.deleteAuthIdentities([id]));
  }
  await cleanup("publishable key", async () => {
    await keys.revoke(key.id, { revoked_by: prefix, revoke_in: 0 });
    await keys.deleteApiKeys(key.id);
  });
  if (failures.length) throw new AggregateError(failures, "M8-B verification failed.");
  console.log("M8-B passed: binding constraints, concurrent lazy creation, restoration, ownership, native bypass and compensation.");
}
