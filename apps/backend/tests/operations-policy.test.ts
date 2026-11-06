import assert from "node:assert/strict";
import test from "node:test";
import { legacyCapabilities, platformCapabilities, platformGranted } from "../src/modules/marketplace/platform-capabilities";
import { lookupInput, operationsCursor, operationsLink, operationsPage, readOperationsCursor, rescuePrecheck, safeOperationReason, sourceAllowed,
  type RescueFacts } from "../src/modules/marketplace/operations-policy";
const facts: RescueFacts = { status: "ATTENTION_REQUIRED", generation: 1, reason: "POOL_EXHAUSTED", pickup_managed: false, native_fulfillment_id: null,
  picked_up_at: null, arrived_at: null, delivered_at: null, tracking_generation: null, handoff_failures: 0, active: false, assigned: false,
  history_invalid: false, native_operations: false, custody: false, snapshot: false, binding_proven: true };
test("M23-B platform grants are explicit, independent and current", () => {
  const env = { ORDER_OPERATIONS_VIEW_USER_IDS: "one", FINANCIAL_VIEW_USER_IDS: "finance", NOTIFICATION_OPERATIONS_VIEW_USER_IDS: "notice" };
  assert.equal(sourceAllowed("one", "orders", env), true); assert.equal(sourceAllowed("one", "deliveries", env), false);
  assert.equal(platformGranted("one", "DELIVERY_RESCUE", env), false);
  for (const id of ["ordinary", "finance", "notice"]) assert.equal(sourceAllowed(id, "orders", env), false);
  env.ORDER_OPERATIONS_VIEW_USER_IDS = ""; assert.equal(sourceAllowed("one", "orders", env), false);
  assert.equal(platformCapabilities.includes("DELIVERY_RESCUE"), true);
  assert.deepEqual(legacyCapabilities.merchantDocument, ["MERCHANT_REVIEW_VIEW", "MERCHANT_DOCUMENT_VIEW"]);
  assert.deepEqual(legacyCapabilities.driverWrite, ["DRIVER_REVIEW_VIEW", "DRIVER_REVIEW_MANAGE"]);
  assert.deepEqual(legacyCapabilities.configurationWrite, ["SERVICE_CONFIGURATION_VIEW", "SERVICE_CONFIGURATION_MANAGE"]);
});
test("M23-B lookup, independent cursors and pages reject arbitrary selectors", () => {
  assert.equal(operationsPage.parse({}).limit, 20);
  for (const input of [{ limit: 26 }, { limit: 0 }, { offset: 1 }]) assert.equal(operationsPage.safeParse(input).success, false);
  for (const type of ["EMAIL", "CUSTOMER", "PROVIDER_REFERENCE"]) assert.equal(lookupInput.safeParse({ type, id: "known" }).success, false);
  assert.equal(lookupInput.safeParse({ type: "ORDER", id: "order_a", customer_id: "forged" }).success, false);
  const cursor = operationsCursor("attention:orders", "order_a"); assert.equal(readOperationsCursor("attention:orders", cursor), "order_a");
  assert.throws(() => readOperationsCursor("attention:deliveries", cursor)); assert.throws(() => readOperationsCursor("attention:orders", "bad!!!!"));
  assert.equal(operationsLink("ORDER", "order_a"), "/admin/orders/order_a"); assert.equal(operationsLink("MERCHANT", "merchant_a"), null);
  assert.throws(() => operationsLink("ORDER", "//outside.example"));
});
test("M23-B rescue precheck is pure, narrow and explicitly not mutation admission", () => {
  const before = JSON.stringify(facts), valid = rescuePrecheck(facts);
  assert.equal(valid.eligible, true); assert.equal(valid.requires_admission_revalidation, true); assert.equal(valid.scope, "PERSISTED_PRECHECK");
  for (const patch of [{ status: "DELIVERED" }, { status: "RETURNED_TO_STORE" }, { active: true }, { assigned: true }, { history_invalid: true },
    { native_operations: true }, { custody: true }, { snapshot: true }, { binding_proven: false }, { generation: 0 }, { reason: "ASSIGNMENT_REVIEW" }, { picked_up_at: "time" }, { pickup_managed: true }])
    assert.equal(rescuePrecheck({ ...facts, ...patch }).eligible, false);
  assert.equal(JSON.stringify(facts), before); assert.equal(safeOperationReason("school_uniform"), null);
  assert.equal(safeOperationReason("raw private provider text"), null); assert.equal(safeOperationReason("POOL_EXHAUSTED"), "POOL_EXHAUSTED");
});
