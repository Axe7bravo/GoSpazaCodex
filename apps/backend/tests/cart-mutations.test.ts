import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addCartInput, updateCartItemInput, removeCartItemInput, switchCartInput,
} from "../src/modules/marketplace/cart-mutation-policy";

const selection = { latitude: -29.1, longitude: 26.2 };
const add = { variant_id: "variant_fixture", quantity: 1, location: selection };

test("cart writes reject client commerce authority and custom prices", () => {
  assert.equal(addCartInput.safeParse(add).success, true);
  for (const field of ["merchant_id", "merchant_store_id", "sales_channel_id", "customer_id",
    "stock_location_id", "region_id", "context_id", "metadata", "unit_price"]) {
    assert.equal(addCartInput.safeParse({ ...add, [field]: "injected" }).success, false);
  }
  assert.equal(addCartInput.safeParse({ ...add, location: { stock_location_id: "sloc_fixture" } }).success, false);
  assert.equal(addCartInput.safeParse({ ...add, location: { ...selection, address_id: "cuaddr_fixture" } }).success, false);
});

test("cart quantities are positive safe integers; removal is explicit", () => {
  for (const quantity of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    assert.equal(addCartInput.safeParse({ ...add, quantity }).success, false);
    assert.equal(updateCartItemInput.safeParse({ cart_id: "cart_fixture", quantity }).success, false);
  }
  assert.equal(updateCartItemInput.safeParse({ cart_id: "cart_fixture", quantity: 1 }).success, true);
  assert.equal(removeCartItemInput.safeParse({ cart_id: "cart_fixture" }).success, true);
  assert.equal(removeCartItemInput.safeParse({ cart_id: "cart_fixture", merchant_id: "injected" }).success, false);
});

test("switch requires explicit confirmation, current cart and location selection", () => {
  const input = { ...add, cart_id: "cart_fixture", confirm: true };
  assert.equal(switchCartInput.safeParse(input).success, true);
  for (const confirm of [false, undefined, "true", 1]) {
    assert.equal(switchCartInput.safeParse({ ...input, confirm }).success, false);
  }
  assert.equal(switchCartInput.safeParse({ ...input, cart_id: undefined }).success, false);
  assert.equal(switchCartInput.safeParse({ ...input, location: undefined }).success, false);
});
