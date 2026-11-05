import assert from "node:assert/strict";
import test from "node:test";
import { createDriverFinanceClient, createPlatformDriverFinanceClient } from "../src/driver-finance";
import { AuthError } from "../src/auth";
test("M21 self-read requests never supply a driver identity and retain native session/no-store", async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init }); return new Response("{}", { status: 200 }); };
  const client = createDriverFinanceClient("http://localhost:9000", fetcher);
  await client.own(); await client.earning("known/id"); await client.payment("payment/id"); await client.payments();
  assert.deepEqual(calls.map(c => c.url.pathname), ["/driver/earnings", "/driver/earnings/known%2Fid", "/driver/earnings/payments/payment%2Fid", "/driver/earnings/payments"]);
  for (const call of calls) {
    assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.body, undefined); assert.equal(call.url.searchParams.has("driver"), false);
  }
});
test("M21 conflicts retain an explicit status and bounded financial wording", async () => {
  const fetcher: typeof fetch = async () => new Response('{"message":"private database detail"}', { status: 409 });
  await assert.rejects(createPlatformDriverFinanceClient("http://localhost:9000", fetcher).earning("known"), error =>
    error instanceof AuthError && error.status === 409 && /Financial evidence/.test(error.message) && !error.message.includes("database"));
});
test("M21 platform reads and explicit commands use their actual domain route families", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async url => { paths.push(new URL(String(url)).pathname); return new Response("{}", { status: 200 }); };
  const c = createPlatformDriverFinanceClient("http://localhost:9000", fetcher);
  await c.capabilities(); await c.earnings(); await c.earning("earning"); await c.payments(); await c.payment("payment"); await c.evidence("payment"); await c.terms();
  assert.deepEqual(paths, ["/admin/gospaza/driver-finance/capabilities", "/admin/gospaza/driver-finance/earnings", "/admin/gospaza/driver-finance/earnings/earning",
    "/admin/gospaza/driver-finance/payments", "/admin/gospaza/driver-finance/payments/payment", "/admin/gospaza/driver-payments/payment", "/admin/gospaza/driver-compensation"]);
  assert.equal("updateEarning" in c, false); assert.equal("setPaid" in c, false);
});
