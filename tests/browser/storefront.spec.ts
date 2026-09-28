import { test, expect } from "@playwright/test";
import { transition } from "./transitions";
import type { Page } from "@playwright/test";
import type { PublicProduct, PublicStore } from "@gospaza/contracts";

const base = "http://localhost:3000";
const stores: PublicStore[] = [
  { id: "mstore_first", name: "Neighbourhood Grocer", availability: "available" },
  { id: "mstore_second", name: "Corner Pantry", availability: "available" },
];
const product: PublicProduct = {
  id: "prod_tomatoes", title: "Fixture tomatoes", description: "Fresh local produce", store: stores[0]!,
  requires_age_verification: true,
  images: [{ id: "img_public", url: "http://localhost:9000/static/catalogue/fixture.png" }],
  currency_code: "zar", min_price_minor: 1099, max_price_minor: 2099, availability: "in_stock",
  variants: [
    { id: "v500", title: "500g", price_minor: 1099, currency_code: "zar", availability: "in_stock" },
    { id: "v1000", title: "1kg", price_minor: 2099, currency_code: "zar", availability: "out_of_stock" },
  ],
};
async function mock(page: Page) {
  const seen: string[] = [];
  const state = { outage: false };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    seen.push(path);
    const headers = {
      "access-control-allow-origin": base, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,OPTIONS", "cache-control": "no-store",
    };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_fixture" } }); return; }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_fixture", email: "customer@example.test", first_name: null, last_name: null } }); return; }
    if (path === "/store/gospaza/addresses") {
      await reply({ addresses: [{
        id: "cuaddr_fixture", first_name: "Test", last_name: "Customer", address_1: "1 Fixture Street", address_2: "",
        city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "za", phone: "",
        location: { latitude: 1, longitude: 26, source: "browser_geolocation" },
      }] }); return;
    }
    if (path === "/static/catalogue/fixture.png") {
      await route.fulfill({ status: 200, headers, contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") }); return;
    }
    const data = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : Object.fromEntries(url.searchParams);
    const count = data.address_id === "cuaddr_fixture" ? 1 : Number(data.latitude);
    const eligible = stores.slice(0, Math.max(0, Math.min(2, count)));
    if (state.outage) { await reply({ message: "Unavailable" }, 503); return; }
    if (path === "/store/gospaza/discovery") {
      await reply({ mode: eligible.length === 0 ? "none" : eligible.length === 1 ? "single" : "multiple",
        eligible_store_count: eligible.length, stores: eligible, count: eligible.length, offset: 0, limit: 20 }); return;
    }
    if (path === "/store/gospaza/stores/mstore_first/products") {
      if (!eligible.length) { await reply({}, 404); return; }
      await reply({ store: stores[0], products: [product], count: 1, limit: 20, offset: 0 }); return;
    }
    if (path === "/store/gospaza/products/prod_tomatoes") {
      await reply(eligible.length ? { product } : {}, eligible.length ? 200 : 404); return;
    }
    if (path === "/store/gospaza/search") {
      const matches = eligible.length && (!data.q || String(data.q).toLowerCase().includes("tomato")) ? [product] : [];
      await reply({ eligible_store_count: eligible.length, stores: [], store_count: 0, products: matches,
        count: matches.length, offset: 0, limit: 20 }); return;
    }
    await reply({}, 404);
  });
  return { seen, state };
}
test.beforeAll(async ({ request }) => {
  for (const path of ["/", "/stores", "/stores/mstore_first", "/products/prod_tomatoes", "/search"]) {
    const response = await request.get(base + path);
    expect(response.ok()).toBe(true);
    await response.dispose();
  }
});
async function currentLocation(page: Page) {
  await page.getByRole("button", { name: "Use current location", exact: true }).click();
}
for (const count of [0, 1, 2]) test("M7 location discovers " + count + " stores", async ({ page, context }) => {
  await mock(page);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: count, longitude: 26 });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Good food starts close to home.", exact: true })).toBeVisible();
  await currentLocation(page);
  if (!count) {
    await expect(page.getByRole("heading", { name: "GoSpaza is not available at this location yet.", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Fixture tomatoes", exact: true })).toHaveCount(0);
  } else if (count === 1) {
    await expect(page.getByRole("heading", { name: stores[0]!.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: product.title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Stores in your neighbourhood", exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByRole("heading", { name: "Stores in your neighbourhood", exact: true })).toBeVisible();
    for (const store of stores) await expect(page.getByRole("link", { name: store.name, exact: true })).toBeVisible();
  }
});
test("M7 store and product retain location and expose native variant presentation", async ({ page }) => {
  const { seen } = await mock(page);
  await page.goto(base + "/stores");
  await transition(page, {
    responses: [{ path: "/store/gospaza/addresses", method: "GET" }],
  }, () => page.getByRole("button", { name: "Choose saved address", exact: true }).click());
  await transition(page, {
    responses: [{ path: "/store/gospaza/discovery", method: "POST" }],
  }, () => page.getByRole("combobox", { name: "Saved address", exact: true }).selectOption("cuaddr_fixture"));
  await transition(page, {
    url: base + "/stores/mstore_first",
    responses: [{ path: "/store/gospaza/stores/mstore_first/products", method: "GET", query: { address_id: "cuaddr_fixture" } }],
  }, () => page.getByRole("link", { name: stores[0]!.name, exact: true }).click());
  await expect(page).toHaveURL(base + "/stores/mstore_first");
  await transition(page, {
    url: base + "/products/prod_tomatoes",
    responses: [{ path: "/store/gospaza/products/prod_tomatoes", method: "GET", query: { address_id: "cuaddr_fixture" } }],
  }, () => page.getByRole("link", { name: product.title, exact: true }).click());
  await expect(page).toHaveURL(base + "/products/prod_tomatoes");
  await expect(page.getByRole("heading", { name: product.title, exact: true })).toBeVisible();
  const variants = page.locator(".variant-list");
  await expect(variants.getByText("500g", { exact: true })).toBeVisible();
  await expect(variants.getByText("1kg", { exact: true })).toBeVisible();
  await expect(variants).toContainText(/10[,.]99/);
  await expect(variants).toContainText(/20[,.]99/);
  await expect(variants.getByText("In stock", { exact: true })).toBeVisible();
  await expect(variants.getByText("Out of stock", { exact: true })).toBeVisible();
  await expect(page.getByText("Alcohol / restricted product. Age verification will be required before purchase.", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: product.title, exact: true })).toHaveAttribute("src", product.images[0]!.url);
  await expect(page.getByRole("button", { name: /add to cart/i })).toHaveCount(0);
  expect(seen).toContain("/store/gospaza/stores/mstore_first/products");
  expect(seen).toContain("/store/gospaza/products/prod_tomatoes");
});
test("M7 search and location changes separate no-results from no-service", async ({ page, context }) => {
  await mock(page);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: 1, longitude: 26 });
  await page.goto(base + "/search");
  await currentLocation(page);
  await page.getByLabel("Search products or stores", { exact: true }).fill("tomatoes");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: product.title, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: stores[1]!.name, exact: true })).toHaveCount(0);
  await page.getByLabel("Search products or stores", { exact: true }).fill("not-in-catalogue");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No matching products or stores. Try another search.", { exact: true })).toBeVisible();
  await context.setGeolocation({ latitude: 0, longitude: 26 });
  await currentLocation(page);
  await expect(page.getByRole("heading", { name: "GoSpaza is not available at this location yet.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: product.title, exact: true })).toHaveCount(0);
});
test("M7 outage is retryable and is never represented as no service", async ({ page, context }) => {
  const { state } = await mock(page);
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: 1, longitude: 26 });
  state.outage = true;
  await page.goto(base);
  await currentLocation(page);
  await expect(page.locator("p.shop-error")).toHaveText("Storefront is unavailable. Please try again.");
  await expect(page.getByRole("heading", { name: "GoSpaza is not available at this location yet.", exact: true })).toHaveCount(0);
  state.outage = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("link", { name: product.title, exact: true })).toBeVisible();
});
