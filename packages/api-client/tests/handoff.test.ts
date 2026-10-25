import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchClient } from "../src/dispatch";
test("handoff mutations never retry uncertain responses; recovery is an explicit read", async () => {
  for (const status of [409, 503]) {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push(new URL(String(url)).pathname);
      assert.equal(init?.credentials, "include"); assert.equal(init?.cache, "no-store");
      return Response.json({}, { status: init?.method === "GET" ? 200 : status });
    };
    const c = createDispatchClient("http://localhost:9000", fetcher);
    await assert.rejects(c.verifyHandoff("delivery", 2, "123456"));
    await assert.rejects(c.regenerateHandoff("order", 2));
    await c.handoff("delivery");
    assert.deepEqual(calls, ["/driver/deliveries/delivery/handoff/verify", "/store/gospaza/orders/order/handoff-code/regenerate", "/driver/deliveries/delivery/handoff"]);
  }
});
test("lost handoff mutation responses are never replayed", async () => {
  const calls: string[] = [];
  const c = createDispatchClient("http://localhost:9000", async (url) => {
    calls.push(new URL(String(url)).pathname);
    throw new TypeError("Injected network response loss");
  });
  await assert.rejects(c.verifyHandoff("delivery", 2, "123456"));
  await assert.rejects(c.regenerateHandoff("order", 2));
  assert.deepEqual(calls, ["/driver/deliveries/delivery/handoff/verify", "/store/gospaza/orders/order/handoff-code/regenerate"]);
});
