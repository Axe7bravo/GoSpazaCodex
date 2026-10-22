import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchClient } from "../src/dispatch";
test("dispatch client sends only driver choices, never actor/mode authority", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json({}); };
  const client = createDispatchClient("http://localhost:9000", fetcher);
  await client.intent(true, 3);
  await client.location({ generation: "dgen_fixture", sequence: 2, latitude: -29, longitude: 26, accuracy: 10,
    ...{ driver_id: "foreign", mode: "PLATFORM_ONLY", received_at: 0 } });
  await client.decide("commit_fixture", "accept", 1);
  assert.deepEqual(calls.map(c => c.url.pathname), ["/driver/availability/online", "/driver/location", "/driver/offers/commit_fixture/accept"]);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { generation: "dgen_fixture", sequence: 2, latitude: -29, longitude: 26, accuracy: 10 });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { expected_revision: 1 });
  for (const call of calls) { assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); }
});
test("uncertain dispatch decision and conflict never cause automatic replay", async () => {
  for (const status of [409, 503]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ message: "private diagnostic" }, { status }); };
    await assert.rejects(createDispatchClient("http://localhost:9000", fetcher).decide("commit_fixture", "accept", 1),
      (error: unknown) => error instanceof Error && !error.message.includes("private diagnostic"));
    assert.equal(calls, 1);
  }
});
test("customer dispatch reads use owned order endpoint and publishable key", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/store/gospaza/orders/order_fixture/delivery");
    assert.equal(new Headers(init?.headers).get("x-publishable-api-key"), "pk_fixture");
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
    return Response.json({ status: "ASSIGNED" });
  };
  assert.deepEqual(await createDispatchClient("http://localhost:9000", fetcher, "pk_fixture").customer("order_fixture"), { status: "ASSIGNED" });
});
