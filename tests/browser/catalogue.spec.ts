import { test, expect } from "@playwright/test";
import { transition } from "./transitions";
import type { Page } from "@playwright/test";
import type { CatalogueProduct, CatalogueWrite, MerchantCapability, MerchantContext, MerchantMemberRole } from "../../packages/contracts/src";

const base = "http://localhost:3001";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const permissions: Record<MerchantMemberRole, MerchantCapability[]> = {
  OWNER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_TEAM_MANAGE", "MERCHANT_CATALOG_VIEW", "MERCHANT_CATALOG_MANAGE", "MERCHANT_INVENTORY_VIEW", "MERCHANT_INVENTORY_MANAGE"],
  MANAGER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_CATALOG_VIEW", "MERCHANT_CATALOG_MANAGE", "MERCHANT_INVENTORY_VIEW", "MERCHANT_INVENTORY_MANAGE"],
  PICKER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_CATALOG_VIEW", "MERCHANT_INVENTORY_VIEW"],
};
function fixture(): CatalogueProduct {
  return {
    id: "prod_fixture", title: "Fixture tomatoes", description: "Fresh tomatoes", status: "draft", requires_age_verification: false, images: [],
    variants: [{ id: "variant_fixture", title: "Default", sku: "TOMATO", price_minor: 1099, currency_code: "zar", inventory_item_id: "iitem_fixture", stocked_quantity: 12, reserved_quantity: 2, available_quantity: 10 }],
  };
}
async function mock(page: Page, role: MerchantMemberRole = "OWNER", empty = false) {
  const state = { products: empty ? [] as CatalogueProduct[] : [fixture()], writes: [] as string[], active: true, uploadFails: false };
  const context: MerchantContext = {
    merchant: { id: "mer_fixture", legal_name: "Fixture", trading_name: "Fixture shop" },
    store: { id: "mstore_fixture", name: "Fixture shop" },
    membership: { id: "mmem_fixture", member_type: role, capabilities: permissions[role] },
  };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? base,
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "cache-control": "no-store",
    };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (!state.active) { await reply({}, 401); return; }
    if (url.pathname === "/merchant/me") { await reply(context); return; }
    if (method !== "GET") {
      state.writes.push(method + " " + url.pathname);
      if (role === "PICKER") { await reply({}, 403); return; }
    }
    if (url.pathname === "/merchant/products" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase(), status = url.searchParams.get("status");
      const products = state.products.filter((p) => p.title.toLowerCase().includes(q) && (!status || p.status === status));
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
      await reply({ products: products.slice(offset, offset + limit), count: products.length, offset, limit }); return;
    }
    const productMatch = /^\/merchant\/products\/([^/]+)$/.exec(url.pathname);
    if ((url.pathname === "/merchant/products" && method === "POST") || (productMatch && method === "PATCH")) {
      const input = request.postDataJSON() as CatalogueWrite;
      const existing = productMatch ? state.products.find((p) => p.id === productMatch[1]) : undefined;
      if (productMatch && !existing) { await reply({}, 404); return; }
      const product: CatalogueProduct = {
        ...input, id: existing?.id ?? "prod_created", images: existing?.images ?? [],
        variants: input.variants.map((v, i) => ({ ...v, id: v.id ?? "variant_created_" + i, currency_code: "zar",
          inventory_item_id: existing?.variants.find((old) => old.id === v.id)?.inventory_item_id ?? "iitem_created_" + i,
          reserved_quantity: 0, available_quantity: v.stocked_quantity })),
      };
      if (existing) state.products = state.products.map((p) => p.id === existing.id ? product : p);
      else state.products.push(product);
      await reply({ product }, existing ? 200 : 201); return;
    }
    if (productMatch && method === "GET") {
      const product = state.products.find((p) => p.id === productMatch[1]);
      await reply({ product }, product ? 200 : 404); return;
    }
    if (url.pathname === "/merchant/inventory" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const items = state.products.flatMap((p) => p.variants.map((v) => ({ ...v, product_id: p.id, product_title: p.title })))
        .filter((v) => (v.product_title + " " + v.sku).toLowerCase().includes(q));
      await reply({ items, count: items.length, offset: 0, limit: 20 }); return;
    }
    const stockMatch = /^\/merchant\/inventory\/([^/]+)$/.exec(url.pathname);
    if (stockMatch && method === "PATCH") {
      const product = state.products.find((p) => p.variants.some((v) => v.inventory_item_id === stockMatch[1]));
      const variant = product?.variants.find((v) => v.inventory_item_id === stockMatch[1]);
      if (!product || !variant) { await reply({}, 404); return; }
      variant.stocked_quantity = (request.postDataJSON() as { stocked_quantity: number }).stocked_quantity;
      variant.available_quantity = variant.stocked_quantity - variant.reserved_quantity;
      await reply({ product }); return;
    }
    const imageMatch = /^\/merchant\/products\/([^/]+)\/images(?:\/([^/]+))?$/.exec(url.pathname);
    if (imageMatch) {
      const product = state.products.find((p) => p.id === imageMatch[1]);
      if (!product) { await reply({}, 404); return; }
      if (method === "POST") {
        if (state.uploadFails) { await reply({}, 400); return; }
        product.images.push({ id: "img_fixture", url: "http://localhost:9000/static/catalogue/gospaza-public-v1/fixture.png" });
        await reply({ product }, 201); return;
      }
      if (method === "DELETE") {
        product.images = product.images.filter((p) => p.id !== imageMatch[2]);
        await reply({ product }); return;
      }
    }
    if (url.pathname === "/static/catalogue/gospaza-public-v1/fixture.png") {
      await route.fulfill({ status: 200, contentType: "image/png", body: png }); return;
    }
    await reply({}, 404);
  });
  return state;
}

