import assert from "node:assert/strict";
import { test } from "node:test";
import { BigNumber } from "@medusajs/framework/utils";
import { checkoutAddress, checkoutConfirmInput, checkoutPrepareInput, checkoutRevision,
  checkoutSnapshot } from "../src/modules/marketplace/checkout-policy";
import { checkoutMoney } from "../src/lib/checkout-native";

const address = { first_name: "Test", last_name: "Customer", address_1: "1 Test Street", address_2: "",
  city: "Bloemfontein", province: "FS", postal_code: "9301", country_code: "za", phone: "" };
const snapshot = checkoutSnapshot.parse({
  customer_id: "cus_test", cart_id: "cart_test", cart_context_id: "cctx_test",
  merchant_id: "mer_test", merchant_store_id: "mstore_test", address_id: "cuaddr_test", address,
  reservation_id: "dhold_test", reservation_revision: 1, configuration_revision: 1,
  delivery_option_id: "dopt_test", shipping_option_id: "so_test", shipping_method_id: "casm_test",
  currency_code: "zar", totals: { total_minor: 10999, subtotal_minor: 10999,
    tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 1000 },
  items: [{ id: "cali_test", variant_id: "variant_test", quantity: 1, unit_price_minor: 9999, total_minor: 9999 }],
});

test("checkout revision changes with native commercial or address/selection state", () => {
  const original = checkoutRevision(snapshot);
  assert.equal(checkoutRevision(checkoutSnapshot.parse(JSON.parse(JSON.stringify(snapshot)))), original);
  for (const changed of [
    { ...snapshot, totals: { ...snapshot.totals, total_minor: 11000 } },
    { ...snapshot, address: { ...snapshot.address, address_1: "2 Test Street" } },
    { ...snapshot, reservation_revision: 2 },
    { ...snapshot, configuration_revision: 2 },
    { ...snapshot, shipping_method_id: "casm_changed" },
    { ...snapshot, items: [{ ...snapshot.items[0], quantity: 2 }] },
  ]) assert.notEqual(checkoutRevision(checkoutSnapshot.parse(changed)), original);
});

test("checkout inputs reject browser commercial authority and require explicit confirmation", () => {
  const input = { cart_id: "cart_test", address_id: "cuaddr_test", expected_reservation_revision: 1 };
  assert.equal(checkoutPrepareInput.safeParse(input).success, true);
  for (const field of ["merchant_id", "store_id", "customer_id", "zone_id", "sales_channel_id", "context_id",
    "reservation_id", "shipping_option_id", "payment_collection_id", "payment_session_id", "total", "fee_minor", "currency_code"]) {
    assert.equal(checkoutPrepareInput.safeParse({ ...input, [field]: "forged" }).success, false);
  }
  assert.equal(checkoutConfirmInput.safeParse({ ...input, checkout_revision: checkoutRevision(snapshot) }).success, false);
  assert.equal(checkoutConfirmInput.safeParse({ ...input, confirmed: true, checkout_revision: checkoutRevision(snapshot) }).success, true);
  assert.equal(checkoutPrepareInput.safeParse({ ...input, expected_reservation_revision: 0 }).success, false);
});

test("checkout completeness reuses M6 required address fields", () => {
  assert.equal(checkoutAddress.safeParse(address).success, true);
  for (const field of ["first_name", "last_name", "address_1", "city", "province", "postal_code", "country_code"]) {
    assert.equal(checkoutAddress.safeParse({ ...address, [field]: "" }).success, false);
  }
});

test("checkout money uses exact existing native conversion, never missing-data zero", () => {
  for (const value of ["109.99", 109.99, new BigNumber("109.99")]) assert.equal(checkoutMoney(value), 10999);
  for (const value of [undefined, null, {}, "1.001", -1, Infinity]) assert.throws(() => checkoutMoney(value));
  assert.equal(checkoutMoney(new BigNumber("0")), 0);
});
