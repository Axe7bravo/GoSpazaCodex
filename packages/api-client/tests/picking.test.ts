import test from "node:test";
import assert from "node:assert/strict";
import { createPickingClient, PickingError } from "../src/picking";

test("picking client sends only choices, current revision and encoded selectors", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json({}); };
  const client = createPickingClient("http://localhost:9000", fetcher);
  await client.list({ limit: 20, offset: 20, status: "IN_PROGRESS" });
  await client.detail("order/known"); await client.claim("order");
  const hostile = { expected_revision: 2, picked_quantity: 3, shortage_recorded: true, merchant_id: "forged", quantity: 99, status: "COMPLETED" };
  await client.updateLine("order", "line/known", hostile);
  await client.reassign("order", { ...hostile, target_member_id: "member" });
  await client.complete("order", { ...hostile, confirmed: true });
  assert.equal(calls[0]?.url.search, "?limit=20&offset=20&status=IN_PROGRESS");
  assert.equal(calls[1]?.url.pathname, "/merchant/picking/order%2Fknown");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {});
  assert.equal(calls[3]?.url.pathname, "/merchant/picking/order/lines/line%2Fknown");
  assert.equal(calls[3]?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { expected_revision: 2, picked_quantity: 3, shortage_recorded: true });
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { expected_revision: 2, target_member_id: "member" });
  assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), { expected_revision: 2, confirmed: true });
  for (const call of calls) { assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); }
});
test("picking errors exclude server diagnostics and never retry a mutation", async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    let calls = 0;
    const client = createPickingClient("http://localhost:9000", async () => { calls++; return Response.json({ message: "private secret" }, { status }); });
    await assert.rejects(client.claim("order"), (error: unknown) => {
      assert.ok(error instanceof PickingError); assert.equal(error.status, status); assert.ok(!error.message.includes("secret")); return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createPickingClient("http://localhost:9000", async () => { calls++; throw new Error("response lost"); });
  await assert.rejects(client.complete("order", { expected_revision: 3, confirmed: true }), PickingError);
  assert.equal(calls, 1);
});
