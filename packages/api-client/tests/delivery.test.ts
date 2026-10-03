import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryClient, DeliveryError } from "../src/delivery";

const input = { cart_id: "cart_fixture", location: { address_id: "cuaddr_fixture" }, option_id: "doption_asap", expected_revision: 3, expected_option_revision: 7 };
test("delivery requests carry credentials, exact selections/revisions and no location on release", async () => {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-publishable-api-key"), "pk_test");
    calls.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ state: "unselected", revision: 3, timezone: null, selection: null });
  };
  const client = createDeliveryClient("http://localhost:9000", "pk_test", fetcher);
  await client.current("cart_fixture");
  await client.availability(input.cart_id, input.location);
  await client.select(input);
  await client.select({ ...input, slot_id: "dslot_fixture" });
  await client.release({ cart_id: input.cart_id, reservation_id: "dres_fixture", expected_revision: 4 });
  assert.deepEqual(calls, [
    { path: "/store/gospaza/cart/delivery-selection?cart_id=cart_fixture", method: "GET", body: null },
    { path: "/store/gospaza/cart/delivery-options", method: "POST", body: { cart_id: input.cart_id, location: input.location } },
    { path: "/store/gospaza/cart/delivery-selection", method: "PUT", body: input },
    { path: "/store/gospaza/cart/delivery-selection", method: "PUT", body: { ...input, slot_id: "dslot_fixture" } },
    { path: "/store/gospaza/cart/delivery-selection", method: "DELETE", body: { cart_id: input.cart_id, reservation_id: "dres_fixture", expected_revision: 4 } },
  ]);
});
test("stale, unavailable and uncertain delivery writes require refresh without replay or upstream disclosure", async () => {
  for (const status of [400, 404, 409, 503]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ message: "secret upstream details" }, { status }); };
    await assert.rejects(createDeliveryClient("http://localhost:9000", "pk", fetcher).select(input), (error: unknown) => {
      assert.ok(error instanceof DeliveryError);
      assert.equal(error.refreshRequired, true);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
test("lost write responses are uncertain, discovery POST is a read and neither is automatically retried", async () => {
  const offline: typeof fetch = async () => { throw new Error("offline"); };
  const client = createDeliveryClient("http://localhost:9000", "pk", offline);
  await assert.rejects(client.select(input), (error: unknown) => error instanceof DeliveryError && error.refreshRequired);
  await assert.rejects(client.release({ cart_id: input.cart_id, expected_revision: 1 }), (error: unknown) => error instanceof DeliveryError && error.refreshRequired);
  await assert.rejects(client.availability(input.cart_id, input.location), (error: unknown) => error instanceof DeliveryError && !error.refreshRequired);
});
