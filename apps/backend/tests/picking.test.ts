import assert from "node:assert/strict";
import { test } from "node:test";
import { pickingCommand, pickingFingerprint, pickingListInput, validatePicked } from "../src/modules/marketplace/picking-policy";
import { requireCapability } from "../src/modules/marketplace/team-policy";

test("picking capability is distinct from acceptance and reassignment", () => {
  for (const role of ["OWNER", "MANAGER", "PICKER"] as const) {
    requireCapability(role, "MERCHANT_PICKING_VIEW"); requireCapability(role, "MERCHANT_PICKING_PERFORM");
  }
  for (const role of ["OWNER", "MANAGER"] as const) requireCapability(role, "MERCHANT_PICKING_REASSIGN");
  for (const capability of ["MERCHANT_ORDER_VIEW", "MERCHANT_ORDER_DECIDE", "MERCHANT_PICKING_REASSIGN"] as const) {
    assert.throws(() => requireCapability("PICKER", capability));
  }
});
test("picking rejects coercion, unsafe quantities and authority mass assignment", () => {
  const input = { expected_revision: 1, picked_quantity: 1, shortage_recorded: false };
  for (const picked_quantity of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    assert.throws(() => pickingCommand("LINE", { ...input, picked_quantity }, "ordli_test"));
  }
  for (const key of ["merchant_id", "store_id", "assigned_member_id", "status", "quantity", "variant_id", "price", "completed_at"]) {
    assert.throws(() => pickingCommand("LINE", { ...input, [key]: "forged" }, "ordli_test"));
    assert.throws(() => pickingCommand("CLAIM", { [key]: "forged" }));
  }
  assert.throws(() => pickingCommand("COMPLETE", { expected_revision: 1, confirmed: false }));
  assert.throws(() => pickingCommand("REASSIGN", { expected_revision: 1, target_member_id: "bad!" }));
  assert.throws(() => validatePicked(1, 2, false));
  assert.throws(() => validatePicked(1, 1, true));
  validatePicked(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false);
  validatePicked(2, 0, true); validatePicked(2, 1, true); validatePicked(2, 2, false);
});
test("native line fingerprint rejects replacement/quantity changes without depending on retrieval order", () => {
  const lines = [{ id: "a", variant_id: "v1", quantity: 1 }, { id: "b", variant_id: "v2", quantity: 2 }];
  assert.equal(pickingFingerprint(lines), pickingFingerprint([...lines].reverse()));
  for (const changed of [[{ id: "a", variant_id: "v3", quantity: 1 }, lines[1]!],
    [{ id: "a", variant_id: "v1", quantity: 2 }, lines[1]!], [lines[0]!]]) {
    assert.notEqual(pickingFingerprint(lines), pickingFingerprint(changed));
  }
  assert.throws(() => pickingFingerprint([]));
  assert.throws(() => pickingFingerprint([lines[0]!, lines[0]!]));
});
test("picking queue is bounded and cannot accept tenant or expansion authority", () => {
  assert.deepEqual(pickingListInput.parse({}), { limit: 20, offset: 0 });
  for (const input of [{ limit: 101 }, { offset: 10001 }, { status: "REJECTED" }, { merchant_id: "foreign" }, { fields: "*" }]) {
    assert.equal(pickingListInput.safeParse(input).success, false);
  }
});
