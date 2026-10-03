import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCartRegion, cartHintInput } from "../src/modules/marketplace/cart-policy";

test("cart region must explicitly support ZA and ZAR", () => {
  assert.doesNotThrow(() => assertCartRegion({ currency_code: "zar", countries: [{ iso_2: "za" }] }));
  for (const region of [null, undefined, { currency_code: "usd", countries: [{ iso_2: "za" }] },
    { currency_code: "zar", countries: [] }, { currency_code: "zar", countries: [{ iso_2: "gb" }] }]) {
    assert.throws(() => assertCartRegion(region));
  }
});
test("restoration accepts only an optional native cart reference", () => {
  assert.ok(cartHintInput.safeParse({}).success);
  assert.ok(cartHintInput.safeParse({ cart_id: "cart_fixture" }).success);
  for (const cart_id of ["", "../cart", "not-a-cart", ["cart_fixture"]]) {
    assert.equal(cartHintInput.safeParse({ cart_id }).success, false);
  }
  for (const key of ["merchant_id", "merchant_store_id", "customer_id", "sales_channel_id", "region_id", "metadata"]) {
    assert.equal(cartHintInput.safeParse({ [key]: "authority" }).success, false);
  }
});
