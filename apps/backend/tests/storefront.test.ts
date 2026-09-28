import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceMode, discoveryInput, publicStore } from "../src/lib/discovery-service";
import { storefrontProduct } from "../src/lib/storefront-product";
import type { NativeProduct, catalogueReadData } from "../src/lib/catalogue-native";
import type { CommerceReference } from "../src/lib/commerce";
import { PUBLIC_PREFIX } from "../src/modules/routed-file/storage";

const store: CommerceReference = { id: "mstore_fixture", merchant_id: "merchant_secret", name: "Neighbourhood",
  medusa_sales_channel_id: "sc_secret", medusa_stock_location_id: "sl_secret" };
const product: NativeProduct = {
  id: "prod_fixture", title: "Produce", description: "Fresh", status: "published",
  images: [{ id: "public", url: "https://media.example.test/produce.png" }, { id: "private", url: "https://private.example.test/document" }],
  variants: [
    { id: "v1", title: "500g", sku: "internal", prices: [{ amount: "10.99", currency_code: "zar", price_list_id: null, min_quantity: null, max_quantity: null }],
      inventory_items: [{ inventory_item_id: "i1", required_quantity: 1 }] },
    { id: "v2", title: "1kg", sku: "internal2", prices: [{ amount: "20.99", currency_code: "zar", price_list_id: null, min_quantity: null, max_quantity: null }],
      inventory_items: [{ inventory_item_id: "i2", required_quantity: 1 }] },
  ],
};
const data: Awaited<ReturnType<typeof catalogueReadData>> = {
  levels: ["i1", "i2"].map((id, index) => ({
    id: "level" + id, inventory_item_id: id, location_id: "sl_secret",
    stocked_quantity: index ? 0 : 5, reserved_quantity: 1, available_quantity: index ? -1 : 4,
    incoming_quantity: 0, metadata: null, created_at: new Date(), updated_at: new Date(), deleted_at: null,
  })),
  media: [
    { medusa_product_id: product.id, public_url: product.images[0]!.url, file_key: PUBLIC_PREFIX + "image" },
    { medusa_product_id: product.id, public_url: product.images[1]!.url, file_key: "legacy-private" },
  ],
};
test("mode derives only from eligible count", () => {
  assert.deepEqual([0, 1, 2, 100].map(marketplaceMode), ["none", "single", "multiple", "multiple"]);
});
test("public DTO contains native prices, safe availability and only tracked public images", () => {
  const result = storefrontProduct(product, store, true, data)!;
  assert.deepEqual(result.store, { id: store.id, name: store.name, availability: "available" });
  assert.deepEqual(publicStore(store), result.store);
  assert.deepEqual(result.images, [product.images[0]]);
  assert.equal(result.min_price_minor, 1099);
  assert.equal(result.max_price_minor, 2099);
  assert.equal(result.variants[1]!.availability, "out_of_stock");
  assert.equal(result.requires_age_verification, true);
  const json = JSON.stringify(result);
  for (const secret of ["merchant_secret", "sc_secret", "sl_secret", "reserved_quantity", "stocked_quantity", "inventory_item_id", "legacy-private", "private.example", "sku"]) {
    assert.equal(json.includes(secret), false, secret);
  }
});
test("draft, no inventory and unsupported prices cannot create a public product", () => {
  assert.equal(storefrontProduct({ ...product, status: "draft" }, store, false, data), null);
  assert.equal(storefrontProduct(product, store, false, { ...data, levels: [] }), null);
  const invalid = { ...product, variants: product.variants.map((variant) => ({ ...variant, prices: [] })) };
  assert.equal(storefrontProduct(invalid, store, false, data), null);
  const removed = { ...data, media: [] };
  assert.deepEqual(storefrontProduct(product, store, false, removed)!.images, []);
});
test("location input cannot substitute zone, merchant, or native topology IDs", () => {
  assert.equal(discoveryInput.safeParse({ latitude: -29, longitude: 26 }).success, true);
  assert.equal(discoveryInput.safeParse({ address_id: "cuaddr_fixture" }).success, true);
  for (const value of [
    {}, { latitude: "", longitude: "" }, { address_id: "cuaddr_fixture", latitude: -29, longitude: 26 },
    { latitude: -29, longitude: 26, zone_id: "zone" },
    { latitude: -29, longitude: 26, merchant_id: "merchant" },
  ]) assert.equal(discoveryInput.safeParse(value).success, false);
});
