import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyYocoInboxEvent } from "../src/modules/yoco/webhook";
import { completionDisposition, completionObservation } from "../src/lib/completion-native";
import { reconciliationWorkerEnabled } from "../src/lib/yoco-config";

const secret = Buffer.alloc(32, 4);
function signed(body: unknown, seconds = Math.floor(Date.now() / 1000)) {
  const rawData = JSON.stringify(body);
  return { data: { forged: true }, rawData, headers: {
    "webhook-id": "delivery_fixture", "webhook-timestamp": String(seconds),
    "webhook-signature": "v1," + createHmac("sha256", secret).update("delivery_fixture." + seconds + "." + rawData).digest("base64"),
  } };
}
const refund = { id: "event_refund", type: "refund.succeeded", payload: {
  type: "refund", status: "succeeded", amount: 12345, currency: "ZAR", mode: "test", metadata: { checkoutId: "checkout_fixture" },
} };
test("refund evidence uses verified bytes, exact currency/amount and bounded timestamp", () => {
  const key = "whsec_" + secret.toString("base64");
  const result = verifyYocoInboxEvent(signed(refund), key);
  assert.deepEqual(result, { id: "event_refund", type: "refund.succeeded", checkoutId: "checkout_fixture", amount: 12345, currency: "ZAR", mode: "test" });
  assert.throws(() => verifyYocoInboxEvent({ ...signed(refund), rawData: "{}" }, key));
  assert.throws(() => verifyYocoInboxEvent(signed(refund, Math.floor(Date.now() / 1000) - 181), key));
  assert.throws(() => verifyYocoInboxEvent(signed({ ...refund, payload: { ...refund.payload, currency: "USD" } }), key));
  assert.throws(() => verifyYocoInboxEvent(signed({ ...refund, payload: { ...refund.payload, amount: 12.345 } }), key));
  assert.throws(() => verifyYocoInboxEvent(signed({ ...refund, type: "refund.failed" }), key));
});
test("native readback binds the exact transaction, execution and run; lifecycle is evidence only", () => {
  const identity = { workflow_id: "complete-cart", transaction_id: "tx_fixture", execution_id: "wf_exec_fixture", run_id: "run_fixture" };
  for (const state of ["done", "invoking", "waiting_to_compensate", "compensating", "reverted", "failed"]) {
    const native = { id: identity.execution_id, workflow_id: identity.workflow_id, transaction_id: identity.transaction_id,
      state, execution: { runId: identity.run_id, steps: { "create-orders": { invoke: { state: "invoking", status: "waiting_response" } } } } };
    const observed = completionObservation(native, identity);
    assert.equal(observed?.state, state);
    assert.equal(completionDisposition(state), state === "done" ? "VALIDATE_NATIVE_ORDER" : "RECOVERY_REQUIRED");
    assert.deepEqual(observed?.unresolved, [{ id: "create-orders", action: "invoke", state: "invoking", status: "waiting_response" }]);
    assert.equal(completionObservation({ ...native, transaction_id: "another" }, identity), null);
    assert.equal(completionObservation({ ...native, execution: { ...native.execution, runId: "another" } }, identity), null);
    assert.equal(completionObservation({ ...native, id: "another" }, identity), null);
  }
  assert.equal(completionObservation(null, identity), null);
  assert.equal(completionDisposition(null), "RECOVERY_REQUIRED");
});
test("production cannot disable the payment reconciliation worker", () => {
  assert.equal(reconciliationWorkerEnabled({ APP_ENV: "production" }), true);
  assert.throws(() => reconciliationWorkerEnabled({ APP_ENV: "production", PAYMENT_RECONCILIATION_WORKER_ENABLED: "false" }));
  assert.equal(reconciliationWorkerEnabled({ APP_ENV: "test", PAYMENT_RECONCILIATION_WORKER_ENABLED: "false" }), false);
});
