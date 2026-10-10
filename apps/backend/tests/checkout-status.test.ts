import assert from "node:assert/strict";
import { test } from "node:test";
import { customerCheckoutOutcome } from "../src/lib/checkout-status-service";

test("customer outcomes require the accepted terminal receipt, not Order existence or native completion alone", () => {
  const attempt = { state: "COMPLETED" as const, closed_at: new Date(), payment_accepted_at: new Date() };
  assert.equal(customerCheckoutOutcome(attempt), "recovery_required");
  const receipt = { state: "SUCCEEDED" as const, order_id: "order_test", terminal_receipt: { order_id: "order_test" }, dispatched_at: new Date() };
  assert.equal(customerCheckoutOutcome(attempt, undefined, receipt), "succeeded");
  assert.equal(customerCheckoutOutcome({ ...attempt, state: "RECOVERY_REQUIRED" }, undefined, receipt), "recovery_required");
});
test("unknown provider state is not presented as confirmed pending; expired capture is never an Order", () => {
  const attempt = { state: "PAYMENT_PENDING" as const, closed_at: null, payment_accepted_at: null };
  for (const state of ["sending", "uncertain", "mismatch"] as const) {
    assert.equal(customerCheckoutOutcome(attempt, { state, terminal_refunded: false, verified_payment: null }), "reconciliation_pending");
  }
  assert.equal(customerCheckoutOutcome(attempt, { state: "created", terminal_refunded: false, verified_payment: null }), "awaiting_payment");
  const captured = { state: "created" as const, terminal_refunded: false, verified_payment: {
    id: "event_test", type: "payment.succeeded", operationId: "op_test", checkoutId: "checkout_test", paymentId: "payment_test",
    amount: 3500, currency: "ZAR", mode: "test",
  } };
  assert.equal(customerCheckoutOutcome({ ...attempt, state: "EXPIRED", closed_at: new Date() }, captured), "refund_pending");
  assert.equal(customerCheckoutOutcome({ ...attempt, state: "EXPIRED", closed_at: new Date() }, { ...captured, terminal_refunded: true }), "refunded");
  assert.equal(customerCheckoutOutcome({ ...attempt, state: "RECOVERY_REQUIRED" }, { ...captured, terminal_refunded: true }), "recovery_required");
});