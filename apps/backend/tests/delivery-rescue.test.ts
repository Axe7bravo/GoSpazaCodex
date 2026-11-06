import assert from "node:assert/strict";
import test from "node:test";
import { nextRescueGeneration, rescueInput } from "../src/modules/marketplace/delivery-rescue-policy";
import { rescuePrecheck } from "../src/modules/marketplace/operations-policy";
import { platformGranted } from "../src/modules/marketplace/platform-capabilities";
const command = { request_id: "request_a", expected_revision: 4, expected_generation: 1, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true };
test("M23-C bounded rescue input rejects forced fields and requires explicit confirmation", () => {
  assert.equal(rescueInput.safeParse(command).success, true);
  for (const patch of [{ confirmed: false }, { expected_generation: 0 }, { expected_revision: 0 }, { reason_code: "FORCE" }, { driver_id: "driver_foreign" }, { generation: 2 }, { mode: "PLATFORM_ONLY" }])
    assert.equal(rescueInput.safeParse({ ...command, ...patch }).success, false);
  assert.equal(nextRescueGeneration(1, 1), 2); assert.equal(nextRescueGeneration(2, 2), 3);
  assert.throws(() => nextRescueGeneration(1, 2)); assert.throws(() => nextRescueGeneration(2147483647, 2147483647));
});
test("M23-C persisted safety and current rescue authority are independent", () => {
  const facts = { status: "ATTENTION_REQUIRED", generation: 1, reason: "POOL_EXHAUSTED", pickup_managed: false, native_fulfillment_id: null,
    picked_up_at: null, arrived_at: null, delivered_at: null, tracking_generation: null, handoff_failures: 0,
    active: false, assigned: false, history_invalid: false, native_operations: false, custody: false, snapshot: false, binding_proven: true };
  for (const reason of ["POOL_EXHAUSTED", "SEARCH_ENDED", "SEARCH_UNAVAILABLE"]) assert.equal(rescuePrecheck({ ...facts, reason }).eligible, true);
  for (const patch of [{ reason: "ASSIGNMENT_REVIEW" }, { active: true }, { assigned: true }, { custody: true }, { native_operations: true }, { history_invalid: true }, { status: "DELIVERED" }, { status: "RETURNED_TO_STORE" }])
    assert.equal(rescuePrecheck({ ...facts, ...patch }).eligible, false);
  const env = { DELIVERY_RESCUE_USER_IDS: "operator" };
  assert.equal(platformGranted("operator", "DELIVERY_RESCUE", env), true); assert.equal(platformGranted("operator", "DELIVERY_OPERATIONS_VIEW", env), false);
});
