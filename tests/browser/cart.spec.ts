import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CartFoundation, CustomerCart, PublicProduct, PublicStore } from "@gospaza/contracts";
import { transition } from "./transitions";

const base = "http://localhost:3000";
const api = "http://localhost:9000";
const stores: PublicStore[] = [
  { id: "mstore_first", name: "Neighbourhood Grocer", availability: "available" },
  { id: "mstore_second", name: "Corner Pantry", availability: "available" },
];
const first: PublicProduct = {
  id: "prod_first", title: "Fixture tomatoes", description: "Fresh local produce", store: stores[0]!,
  requires_age_verification: false,
  images: [{ id: "img_first", url: api + "/static/catalogue/first.png" }],
  currency_code: "zar", min_price_minor: 1099, max_price_minor: 1899, availability: "in_stock",
  variants: [
    { id: "variant_500", title: "500g", price_minor: 1099, currency_code: "zar", availability: "in_stock" },
    { id: "variant_1kg", title: "1kg", price_minor: 1899, currency_code: "zar", availability: "in_stock" },
  ],
};
const second: PublicProduct = {
  id: "prod_second", title: "Fixture bread", description: "A local loaf", store: stores[1]!,
  requires_age_verification: false,
  images: [{ id: "img_second", url: api + "/static/catalogue/second.png" }],
  currency_code: "zar", min_price_minor: 1599, max_price_minor: 1599, availability: "in_stock",
  variants: [{ id: "variant_bread", title: "700g", price_minor: 1599, currency_code: "zar", availability: "in_stock" }],
};

function cart(storeIndex: number, lines: { id: string; product: PublicProduct; variantId: string; quantity: number }[]): CustomerCart {
  const items = lines.map((line) => {
    const variant = line.product.variants.find((candidate) => candidate.id === line.variantId)!;
    return {
      id: line.id, product_id: line.product.id, variant_id: variant.id,
      product_title: line.product.title, variant_title: variant.title,
      image_url: line.product.images[0]?.url ?? null,
      unit_price_minor: variant.price_minor, quantity: line.quantity,
      subtotal_minor: variant.price_minor * line.quantity,
    };
  });
  return {
    id: "cart_" + (storeIndex ? "second" : "first"),
    store: { id: stores[storeIndex]!.id, name: stores[storeIndex]!.name },
    items, currency_code: "zar",
    subtotal_minor: items.reduce((total, item) => total + item.subtotal_minor, 0),
    item_count: items.reduce((total, item) => total + item.quantity, 0),
  };
}

