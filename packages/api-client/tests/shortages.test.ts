import test from "node:test";
import assert from "node:assert/strict";
import { createCustomerOrderClient, OrderError } from "../src/orders";
import { createPickingClient } from "../src/picking";

test("shortage clients submit only choices and server revisions through actor routes", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    return Response.json({});
  };
  const customer = createCustomerOrderClient("http://localhost:9000", "pk_test", fetcher);
  await customer.preference("order/foreign");
  const input = { preference: "CONTACT_ME" as const, expected_revision: 7, customer_id: "forged", status: "RESOLVED_OMITTED" };
  await customer.updatePreference("order_own", input);
  await customer.updatePreference("order_own", input); // Same revision is retained on an explicit caller replay.
  await customer.shortages("order_own");
  const omission = { ...input, confirmed: true as const, omitted_quantity: 99, merchant_id: "forged" };
  await customer.omit("order_own", "case/foreign", omission);
  await createPickingClient("http://localhost:9000", fetcher).shortages("order_own");
  assert.equal(calls[0]?.url.pathname, "/store/gospaza/orders/order%2Fforeign/substitution-preference");
  for (const index of [1, 2]) {
    assert.equal(calls[index]?.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[index]?.init?.body)), { preference: "CONTACT_ME", expected_revision: 7 });
  }
  assert.equal(calls[3]?.url.pathname, "/store/gospaza/orders/order_own/shortages");
  assert.equal(calls[4]?.url.pathname, "/store/gospaza/orders/order_own/shortages/case%2Fforeign/omit");
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { expected_revision: 7, confirmed: true });
  assert.equal(calls[5]?.url.pathname, "/merchant/picking/order_own/shortages");
  assert.equal(new Headers(calls[4]?.init?.headers).get("x-publishable-api-key"), "pk_test");
});

test("stale, forbidden and uncertain consent never retries or exposes backend diagnostics", async () => {
  for (const status of [401, 403, 404, 409, 500]) {
    let calls = 0;
    const client = createCustomerOrderClient("http://localhost:9000", "pk_test", async () => {
      calls++; return Response.json({ message: "private customer evidence" }, { status });
    });
    await assert.rejects(client.omit("order_own", "case_old", { expected_revision: 1, confirmed: true }), (cause: unknown) => {
      assert.ok(cause instanceof OrderError);
      assert.equal(cause.status, status);
      assert.equal(cause.message.includes("private"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createCustomerOrderClient("http://localhost:9000", "pk_test", async () => {
    calls++; throw new Error("unknown outcome");
  });
  await assert.rejects(client.omit("order_own", "case_current", { expected_revision: 1, confirmed: true }), OrderError);
  assert.equal(calls, 1);
});
