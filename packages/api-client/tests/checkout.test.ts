import test from "node:test";
import assert from "node:assert/strict";
import { CheckoutError, checkoutRedirect, createCheckoutClient } from "../src/checkout";

const input = { cart_id: "cart_test", address_id: "addr_test", expected_reservation_revision: 2 };
const confirmed = { ...input, confirmed: true as const, checkout_revision: "revision" };
const payment = { cart_id: "cart_test", attempt_id: "chk_test", checkout_revision: "revision", confirmed: true as const };
test("checkout uses credentialed GoSpaza APIs and projects choices rather than authority", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.credentials, "include"); assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-publishable-api-key"), "pk_test");
    calls.push({ path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ state: "none", attempt: null });
  };
  const client = createCheckoutClient("http://localhost:9000", "pk_test", fetcher);
  await client.status();
  const forgedPreparation = { ...input, total: 1, customer_id: "foreign" };
  await client.prepare(forgedPreparation);
  await client.confirm(confirmed);
  const forgedPayment = { ...payment, payment_session_id: "foreign" };
  await client.pay(forgedPayment);
  await client.abandon(payment);
  assert.deepEqual(calls, [
    { path: "/store/gospaza/checkout/status", body: null },
    { path: "/store/gospaza/checkout/prepare", body: input },
    { path: "/store/gospaza/checkout/confirm", body: confirmed },
    { path: "/store/gospaza/checkout/pay", body: payment },
    { path: "/store/gospaza/checkout/abandon", body: payment },
  ]);
});
test("changed quote and uncertain/expired initiation remain explicit responses, never automatic retries", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    calls++;
    return new URL(String(url)).pathname.endsWith("confirm")
      ? Response.json({ code: "CHECKOUT_RECONFIRM", reconfirmation_required: true, quote: { totals: { total_minor: 2500 } }, attempt: null }, { status: 409 })
      : Response.json({ state: "uncertain", redirect_url: null }, { status: 503 });
  };
  const client = createCheckoutClient("http://localhost:9000", "pk", fetcher);
  assert.equal((await client.confirm(confirmed)).reconfirmation_required, true);
  assert.equal((await client.pay(payment)).state, "uncertain");
  assert.equal(calls, 2);
  const expired: typeof fetch = async () => Response.json({ state: "expired", redirect_url: null }, { status: 409 });
  assert.equal((await createCheckoutClient("http://localhost:9000", "pk", expired).pay(payment)).state, "expired");
});
test("payment failures redact diagnostics, lost responses never replay, and redirects are constrained", async () => {
  for (const status of [401, 404, 409, 503]) {
    const fetcher: typeof fetch = async () => Response.json({ message: "provider secret", code: "internal_diagnostic" }, { status });
    await assert.rejects(createCheckoutClient("http://localhost:9000", "pk", fetcher).pay(payment), (cause: unknown) => {
      assert.ok(cause instanceof CheckoutError); assert.equal(cause.message.includes("secret"), false);
      assert.equal(cause.code.includes("internal"), false); return true;
    });
  }
  let calls = 0;
  const offline: typeof fetch = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(createCheckoutClient("http://localhost:9000", "pk", offline).pay(payment), CheckoutError);
  assert.equal(calls, 1);
  assert.equal(checkoutRedirect("https://c.yoco.com/checkout/test"), "https://c.yoco.com/checkout/test");
  for (const url of ["javascript:alert(1)", "https://c.yoco.com.evil.test/pay", "https://user:pass@c.yoco.com/pay", "http://c.yoco.com/pay"]) {
    assert.throws(() => checkoutRedirect(url));
  }
});