test.beforeAll(async ({ request }) => {
  for (const route of ["/merchant/products", "/merchant/products/new", "/merchant/products/prod_fixture", "/merchant/inventory"]) {
    const response = await request.get(base + route);
    expect(response.ok(), "M5 route must be ready: " + route).toBe(true);
    await response.dispose();
  }
});

test("owner creates a simple published restricted product", async ({ page }) => {
  const state = await mock(page, "OWNER", true);
  await page.goto(base + "/merchant/products");
  await expect(page.getByText("No products found.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Create product", exact: true }).click();
  await page.getByLabel("Product title", { exact: true }).fill("Local juice");
  await page.getByLabel("Price (ZAR)", { exact: true }).fill("109.99");
  await page.getByLabel("Stocked units", { exact: true }).fill("12");
  await page.getByLabel("Alcohol / restricted product", { exact: true }).check();
  await page.getByRole("combobox", { name: "Product status", exact: true }).selectOption("published");
  await transition(page, {
    url: base + "/merchant/products/prod_created",
    responses: [
      { path: "/merchant/products", method: "POST", status: 201 },
      { path: "/merchant/products/prod_created", method: "GET" },
    ],
  }, () => page.getByRole("button", { name: "Create product", exact: true }).click());
  await expect(page).toHaveURL(base + "/merchant/products/prod_created");
  await expect(page.getByLabel("Product title", { exact: true })).toHaveValue("Local juice");
  expect(state.products[0]?.variants[0]?.price_minor).toBe(10999);
  expect(state.products[0]?.requires_age_verification).toBe(true);
  expect(state.products[0]?.status).toBe("published");
});

