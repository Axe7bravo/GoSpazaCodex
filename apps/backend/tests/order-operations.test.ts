import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutSnapshot } from "../src/modules/marketplace/checkout-policy";
import { completedOrderHandoff, orderListInput } from "../src/modules/marketplace/order-operation-policy";
import { requireCapability } from "../src/modules/marketplace/team-policy";

const snapshot = checkoutSnapshot.parse({
  customer_id: "cus_test", cart_id: "cart_test", cart_context_id: "cctx_test",
  merchant_id: "mer_test", merchant_store_id: "mstore_test", address_id: "cuaddr_test",
  address: { first_name: "Test", last_name: "Customer", address_1: "1 Test Street", address_2: "",
    city: "Bloemfontein", province: "FS", postal_code: "9301", country_code: "za", phone: "" },
  reservation_id: "dhold_test", reservation_revision: 1, configuration_revision: 1,
  delivery_option_id: "dopt_test", shipping_option_id: "so_test", shipping_method_id: "casm_test",
  currency_code: "zar", totals: { total_minor: 10999, subtotal_minor: 9999,
    tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 1000 },
  items: [{ id: "cali_test", variant_id: "variant_test", quantity: 1, unit_price_minor: 9999, total_minor: 9999 }],
});
const handoff = {
  completion_id: "cpl_test", order_id: "order_test", cart_id: "cart_test", context_id: "cctx_test",
  merchant_id: "mer_test", merchant_store_id: "mstore_test", reservation_id: "dhold_test", slot_id: "slot_test",
  workflow_id: "complete-cart", transaction_id: "transaction_test", execution_id: "exec_test", run_id: "run_test",
  snapshot,
  terminal_receipt: {
    order_id: "order_test", cart_id: "cart_test", payment_id: "pay_test", capture_id: "cap_test",
    payment_collection_id: "paycol_test", amount_minor: 10999, currency: "zar",
    workflow_id: "complete-cart", transaction_id: "transaction_test", execution_id: "exec_test", run_id: "run_test",
    verified_at: "2026-10-10T12:00:00.000Z",
  },
};

test("M11 handoff binds the durable M10 receipt, snapshot, tenant and reservation", () => {
  assert.equal(completedOrderHandoff(handoff).order_id, "order_test");
  // No workflow engine/history lookup: retained terminal evidence suffices.
  for (const field of ["order_id", "cart_id", "context_id", "merchant_id", "merchant_store_id", "reservation_id",
    "workflow_id", "transaction_id", "execution_id", "run_id"]) {
    assert.throws(() => completedOrderHandoff({ ...handoff, [field]: "foreign" }), /unavailable/);
  }
  for (const terminal_receipt of [null, {}, { ...handoff.terminal_receipt, amount_minor: 1 },
    { ...handoff.terminal_receipt, currency: "usd" }, { ...handoff.terminal_receipt, capture_id: "" }]) {
    assert.throws(() => completedOrderHandoff({ ...handoff, terminal_receipt }), /unavailable/);
  }
  assert.throws(() => completedOrderHandoff({ ...handoff, snapshot: { ...snapshot, merchant_id: "foreign" } }), /unavailable/);
});

test("M11 list input bounds pagination and rejects tenant, identity and expansion injection", () => {
  assert.deepEqual(orderListInput.parse({}), { limit: 20, offset: 0 });
  assert.deepEqual(orderListInput.parse({ limit: "100", offset: "10", status: "PENDING_ACCEPTANCE" }),
    { limit: 100, offset: 10, status: "PENDING_ACCEPTANCE" });
  for (const field of ["merchant_id", "store_id", "merchant_store_id", "customer_id", "sales_channel_id",
    "checkout_completion_id", "order_id", "fields", "expand", "order", "q"]) {
    assert.equal(orderListInput.safeParse({ [field]: "hostile" }).success, false);
  }
  for (const value of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 },
    { offset: 10001 }, { status: "COMPLETED" }, { status: ["ACCEPTED", "REJECTED"] }]) {
    assert.equal(orderListInput.safeParse(value).success, false);
  }
});

test("M11 read uses reusable M4 capability enforcement, without picker access", () => {
  for (const role of ["OWNER", "MANAGER"] as const) assert.doesNotThrow(() => requireCapability(role, "MERCHANT_ORDER_VIEW"));
  assert.throws(() => requireCapability("PICKER", "MERCHANT_ORDER_VIEW"), /capability/);
});
