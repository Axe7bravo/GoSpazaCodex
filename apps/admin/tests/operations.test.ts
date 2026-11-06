import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeliveryDiagnostic, DeliveryRescueCommand } from "@gospaza/contracts";
import { AttentionTable, DeliveryView, ExactLookupForm, HealthView, OrderView, OverviewView, RescueReview, TimelineView } from "../app/operations-presentation";
const at = "2026-11-06T12:00:00Z";
const delivery: DeliveryDiagnostic = { id: "delivery_a", order_id: "order_a", merchant_id: "merchant_a", store_id: "store_a", status: "ATTENTION_REQUIRED", revision: 4, generation: 1,
  mode: "HYBRID", path: "PLATFORM", reason_code: "POOL_EXHAUSTED", commitment: null, pickup: [], completion_state: null, return_state: null,
  timing: { dispatch_not_before: null, started_at: at, deadline: at, picked_up_at: null, arrived_at: null, delivered_at: null },
  rescue: { eligible: true, scope: "PERSISTED_PRECHECK", block_reason: null, requires_admission_revalidation: true } };
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
test("M23-C lookup has associated exact-ID controls and no PII search", () => {
  const result = html(createElement(ExactLookupForm, { busy: false, submit: () => undefined }));
  assert.match(result, /for="operations-lookup-type"/); assert.match(result, /id="operations-lookup-type"/);
  assert.match(result, /Exact record ID/); assert.match(result, /value="ORDER"/); assert.doesNotMatch(result, /type="email"|type="search"|phone/);
});
test("M23-C overview and attention distinguish unavailable, empty and bounded current samples", () => {
  const page = { source: "deliveries" as const, observed_at: at, items: [], next_cursor: null, has_more: false, page_count: 0, oldest_in_sample: null };
  assert.match(html(createElement(AttentionTable, { page })), /No current attention/);
  const result = html(createElement(OverviewView, { data: { observed_at: at, sections: [{ source: "deliveries", availability: "UNAVAILABLE" }], links: [], navigation: { orders: false, deliveries: true } } }));
  assert.match(result, /Source unavailable/); assert.doesNotMatch(result, /exact-ID diagnostics/);
});
test("M23-C order and delivery render authorized safe state without invented finance or assignment", () => {
  const order = html(createElement(OrderView, { data: { order: { id: "order_a", status: "pending", currency: "zar" }, handoff: "UNPROVEN", operation: null, store: null, picking: null, unavailable_sections: [] } }));
  assert.match(order, /UNPROVEN/); assert.doesNotMatch(order, /Financial context/);
  const result = html(createElement(DeliveryView, { data: delivery }));
  assert.match(result, /generation 1/); assert.match(result, /No recorded commitment/); assert.match(result, /current admission must still be validated/);
});
test("M23-C rescue review describes generation reopening, not assignment or completion", () => {
  const command: DeliveryRescueCommand = { request_id: "request_a", expected_generation: 1, expected_revision: 4, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true };
  const result = html(createElement(RescueReview, { data: delivery, command }));
  assert.match(result, /generation 1 to generation 2/); assert.match(result, /re-enter normal dispatch/); assert.match(result, /No driver is selected/); assert.match(result, /RETRY_DISPATCH_SEARCH/);
});
test("M23-C timeline and health do not greenwash absent instrumentation", () => {
  assert.match(html(createElement(TimelineView, { data: { observed_at: at, pages: [{ source: "delivery", items: [], next_cursor: null, has_more: false }] } })), /No events/);
  const result = html(createElement(HealthView, { data: { observed_at: at, workers: [{ name: "Dispatch", enabled: true, execution_health: "NOT_INSTRUMENTED", sample_kind: "DUE_WORK", sample_count: 1, has_more: false, oldest_in_sample: at }] } }));
  assert.match(result, /Not instrumented/); assert.doesNotMatch(result, />Healthy</);
});
