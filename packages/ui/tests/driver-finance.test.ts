import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DriverEarningSummary, DriverPaymentSummary } from "@gospaza/contracts";
import { DriverEarningCard, DriverPaymentCard } from "../src/driver-finance";
const payment: DriverPaymentSummary = { id: "payment", amount_minor: "5000", currency: "zar", earning_count: 1,
  payment_date: "2026-01-02T00:00:00Z", reference: "Transfer …123456", state: "PAYMENT_RECORDED", attention_required: false };
const earning: DriverEarningSummary = { id: "earning", delivery_reference: "delivery_safe", order_reference: "order_safe", economic_at: "2026-01-01T00:00:00Z",
  amount_minor: "5000", currency: "zar", earning_type: "SUCCESSFUL_DELIVERY", payment_state: "UNPAID", attention_required: false, payment: null };
test("M21 presentation distinguishes earning, reservation, recorded payment and reconciliation", () => {
  const unpaid = renderToStaticMarkup(createElement(DriverEarningCard, { item: earning }));
  assert.match(unpaid, /Earned/); assert.match(unpaid, /50/); assert.match(unpaid, /Unpaid/);
  assert.match(renderToStaticMarkup(createElement(DriverEarningCard, { item: { ...earning, amount_minor: "6342" } })), /63[.,]42/);
  const reserved = renderToStaticMarkup(createElement(DriverEarningCard, { item: { ...earning, payment_state: "RESERVED", payment: { ...payment, state: "UNDER_REVIEW", attention_required: true } } }));
  assert.match(reserved, /Payment under review/); assert.doesNotMatch(reserved, />Paid</);
  assert.match(renderToStaticMarkup(createElement(DriverPaymentCard, { item: payment })), /Payment recorded/);
  assert.match(renderToStaticMarkup(createElement(DriverPaymentCard, { item: { ...payment, state: "RECONCILED" } })), /Reconciled/);
  assert.match(renderToStaticMarkup(createElement(DriverPaymentCard, { item: { ...payment, attention_required: true } })), /Payment needs review/);
});
