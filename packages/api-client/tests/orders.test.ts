import test from "node:test";
import assert from "node:assert/strict";
import { createMerchantOrderClient, createCustomerOrderClient, OrderError } from "../src/orders";

test("order clients project only choices and use actor-specific credentialed routes", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    return Response.json({});
  };
  const merchant = createMerchantOrderClient("http://localhost:9000", fetcher);
  const filter = { status: "PENDING_ACCEPTANCE" as const, limit: 20, offset: 20, merchant_id: "forged" };
  await merchant.list(filter);
  await merchant.detail("order_foreign/path");
  const input = { expected_revision: 0, confirmed: true as const, status: "REJECTED", merchant_id: "forged", decided_by: "forged" };
  await merchant.accept("order_own", input);
  await merchant.reject("order_own", { ...input, reason: "Unable to fulfil" });
  await createCustomerOrderClient("http://localhost:9000", "pk_test", fetcher).detail("order_own");
  assert.equal(calls[0]?.url.searchParams.has("merchant_id"), false);
  assert.equal(calls[1]?.url.pathname, "/merchant/orders/order_foreign%2Fpath");
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { expected_revision: 0, confirmed: true });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { expected_revision: 0, confirmed: true, reason: "Unable to fulfil" });
  assert.equal(calls[4]?.url.pathname, "/store/gospaza/orders/order_own");
  assert.equal(new Headers(calls[4]?.init?.headers).get("x-publishable-api-key"), "pk_test");
});
test("order failures are safe and never replay mutations", async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ message: "private diagnostic" }, { status }); };
    await assert.rejects(createMerchantOrderClient("http://localhost:9000", fetcher).accept("order_own",
      { expected_revision: 0, confirmed: true }), (cause: unknown) => {
        assert.ok(cause instanceof OrderError);
        assert.equal(cause.status, status);
        assert.equal(cause.message.includes("private"), false);
        return true;
      });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const offline: typeof fetch = async () => { calls++; throw new Error("lost response"); };
  await assert.rejects(createMerchantOrderClient("http://localhost:9000", offline).reject("order_own",
    { expected_revision: 0, confirmed: true }), OrderError);
  assert.equal(calls, 1);
});
