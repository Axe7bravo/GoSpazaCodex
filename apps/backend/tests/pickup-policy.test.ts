import assert from "node:assert/strict";
import { test } from "node:test";
import { physicalManifest, pickupCommand, pickupComponentSignature, pickupFingerprint } from "../src/modules/marketplace/pickup-policy";

test("fulfillment readback tolerates JSONB key order but rejects changed component evidence", () => {
  const original = [{ line_item_id: "line", inventory_item_id: "inventory", quantity: 3 },
    { line_item_id: "other", inventory_item_id: null, quantity: 1 }];
  const persisted = [{ quantity: 1, inventory_item_id: null, line_item_id: "other" },
    { quantity: 3, inventory_item_id: "inventory", line_item_id: "line" }];
  assert.equal(pickupComponentSignature(original), pickupComponentSignature(persisted));
  for (const changed of [
    [{ ...original[0]!, quantity: 5 }, original[1]!],
    [{ ...original[0]!, inventory_item_id: "foreign" }, original[1]!],
    [{ ...original[0]!, line_item_id: "foreign" }, original[1]!],
    [original[0]!], [...original, original[0]!],
  ]) assert.notEqual(pickupComponentSignature(original), pickupComponentSignature(changed));
});

test("native manifest contains physical original quantities, never terminal omissions", () => {
  assert.deepEqual(physicalManifest([
    { id: "line_b", ordered: 5, picked: 3, omitted: 2 },
    { id: "line_a", ordered: 2, picked: 0, omitted: 2 },
  ]), [{ id: "line_b", quantity: 3 }]);
  assert.deepEqual(physicalManifest([{ id: "line_a", ordered: 2, picked: 0, omitted: 2 }]), []);
  for (const line of [
    { id: "a", ordered: 5, picked: 3, omitted: 1 },
    { id: "a", ordered: 5, picked: 6, omitted: 0 },
    { id: "a", ordered: 5, picked: 1.5, omitted: 3.5 },
    { id: "a", ordered: 0, picked: 0, omitted: 0 },
  ]) assert.throws(() => physicalManifest([line]));
  assert.throws(() => physicalManifest([]));
  const line = { id: "a", ordered: 1, picked: 1, omitted: 0 };
  assert.throws(() => physicalManifest([line, line]));
});

test("pickup accepts only an explicit revision; all authority is server resolved", () => {
  assert.equal(pickupCommand.safeParse({ expected_revision: 4 }).success, true);
  for (const key of ["driver_id", "merchant_id", "store_id", "order_id", "fulfillment_id", "items", "quantity", "status", "picked_up_at"])
    assert.equal(pickupCommand.safeParse({ expected_revision: 4, [key]: "forged" }).success, false);
  for (const expected_revision of [null, "4", 0, -1, 1.5]) assert.equal(pickupCommand.safeParse({ expected_revision }).success, false);
});

test("manifest fingerprints are independent of source ordering and sensitive to physical quantity", () => {
  const a = { id: "a", ordered: 2, picked: 1, omitted: 1 }, b = { id: "b", ordered: 1, picked: 1, omitted: 0 };
  assert.equal(pickupFingerprint(physicalManifest([a,b])), pickupFingerprint(physicalManifest([b,a])));
  assert.notEqual(pickupFingerprint(physicalManifest([a,b])), pickupFingerprint(physicalManifest([{ ...a, picked: 2, omitted: 0 },b])));
});
