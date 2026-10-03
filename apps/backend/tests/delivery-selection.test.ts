import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverySelectionInput, deliveryReleaseInput, deliveryLocationInput } from "../src/modules/marketplace/delivery-selection-policy";

const choice = { cart_id: "cart_fixture", location: { latitude: -29, longitude: 26 },
  option_id: "doption_fixture", slot_id: "dslot_fixture", expected_revision: 0, expected_option_revision: 1 };

test("delivery selections require both selection and advertised option revisions", () => {
  assert.equal(deliverySelectionInput.safeParse(choice).success, true);
  for (const change of [{ expected_revision: -1 }, { expected_revision: 1.5 },
    { expected_option_revision: undefined }, { expected_option_revision: 0 }]) {
    assert.equal(deliverySelectionInput.safeParse({ ...choice, ...change }).success, false);
  }
});
test("delivery selection rejects browser authority and ambiguous location sources", () => {
  for (const field of ["merchant_id", "store_id", "customer_id", "context_id", "zone_id", "fee_minor", "sales_channel_id"]) {
    assert.equal(deliverySelectionInput.safeParse({ ...choice, [field]: "injected" }).success, false);
  }
  assert.equal(deliveryLocationInput.safeParse({ location: { address_id: "address", latitude: 0, longitude: 0 } }).success, false);
});
test("release accepts an owned-reference hint without location but rejects authority fields", () => {
  const release = { cart_id: "cart_fixture", reservation_id: "dhold_fixture", expected_revision: 1 };
  assert.equal(deliveryReleaseInput.safeParse(release).success, true);
  assert.equal(deliveryReleaseInput.safeParse({ ...release, location: choice.location }).success, false);
  assert.equal(deliveryReleaseInput.safeParse({ ...release, customer_id: "another" }).success, false);
});
