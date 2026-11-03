import test from "node:test";
import assert from "node:assert/strict";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { NativeRefundAccounting } from "../src/lib/refund-native";
import type { RefundRow, RefundAttemptRow } from "../src/modules/marketplace/refund-policy";
import { nativeRefundCorrelation } from "../src/lib/refund-metadata";

test("native refund correlation validates runtime metadata omitted by the pinned DTO", () => {
  const metadata = { gospazaRefundOperationId: "rfop_a", gospazaProviderRefundId: "rfd_a" };
  assert.deepEqual(nativeRefundCorrelation({ metadata }), metadata);
  for (const value of [{}, { metadata: null }, { metadata: {} },
    { metadata: { ...metadata, gospazaProviderRefundId: 123 } },
    { metadata: { ...metadata, gospazaRefundOperationId: "" } }]) assert.equal(nativeRefundCorrelation(value), null);
});

test("native accounting selects one exact refund, not every historical equal-value refund", async () => {
  const row = { id: "rfop_current", payment_id: "pay_a", order_id: "order_a", native_refund_id: "refund_current", capture_id: "cap_a", amount_minor: 6342 } as RefundRow;
  const attempt = { provider_refund_id: "rfd_current" } as RefundAttemptRow;
  const refunds = [
    { id: "refund_old", amount: "63.42", metadata: { gospazaRefundOperationId: "rfop_old", gospazaProviderRefundId: "rfd_old" } },
    { id: "refund_current", amount: "63.42", metadata: { gospazaRefundOperationId: "rfop_current", gospazaProviderRefundId: "rfd_current" } },
  ];
  let collectionAmount = "126.84";
  const writes: unknown[] = [];
  const payment = { retrievePayment: async () => ({ currency_code: "zar", payment_collection_id: "paycol_a", captures: [{ id: "cap_a" }], refunds }),
    retrievePaymentCollection: async () => ({ refunded_amount: collectionAmount }) };
  const order = { addOrderTransactions: async (input: unknown) => { writes.push(input); } };
  const container = { resolve: (key: string) => key === Modules.PAYMENT ? payment : order } as unknown as MedusaContainer;
  const adapter = new NativeRefundAccounting(container);
  assert.equal(await adapter.inspectRefund(row, attempt), "refund_current");
  await adapter.recordOrder(row);
  assert.deepEqual(writes, [{ order_id: "order_a", amount: "-63.42", currency_code: "zar", reference: "refund", reference_id: "refund_current" }]);
  collectionAmount = "63.42";
  await assert.rejects(adapter.inspectRefund(row, attempt), /review/);
  collectionAmount = "126.84";
  await assert.rejects(adapter.inspectRefund(row, { ...attempt, provider_refund_id: "rfd_foreign" }), /review/);
  assert.equal(await adapter.inspectRefund({ ...row, native_refund_id: null }, attempt), null);
  const current = refunds[1]; assert.ok(current);
  refunds.push({ ...current, id: "refund_duplicate" });
  await assert.rejects(adapter.inspectRefund(row, attempt), /review/);
});
