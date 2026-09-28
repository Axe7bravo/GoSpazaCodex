import { productDTO } from "../src/lib/catalogue-native";
import type { NativeProduct } from "../src/lib/catalogue-native";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogueParse, productInput, stockInput, nativePrice, minorPrice, validateCatalogueImage } from "../src/modules/marketplace/catalogue-policy";
import { requireCapability } from "../src/modules/marketplace/team-policy";

const product = {
  title: "Tomatoes", description: "", status: "draft", requires_age_verification: false,
  variants: ["500g", "1kg", "2kg"].map((title) => ({ title, sku: "", price_minor: 10999, stocked_quantity: 12 })),
};
test("catalogue accepts fixed variants and exact integer-cent/native price conversion", () => {
  assert.equal(catalogueParse(productInput, product).variants.length, 3);
  for (const cents of [0, 1, 100, 10999, 1000000000]) assert.equal(minorPrice(nativePrice(cents)), cents);
  assert.equal(nativePrice(10999), "109.99");
  for (const amount of [-1, 1.1, NaN, Infinity]) assert.throws(() => nativePrice(amount));
  for (const amount of ["1.001", "-1", "Infinity"]) assert.throws(() => minorPrice(amount));
});
test("catalogue rejects authority, price, reservation and storage injection", () => {
  for (const key of ["merchant_id", "sales_channel_id", "stock_location_id", "images", "thumbnail", "file_key"]) {
    assert.throws(() => catalogueParse(productInput, { ...product, [key]: "private-secret" }));
  }
  for (const quantity of [-1, 0.5, "2", NaN, 1000001]) assert.throws(() => catalogueParse(stockInput, { stocked_quantity: quantity }));
  for (const key of ["reserved_quantity", "available_quantity", "location_id"]) assert.throws(() => catalogueParse(stockInput, { stocked_quantity: 1, [key]: 1 }));
  assert.throws(() => catalogueParse(productInput, { ...product, variants: [product.variants[0], product.variants[0]] }));
  assert.throws(() => catalogueParse(productInput, { ...product, variants: [{ ...product.variants[0], price_minor: 10.99 }] }));
});
test("catalogue capabilities preserve picker read-only access", () => {
  for (const role of ["OWNER", "MANAGER", "PICKER"] as const) {
    for (const capability of ["MERCHANT_CATALOG_VIEW", "MERCHANT_INVENTORY_VIEW"] as const) assert.doesNotThrow(() => requireCapability(role, capability));
    for (const capability of ["MERCHANT_CATALOG_MANAGE", "MERCHANT_INVENTORY_MANAGE"] as const) {
      if (role === "PICKER") assert.throws(() => requireCapability(role, capability));
      else assert.doesNotThrow(() => requireCapability(role, capability));
    }
  }
});
test("media validates JPEG/PNG/WebP bytes, size, signatures and fixed access class", () => {
  const webp = Buffer.alloc(20);
  webp.write("RIFF"); webp.writeUInt32LE(12, 4); webp.write("WEBP", 8); webp.write("VP8 ", 12);
  const samples = [
    { mime_type: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") },
    { mime_type: "image/jpeg", bytes: Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]) },
    { mime_type: "image/webp", bytes: webp },
  ];
  for (const sample of samples) {
    const input = { mime_type: sample.mime_type, content: sample.bytes.toString("base64") };
    assert.deepEqual(validateCatalogueImage(input).bytes, sample.bytes);
    assert.throws(() => validateCatalogueImage({ ...input, content: Buffer.from("not an image").toString("base64") }));
    for (const key of ["access", "bucket", "provider", "storage_key", "url"]) assert.throws(() => validateCatalogueImage({ ...input, [key]: "private" }));
  }
  assert.throws(() => validateCatalogueImage({ mime_type: "application/pdf", content: Buffer.from("%PDF").toString("base64") }));
  assert.throws(() => validateCatalogueImage({ mime_type: "image/png", content: samples[1]!.bytes.toString("base64") }));
  assert.throws(() => validateCatalogueImage({ mime_type: "image/png", content: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }));
});

test("catalogue DTO excludes private and untracked native image URLs", async () => {
  const product: NativeProduct = {
    id: "prod_fixture", title: "Fixture", description: "", status: "draft",
    images: [{ id: "public", url: "https://media.example.test/public.png" }, { id: "private", url: "https://private.example.test/document.png" }, { id: "untracked", url: "https://unknown.example.test/image.png" }],
    variants: [{ id: "variant_fixture", title: "Default", sku: null,
      prices: [{ amount: "10.99", currency_code: "zar", price_list_id: null, min_quantity: null, max_quantity: null }],
      inventory_items: [{ inventory_item_id: "iitem_fixture", required_quantity: 1 }] }],
  };
  // Prejoined media/profile rows; model the filtering and projection used by Knex.
  let rows = [
    { public_url: product.images[0]!.url, file_key: "gospaza-public-v1/fixture.png" },
    { public_url: product.images[1]!.url, file_key: "merchant-applications/legacy.png" },
  ].map((row) => ({
    "product_marketplace_profile.medusa_product_id": product.id,
    "catalogue_media.public_url": row.public_url,
    "catalogue_media.file_key": row.file_key,
    "catalogue_media.removal_pending": false,
    "catalogue_media.deleted_at": null,
    "product_marketplace_profile.deleted_at": null,
  }));
  type Column = keyof (typeof rows)[number];
  const query = {
    join(table: string, left: string, right: string) {
      assert.deepEqual([table, left, right], ["product_marketplace_profile", "catalogue_media.profile_id", "product_marketplace_profile.id"]);
      return this;
    },
    whereIn(column: Column, values: string[]) {
      rows = rows.filter((row) => typeof row[column] === "string" && values.some((value) => value === row[column]));
      return this;
    },
    where(filters: Partial<Record<Column, string | boolean | null>>) {
      rows = rows.filter((row) => Object.entries(filters).every(([filter, expected]) =>
        Object.entries(row).some(([column, value]) => column === filter && value === expected)));
      return this;
    },
    whereNull(column: Column) {
      rows = rows.filter((row) => row[column] === null);
      return this;
    },
    select: async (...columns: Column[]) => rows.map((row) => Object.fromEntries(
      columns.map((column) => [column.split(".").at(-1)!, row[column]]),
    )),
  };
  const container = { resolve: (key: string) => {
    if (key === ContainerRegistrationKeys.PG_CONNECTION) return () => query;
    if (key === Modules.INVENTORY) return { listInventoryLevels: async () => [{ inventory_item_id: "iitem_fixture", stocked_quantity: 12, reserved_quantity: 2, available_quantity: 10 }] };
    throw new Error("Unexpected fixture resolution");
  } } as unknown as MedusaContainer;
  const dto = await productDTO(container, product, "sloc_fixture", false);
  assert.deepEqual(dto.images, [product.images[0]]);
  assert.equal(dto.variants[0]!.price_minor, 1099);
  assert.equal(JSON.stringify(dto).includes("merchant-applications"), false);
  assert.equal(JSON.stringify(dto).includes("private.example"), false);
});