async function mock(page: Page, seeded?: CartFoundation) {
  const state: {
    foundation: CartFoundation;
    uncertainNext: boolean;
    cartOutage: boolean;
    mutationBodies: unknown[];
    currentReads: number;
    beforeUpdate?: () => Promise<void>;
  } = {
    foundation: seeded ?? { cart: null, state: "empty", eligibility: "pending" },
    uncertainNext: false, cartOutage: false, mutationBodies: [], currentReads: 0,
  };
  await page.route(api + "/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = {
      "access-control-allow-origin": base, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "cache-control": "no-store",
    };
    const reply = (body: unknown, status = 200) =>
      route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_fixture" } }); return; }
    if (path === "/store/customers/me") {
      await reply({ customer: { id: "cus_fixture", email: "customer@example.test", first_name: null, last_name: null } }); return;
    }
    if (path.startsWith("/static/catalogue/")) {
      await route.fulfill({ status: 200, headers, contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
      return;
    }
    if (path === "/store/gospaza/cart" && request.method() === "GET") {
      state.currentReads++;
      if (state.cartOutage) { await reply({ code: "CART_UNAVAILABLE" }, 503); return; }
      await reply(state.foundation); return;
    }
    if (path === "/store/gospaza/discovery") {
      await reply({ mode: "multiple", eligible_store_count: 2, stores, count: 2, limit: 20, offset: 0 }); return;
    }
    if (path === "/store/gospaza/products/" + first.id) { await reply({ product: first }); return; }
    if (path === "/store/gospaza/products/" + second.id) { await reply({ product: second }); return; }
    if (path === "/store/gospaza/stores/mstore_first/products") {
      await reply({ store: stores[0], products: [first], count: 1, limit: 20, offset: 0 }); return;
    }
    if (path === "/store/gospaza/stores/mstore_second/products") {
      await reply({ store: stores[1], products: [second], count: 1, limit: 20, offset: 0 }); return;
    }
    if (path === "/store/gospaza/cart/items" && request.method() === "POST") {
      const body = request.postDataJSON() as { cart_id?: string; variant_id: string; quantity: number };
      state.mutationBodies.push(body);
      if (state.uncertainNext) {
        state.uncertainNext = false;
        await reply({ code: "CART_MUTATION_UNCERTAIN" }, 503); return;
      }
      if (state.foundation.cart?.store.id === stores[0]!.id && body.variant_id === second.variants[0]!.id) {
        await reply({ code: "CART_MERCHANT_CONFLICT" }, 409); return;
      }
      const product = body.variant_id === second.variants[0]!.id ? second : first;
      const storeIndex = product === second ? 1 : 0;
      const prior = state.foundation.cart?.items ?? [];
      const variant = product.variants.find((candidate) => candidate.id === body.variant_id)!;
      const existing = prior.find((item) => item.variant_id === body.variant_id);
      const lines = prior.filter((item) => item.variant_id !== body.variant_id).map((item) => ({
        id: item.id, product: item.product_id === first.id ? first : second,
        variantId: item.variant_id, quantity: item.quantity,
      }));
      lines.push({ id: existing?.id ?? "cali_" + body.variant_id, product, variantId: variant.id,
        quantity: (existing?.quantity ?? 0) + body.quantity });
      state.foundation = { cart: cart(storeIndex, lines), state: "current", eligibility: "pending" };
      await reply({ cart_id: state.foundation.cart.id }); return;
    }
    if (path === "/store/gospaza/cart/switch-store" && request.method() === "POST") {
      const body = request.postDataJSON() as { variant_id: string; quantity: number; confirm: boolean };
      state.mutationBodies.push(body);
      expect(body.confirm).toBe(true);
      expect(body).not.toHaveProperty("merchant_id");
      expect(body).not.toHaveProperty("store_id");
      state.foundation = { cart: cart(1, [{ id: "cali_bread", product: second,
        variantId: body.variant_id, quantity: body.quantity }]), state: "current", eligibility: "pending" };
      await reply({ cart_id: state.foundation.cart.id }); return;
    }
    if (path.startsWith("/store/gospaza/cart/items/") && request.method() === "PATCH") {
      const body = request.postDataJSON() as { quantity: number };
      state.mutationBodies.push(body);
      await state.beforeUpdate?.();
      if (state.uncertainNext) {
        state.uncertainNext = false;
        await reply({ code: "CART_MUTATION_UNCERTAIN" }, 503); return;
      }
      const itemId = decodeURIComponent(path.split("/").at(-1)!);
      const existing = state.foundation.cart!;
      const lines = existing.items.map((item) => ({
        id: item.id, product: item.product_id === first.id ? first : second,
        variantId: item.variant_id, quantity: item.id === itemId ? body.quantity : item.quantity,
      }));
      state.foundation = { ...state.foundation, cart: cart(existing.store.id === stores[1]!.id ? 1 : 0, lines) };
      await reply({ cart_id: state.foundation.cart!.id }); return;
    }
    if (path.startsWith("/store/gospaza/cart/items/") && request.method() === "DELETE") {
      state.mutationBodies.push(request.postDataJSON());
      const itemId = decodeURIComponent(path.split("/").at(-1)!);
      const existing = state.foundation.cart!;
      const lines = existing.items.filter((item) => item.id !== itemId).map((item) => ({
        id: item.id, product: item.product_id === first.id ? first : second,
        variantId: item.variant_id, quantity: item.quantity,
      }));
      state.foundation = { ...state.foundation, cart: cart(existing.store.id === stores[1]!.id ? 1 : 0, lines) };
      await reply({ cart_id: state.foundation.cart!.id }); return;
    }
    await reply({}, 404);
  });
  return state;
}

