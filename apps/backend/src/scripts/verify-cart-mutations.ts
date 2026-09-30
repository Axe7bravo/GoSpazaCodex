import assert from "node:assert/strict";
import type { ExecArgs, ICartModuleService, IProductModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import verifyCartFoundation from "./verify-cart-foundation";
import type { CartVerificationFixture } from "./verify-cart-foundation";
import { cartOperation } from "../lib/cart-lock";
import { switchMarketplaceCart } from "../workflows/switch-marketplace-cart";

const cartResponse = z.object({ cart_id: z.string() }).strict();

async function verifyMutations(fixture: CartVerificationFixture) {
  const { container, first, second, location, request } = fixture;
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const products = container.resolve<IProductModuleService>(Modules.PRODUCT);
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const itemsPath = "/store/gospaza/cart/items";
  const switchPath = "/store/gospaza/cart/switch-store";
  const body = (variantId = first.variantId, quantity = 1, cartId?: string) => ({
    variant_id: variantId, quantity, location, ...(cartId ? { cart_id: cartId } : {}),
  });
  async function response(path: string, cookie: string, method: string, input: unknown) {
    const result = await request(path, cookie, method, input);
    const value: unknown = await result.json();
    return { status: result.status, body: value };
  }
  async function concurrent(requests: Promise<Awaited<ReturnType<typeof response>>>[]) {
    const attempts = await Promise.allSettled(requests);
    // Await every request before fixture cleanup, even if a transport fails.
    assert.ok(attempts.every((attempt) => attempt.status === "fulfilled"), JSON.stringify(
      attempts.map((attempt) => attempt.status === "fulfilled" ? attempt.value : {
        error: attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason),
      }),
    ));
    return attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
  }
  function expectStatus(result: { status: number; body: unknown }, status: number) {
    assert.equal(result.status, status, JSON.stringify(result));
  }
  async function native(cartId: string) {
    return carts.retrieveCart(cartId, { relations: ["items"] });
  }
  async function line(cartId: string) {
    const result = await native(cartId);
    assert.equal(result.items?.length, 1);
    return result.items![0]!;
  }
  async function currentContexts(customerId: string) {
    const owned = await carts.listCarts({ customer_id: customerId }, { take: null });
    return db<{ medusa_cart_id: string; merchant_id: string; merchant_store_id: string }>("cart_marketplace_context")
      .whereIn("medusa_cart_id", owned.map((cart) => cart.id))
      .whereNull("superseded_at").whereNull("deleted_at");
  }

  async function assertCurrentBinding(customerId: string, cartId: string, target: typeof first) {
    const contexts = await currentContexts(customerId);
    assert.equal(contexts.length, 1, "exactly one current context must survive");
    assert.equal(contexts[0]?.medusa_cart_id, cartId);
    assert.equal(contexts[0]?.merchant_id, target.merchantId);
    assert.equal(contexts[0]?.merchant_store_id, target.store.id);
    const cart = await native(cartId);
    assert.equal(cart.customer_id, customerId);
    assert.equal(cart.sales_channel_id, target.channelId);
    assert.ok(cart.items?.length, "race winner must contain its requested product");
    for (const item of cart.items) {
      assert.equal(item.variant_id, target.variantId, "no line may belong to the losing merchant");
      assert.ok(item.product_id);
      const profile = await db<{ merchant_id: string }>("product_marketplace_profile")
        .where({ medusa_product_id: item.product_id }).whereNull("deleted_at").first();
      assert.equal(profile?.merchant_id, target.merchantId);
    }
  }

  // These are genuinely concurrent HTTP requests, not a serialized test helper.
  const same = await fixture.createCustomer("mutations-same");
  const initial = await concurrent([
    response(itemsPath, same.cookie, "POST", body()),
    response(itemsPath, same.cookie, "POST", body()),
  ]);
  assert.ok(initial.every((result) => result.status === 200), JSON.stringify(initial));
  const sameId = cartResponse.parse(initial[0]!.body).cart_id;
  assert.equal(cartResponse.parse(initial[1]!.body).cart_id, sameId);
  assert.equal(Number((await line(sameId)).quantity), 2);
  assert.equal((await currentContexts(same.id)).length, 1);
  assert.equal((await carts.listCarts({ customer_id: same.id }, { take: null })).length, 1);

  const additions = await concurrent([
    response(itemsPath, same.cookie, "POST", body(first.variantId, 2, sameId)),
    response(itemsPath, same.cookie, "POST", body(first.variantId, 3, sameId)),
  ]);
  assert.ok(additions.every((result) => result.status === 200), JSON.stringify(additions));
  let item = await line(sameId);
  assert.equal(Number(item.quantity), 7, "concurrent additions must not lose quantity");
  await assertCurrentBinding(same.id, sameId, first);
  const itemPath = itemsPath + "/" + item.id;
  const updates = await concurrent([
    response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 4, location }),
    response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 5, location }),
  ]);
  assert.ok(updates.every((result) => result.status === 200), JSON.stringify(updates));
  assert.ok([4, 5].includes(Number((await line(sameId)).quantity)), "absolute updates must have a serializable final quantity");

  const different = await fixture.createCustomer("mutations-different");
  const differentResults = await concurrent([
    response(itemsPath, different.cookie, "POST", body(first.variantId)),
    response(itemsPath, different.cookie, "POST", body(second.variantId)),
  ]);
  assert.equal(differentResults.filter((result) => result.status === 200).length, 1, JSON.stringify(differentResults));
  assert.equal(differentResults.filter((result) => result.status === 409).length, 1, JSON.stringify(differentResults));
  assert.deepEqual(
    z.object({ code: z.string() }).parse(differentResults.find((result) => result.status === 409)!.body),
    { code: "CART_MERCHANT_CONFLICT" },
  );
  assert.equal((await currentContexts(different.id)).length, 1);
  assert.equal((await carts.listCarts({ customer_id: different.id }, { take: null })).length, 1);
  const winningIndex = differentResults.findIndex((result) => result.status === 200);
  const winningId = cartResponse.parse(differentResults[winningIndex]!.body).cart_id;
  await assertCurrentBinding(different.id, winningId, winningIndex === 0 ? first : second);

  const outsider = await fixture.createCustomer("mutations-outsider");
  const foreignCreate = await response(itemsPath, outsider.cookie, "POST", body());
  expectStatus(foreignCreate, 200);
  const foreignId = cartResponse.parse(foreignCreate.body).cart_id;
  const foreignLine = await line(foreignId);
  for (const method of ["PATCH", "DELETE"]) {
    expectStatus(await response(itemsPath + "/" + foreignLine.id, same.cookie, method,
      { cart_id: sameId, ...(method === "PATCH" ? { quantity: 1 } : {}) }), 404);
    expectStatus(await response(itemPath, outsider.cookie, method,
      { cart_id: sameId, ...(method === "PATCH" ? { quantity: 1 } : {}) }), 404);
  }
  expectStatus(await response(itemsPath, outsider.cookie, "POST", body(first.variantId, 1, sameId)), 404);
  expectStatus(await response(itemsPath, "", "POST", body()), 401);
  // Use real foreign identities wherever available, across every write boundary.
  const attacks: Record<string, unknown> = {
    merchant_id: second.merchantId, merchant_store_id: second.store.id, store_id: second.store.id,
    customer_id: outsider.id, sales_channel_id: second.channelId,
    stock_location_id: "sloc_injected", context_id: "cmctx_injected", region_id: fixture.regionId,
    metadata: { merchant_id: second.merchantId }, unit_price: 0,
  };
  const mutationTargets = [
    { path: itemsPath, method: "POST", input: body(first.variantId, 1, sameId) },
    { path: itemPath, method: "PATCH", input: { cart_id: sameId, quantity: 1 } },
    { path: itemPath, method: "DELETE", input: { cart_id: sameId } },
    { path: switchPath, method: "POST", input: { ...body(second.variantId), cart_id: sameId, confirm: true } },
  ];
  const beforeHostile = Number((await line(sameId)).quantity);
  for (const [field, value] of Object.entries(attacks)) {
    for (const target of mutationTargets) {
      expectStatus(await response(target.path, same.cookie, target.method,
        { ...target.input, [field]: value }), 400);
    }
  }
  for (const target of mutationTargets) {
    expectStatus(await response(target.path + "?customer_id=" + outsider.id, same.cookie,
      target.method, target.input), 400);
  }
  assert.equal(Number((await line(sameId)).quantity), beforeHostile);
  assert.equal(Number((await line(foreignId)).quantity), 1);
  await assertCurrentBinding(same.id, sameId, first);
  expectStatus(await response(itemsPath, same.cookie, "POST", { ...body(), quantity: 0 }), 400);
  expectStatus(await response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 0 }), 400);

  const beforeRejected = Number((await line(sameId)).quantity);
  expectStatus(await response(itemsPath, same.cookie, "POST", body(second.variantId, 1, sameId)), 409);
  expectStatus(await response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 8 }), 400);
  expectStatus(await response(itemsPath, same.cookie, "POST", { ...body(), location: { latitude: 90, longitude: 180 } }), 404);
  expectStatus(await response(itemsPath, same.cookie, "POST", { ...body(), location: { address_id: "cuaddr_not_owned" } }), 404);
  assert.equal(Number((await line(sameId)).quantity), beforeRejected);

  // Native inventory rejection must preserve the existing line and binding.
  const inventoryFailure = await response(itemsPath, same.cookie, "POST", body(first.variantId, 1000, sameId));
  expectStatus(inventoryFailure, 409);
  assert.equal(z.object({ code: z.string() }).parse(inventoryFailure.body).code, "CART_INVENTORY_UNAVAILABLE");
  assert.equal(Number((await line(sameId)).quantity), beforeRejected);
  assert.equal((await currentContexts(same.id)).length, 1);

  const [variant] = await products.listProductVariants({ id: first.variantId }, { select: ["id", "product_id"], take: 1 });
  assert.ok(variant?.product_id);
  await products.updateProducts(variant.product_id, { status: ProductStatus.DRAFT });
  try {
    expectStatus(await response(itemsPath, same.cookie, "POST", body(first.variantId, 1, sameId)), 404);
  } finally {
    await products.updateProducts(variant.product_id, { status: ProductStatus.PUBLISHED });
  }

  await db("merchant_store").where({ id: first.store.id }).update({ active: false });
  try {
    expectStatus(await response(itemsPath, same.cookie, "POST", body(first.variantId, 1, sameId)), 404);
    expectStatus(await response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 8, location }), 404);
    expectStatus(await response(itemPath, same.cookie, "PATCH", { cart_id: sameId, quantity: 1 }), 200);
    assert.equal(Number((await line(sameId)).quantity), 1);
    expectStatus(await response(itemPath, same.cookie, "DELETE", { cart_id: sameId }), 200);
    assert.equal((await native(sameId)).items?.length, 0);
    assert.equal((await currentContexts(same.id))[0]?.medusa_cart_id, sameId, "empty cart remains bound");
  } finally {
    await db("merchant_store").where({ id: first.store.id }).update({ active: true });
  }
  expectStatus(await response(itemsPath, same.cookie, "POST", body(second.variantId, 1, sameId)), 409);
  expectStatus(await response(itemsPath, same.cookie, "POST", body(first.variantId, 1, sameId)), 200);
  item = await line(sameId);

  const switchInput = { ...body(second.variantId), cart_id: sameId, confirm: true };
  expectStatus(await response(switchPath, same.cookie, "POST", { ...switchInput, confirm: false }), 400);
  expectStatus(await response(switchPath, outsider.cookie, "POST", switchInput), 404);
  expectStatus(await response(switchPath, same.cookie, "POST",
    { ...switchInput, location: { latitude: 90, longitude: 180 } }), 404);
  const failedSwitch = await response(switchPath, same.cookie, "POST", { ...switchInput, quantity: 1000 });
  expectStatus(failedSwitch, 409);
  assert.equal((await currentContexts(same.id))[0]?.medusa_cart_id, sameId);

  // Force a real FK publication failure after native creation; compensation
  // must leave the old cart current and remove only the unpublished candidate.
  const countBefore = (await carts.listCarts({ customer_id: same.id }, { take: null })).length;
  await assert.rejects(() => cartOperation(container, same.id, () => switchMarketplaceCart(container, {
    oldCartId: sameId, customerId: same.id,
    merchantId: second.merchantId, storeId: first.store.id,
    channelId: second.channelId, regionId: fixture.regionId,
    variantId: second.variantId, quantity: 1,
  })));
  assert.equal((await carts.listCarts({ customer_id: same.id }, { take: null })).length, countBefore);
  assert.equal((await currentContexts(same.id))[0]?.medusa_cart_id, sameId);

  const switched = await concurrent([
    response(switchPath, same.cookie, "POST", switchInput),
    response(itemsPath, same.cookie, "POST", body(first.variantId, 1, sameId)),
  ]);
  expectStatus(switched[0]!, 200);
  assert.ok([200, 404].includes(switched[1]!.status), JSON.stringify(switched));
  const replacementId = cartResponse.parse(switched[0]!.body).cart_id;
  assert.notEqual(replacementId, sameId);
  const replacement = await native(replacementId);
  assert.equal(replacement.sales_channel_id, second.channelId);
  assert.equal(replacement.customer_id, same.id);
  assert.equal(replacement.items?.length, 1);
  assert.equal(replacement.items?.[0]?.variant_id, second.variantId);
  assert.equal(Number(replacement.items?.[0]?.quantity), 1);
  await assertCurrentBinding(same.id, replacementId, second);
  const current = await currentContexts(same.id);
  assert.equal(current.length, 1);
  assert.equal(current[0]?.medusa_cart_id, replacementId);
  assert.equal(current[0]?.merchant_id, second.merchantId);
  const oldContext = await db("cart_marketplace_context").where({ medusa_cart_id: sameId }).first();
  assert.ok(oldContext.superseded_at);
  assert.equal(oldContext.merchant_id, first.merchantId);
  assert.ok((await native(sameId)).items?.every((oldItem) => oldItem.variant_id === first.variantId));
  expectStatus(await response(itemsPath, same.cookie, "POST", body(first.variantId, 1, sameId)), 404);
  expectStatus(await response(itemsPath + "/" + item.id, same.cookie, "PATCH", { cart_id: sameId, quantity: 1 }), 404);
  expectStatus(await response(itemsPath + "/" + item.id, same.cookie, "DELETE", { cart_id: sameId }), 404);
  expectStatus(await response(switchPath, same.cookie, "POST", switchInput), 404);
  const restored = await request("/store/gospaza/cart", same.cookie);
  assert.equal(restored.status, 200);
  assert.equal(z.object({ cart: z.object({ id: z.string() }) }).parse(await restored.json()).cart.id, replacementId);
}

export default async function verifyCartMutations(args: ExecArgs) {
  await verifyCartFoundation(args, verifyMutations);
  console.log("M8-C passed: real HTTP concurrency, ownership, eligibility, native inventory, switching and compensation.");
}
