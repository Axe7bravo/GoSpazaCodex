import assert from "node:assert/strict";
import test from "node:test";
import { createOperationsClient } from "../src/operations";
test("M23-C operations client preserves GETs and exposes only the explicit rescue command", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return new Response("{}", { status: 200 }); };
  const client = createOperationsClient("http://localhost:9000", fetcher);
  assert.deepEqual(Object.keys(client).sort(), ["overview", "attention", "order", "delivery", "lookup", "orderTimeline", "deliveryTimeline", "health", "rescue"].sort());
  await client.overview(); await client.attention("orders", "cursor_a"); await client.order("order_a"); await client.delivery("delivery_a");
  await client.lookup("DRIVER_PAYMENT", "known_payment"); await client.orderTimeline("order_a", "decision", "cursor_b"); await client.deliveryTimeline("delivery_a"); await client.health();
  assert.equal(calls[1]?.url.searchParams.get("cursor"), "cursor_a"); assert.equal(calls[4]?.url.searchParams.get("type"), "DRIVER_PAYMENT");
  assert.equal(calls[5]?.url.searchParams.get("source"), "decision");
  for (const call of calls) { assert.equal(call.init?.method, "GET"); assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); assert.equal(call.init?.body, undefined); }
  const command = { request_id: "request_a", expected_revision: 2, expected_generation: 1, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true } as const;
  await client.rescue("delivery_a", command);
  assert.equal(calls.at(-1)?.url.pathname, "/admin/gospaza/operations/deliveries/delivery_a/rescue");
  assert.equal(calls.at(-1)?.init?.method, "POST"); assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), command);
});