test.beforeAll(async ({ request }) => {
  for (const path of ["/cart", "/products/prod_first", "/products/prod_second"]) {
    const response = await request.get(base + path);
    expect(response.ok()).toBe(true);
    await response.dispose();
  }
});

async function selectLocation(page: Page) {
  await transition(page, {
    responses: [{ path: "/store/gospaza/products/" + new URL(page.url()).pathname.split("/").at(-1), method: "GET" }],
  }, () => page.getByRole("button", { name: "Use current location", exact: true }).click());
}

test("first and same-store adds persist through navigation and support quantity/removal", async ({ page, context }) => {
  await mock(page);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: -29, longitude: 26 });
  await page.goto(base + "/products/" + first.id);
  await selectLocation(page);
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items", method: "POST" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => page.getByRole("button", { name: "Add to cart", exact: true }).click());
  await expect(page.getByRole("link", { name: "Cart (1)", exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "Variant for " + first.title, exact: true }).selectOption("variant_1kg");
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items", method: "POST" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => page.getByRole("button", { name: "Add to cart", exact: true }).click());
  await expect(page.getByRole("link", { name: "Cart (2)", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Stores", exact: true }).click();
  await page.getByRole("link", { name: "Cart (2)", exact: true }).click();
  await expect(page).toHaveURL(base + "/cart");
  await expect(page.getByRole("heading", { name: first.title, exact: true })).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole("heading", { name: first.title, exact: true })).toHaveCount(2);
  await expect(page.getByText("1kg", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Use current location", exact: true }).click();
  const tomatoes500 = page.locator(".cart-lines > li").filter({ hasText: "500g" });
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items/cali_variant_500", method: "PATCH" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => tomatoes500.getByRole("button", { name: "Increase " + first.title, exact: true }).click());
  await expect(tomatoes500.getByLabel("Current quantity for " + first.title)).toHaveText("2");
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items/cali_variant_500", method: "DELETE" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => tomatoes500.getByRole("button", { name: "Remove " + first.title, exact: true }).click());
  await expect(page.getByText("500g", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1kg", { exact: true })).toBeVisible();
});

test("cross-store conflict keeps the current cart until explicit switch confirmation", async ({ page, context }) => {
  const seeded = { cart: cart(0, [{ id: "cali_tomatoes", product: first,
    variantId: "variant_500", quantity: 1 }]), state: "current", eligibility: "pending" } as const;
  const state = await mock(page, seeded);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: -29, longitude: 26 });
  await page.goto(base + "/products/" + second.id);
  await selectLocation(page);
  await transition(page, {
    responses: [{ path: "/store/gospaza/cart/items", method: "POST", status: 409 }],
  }, () => page.getByRole("button", { name: "Add to cart", exact: true }).click());
  const dialog = page.getByRole("dialog", { name: "Start a new store cart?", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep current cart", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.foundation.cart?.store.id).toBe(stores[0]!.id);
  expect(state.foundation.cart?.items.map((item) => item.product_id)).toEqual([first.id]);
  expect(state.mutationBodies).toHaveLength(1);
  expect(state.mutationBodies[0]).not.toHaveProperty("confirm");

  await transition(page, {
    responses: [{ path: "/store/gospaza/cart/items", method: "POST", status: 409 }],
  }, () => page.getByRole("button", { name: "Add to cart", exact: true }).click());
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/switch-store", method: "POST" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_second" } },
    ],
  }, () => dialog.getByRole("button", { name: "Start new cart for this store", exact: true }).click());
  await expect(page.getByRole("link", { name: "Cart (1)", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Cart (1)", exact: true }).click();
  await expect(page.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: first.title, exact: true })).toHaveCount(0);
  expect(state.foundation.cart?.items.map((item) => item.product_id)).toEqual([second.id]);
});

test("stale carts allow escape mutations and uncertain changes require reload", async ({ page, context }) => {
  const seeded = { cart: cart(0, [{ id: "cali_tomatoes", product: first,
    variantId: "variant_500", quantity: 2 }]), state: "stale", eligibility: "unavailable" } as const;
  const state = await mock(page, seeded);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: -29, longitude: 26 });
  await page.goto(base + "/cart");
  await expect(page.getByText("This cart is currently unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Increase " + first.title, exact: true })).toBeDisabled();
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items/cali_tomatoes", method: "PATCH" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => page.getByRole("button", { name: "Decrease " + first.title, exact: true }).click());
  await expect(page.getByLabel("Current quantity for " + first.title)).toHaveText("1");

  state.foundation = { ...state.foundation, state: "current", eligibility: "pending" };
  await page.reload();
  await expect(page.getByText("This cart is currently unavailable.", { exact: true })).toHaveCount(0);
  state.uncertainNext = true;
  await page.getByRole("button", { name: "Use current location", exact: true }).click();
  await page.getByRole("button", { name: "Increase " + first.title, exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reload your cart before trying again." })).toBeVisible();
  await expect(page.getByLabel("Current quantity for " + first.title)).toHaveText("1");
  await page.getByRole("button", { name: "Reload cart", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Reload your cart before trying again." })).toHaveCount(0);
});


test("empty cart and restoration failure expose deterministic retry states", async ({ page }) => {
  const state = await mock(page);
  state.cartOutage = true;
  await page.goto(base + "/cart");
  await expect(page.getByRole("heading", { name: "Your cart could not be loaded.", exact: true })).toBeVisible();
  await expect(page.locator('p.shop-error[role="alert"]')).toContainText("Cart service is unavailable.");

  state.cartOutage = false;
  await transition(page, {
    responses: [{ path: "/store/gospaza/cart", method: "GET" }],
  }, () => page.getByRole("button", { name: "Try again", exact: true }).click());
  await expect(page.getByRole("heading", { name: "Your cart is empty.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse stores", exact: true })).toBeVisible();
});


test("pending location permits decrease and removal while focus cannot strand a mutation", async ({ page }) => {
  const state = await mock(page, {
    cart: cart(0, [{ id: "cali_tomatoes", product: first, variantId: "variant_500", quantity: 2 }]),
    state: "current", eligibility: "pending",
  });
  await page.goto(base + "/cart");
  await expect(page.getByLabel("Current quantity for " + first.title)).toHaveText("2");
  await expect(page.getByRole("button", { name: "Increase " + first.title, exact: true })).toBeDisabled();

  let releaseUpdate: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { releaseUpdate = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  state.beforeUpdate = async () => { markStarted?.(); await held; };
  const readsBefore = state.currentReads;
  const mutation = transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items/cali_tomatoes", method: "PATCH" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => page.getByRole("button", { name: "Decrease " + first.title, exact: true }).click());
  try {
    await Promise.race([started, mutation]);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    releaseUpdate?.();
    await mutation;
  }
  await expect(page.getByLabel("Current quantity for " + first.title)).toHaveText("1");
  expect(state.currentReads).toBe(readsBefore + 1);
  await expect(page.getByRole("button", { name: "Remove " + first.title, exact: true })).toBeEnabled();
  await transition(page, {
    responses: [
      { path: "/store/gospaza/cart/items/cali_tomatoes", method: "DELETE" },
      { path: "/store/gospaza/cart", method: "GET", query: { cart_id: "cart_first" } },
    ],
  }, () => page.getByRole("button", { name: "Remove " + first.title, exact: true }).click());
  await expect(page.getByRole("heading", { name: "No items in this cart.", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: stores[0]!.name, exact: true })).toBeVisible();
  expect(state.mutationBodies).toEqual([
    { cart_id: "cart_first", quantity: 1 },
    { cart_id: "cart_first" },
  ]);

  // Normal foreground restoration remains active after the mutation completes.
  state.foundation = { cart: null, state: "empty", eligibility: "pending" };
  await transition(page, {
    responses: [{ path: "/store/gospaza/cart", method: "GET" }],
  }, () => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
  await expect(page.getByRole("heading", { name: "Your cart is empty.", exact: true })).toBeVisible();
});