test("owner creates predefined 500g 1kg and 2kg variants", async ({ page }) => {
  const state = await mock(page, "OWNER", true);
  await page.goto(base + "/merchant/products/new");
  await page.getByLabel("Product title", { exact: true }).fill("Tomatoes");
  await page.getByRole("button", { name: "Use 500g / 1kg / 2kg", exact: true }).click();
  for (const [index, title] of ["500g", "1kg", "2kg"].entries()) {
    const group = page.getByRole("group", { name: "Variant " + (index + 1), exact: true });
    await expect(group.getByLabel("Variant name", { exact: true })).toHaveValue(title);
    await group.getByLabel("Price (ZAR)", { exact: true }).fill(String(10 + index));
    await group.getByLabel("Stocked units", { exact: true }).fill(String(12 + index));
  }
  await transition(page, {
    url: base + "/merchant/products/prod_created",
    responses: [
      { path: "/merchant/products", method: "POST", status: 201 },
      { path: "/merchant/products/prod_created", method: "GET" },
    ],
  }, () => page.getByRole("button", { name: "Create product", exact: true }).click());
  await expect(page).toHaveURL(base + "/merchant/products/prod_created");
  expect(state.products[0]?.variants.map((v) => v.title)).toEqual(["500g", "1kg", "2kg"]);
  expect(state.products[0]?.variants.map((v) => v.stocked_quantity)).toEqual([12, 13, 14]);
});

test("manager edits product and native stocked quantity", async ({ page }) => {
  const state = await mock(page, "MANAGER");
  await page.goto(base + "/merchant/products/prod_fixture");
  await page.getByLabel("Product title", { exact: true }).fill("Updated tomatoes");
  await page.getByLabel("Price (ZAR)", { exact: true }).fill("12.34");
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(page.getByText("Product saved.", { exact: true })).toBeVisible();
  expect(state.products[0]?.variants[0]?.price_minor).toBe(1234);
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByLabel("Stocked quantity for Default", { exact: true }).fill("28");
  await page.getByRole("button", { name: "Save stock", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Updated tomatoes" }).getByRole("cell", { name: "28", exact: true })).toHaveCount(2);
  expect(state.products[0]?.variants[0]?.stocked_quantity).toBe(28);
});

test("inventory preserves reserved quantity and displays derived available quantity", async ({ page }) => {
  await mock(page, "OWNER");
  await page.goto(base + "/merchant/inventory");
  await page.getByLabel("Stocked quantity for Default", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save stock", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "Fixture tomatoes" });
  await expect(row.getByRole("cell", { name: "20", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "18", exact: true })).toBeVisible();
});

test("picker has read-only catalogue and inventory", async ({ page }) => {
  const state = await mock(page, "PICKER");
  await page.goto(base + "/merchant/products");
  await expect(page.getByRole("link", { name: "Fixture tomatoes", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create product", exact: true })).toHaveCount(0);
  await transition(page, {
    url: base + "/merchant/products/prod_fixture",
    responses: [{ path: "/merchant/products/prod_fixture", method: "GET" }],
  }, () => page.getByRole("link", { name: "Fixture tomatoes", exact: true }).click());
  await expect(page).toHaveURL(base + "/merchant/products/prod_fixture");
  await expect(page.getByLabel("Product title", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save product", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Upload product image", { exact: true })).toHaveCount(0);
  await transition(page, {
    url: base + "/merchant/inventory",
    responses: [{ path: "/merchant/inventory", method: "GET" }],
  }, () => page.getByRole("link", { name: "Inventory", exact: true }).click());
  await expect(page).toHaveURL(base + "/merchant/inventory");
  await expect(page.getByRole("cell", { name: "TOMATO", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save stock", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("catalogue upload validates files and preserves server failure then recovery", async ({ page }) => {
  const state = await mock(page);
  await page.goto(base + "/merchant/products/prod_fixture");
  const upload = page.getByLabel("Upload product image", { exact: true });
  await upload.setInputFiles({ name: "bad.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("Use JPEG, PNG or WebP");
  expect(state.writes).toEqual([]);
  state.uploadFails = true;
  await upload.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken") });
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("Check the product");
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
  state.uploadFails = false;
  await upload.setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Image uploaded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove image", exact: true })).toHaveCount(0);
  expect(state.products[0]?.images).toEqual([]);
});

test("repeating the same product search does not strand loading state", async ({ page }) => {
  await mock(page);
  await page.goto(base + "/merchant/products");
  await page.getByLabel("Search products", { exact: true }).fill("tomatoes");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("link", { name: "Fixture tomatoes", exact: true })).toBeVisible();
  }
});
