import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationClient, createNotificationOperationsClient } from "../src/notifications";
test("notification clients use actor-owned routes and only explicit mark-read mutation", async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init }); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  for (const [actor, path] of [["customer", "/store/gospaza"], ["merchant", "/merchant"], ["driver", "/driver"], ["user", "/admin/gospaza"]] as const) {
    const client = createNotificationClient("http://localhost:9000", actor, fetcher, "pk_fixture");
    await client.list("cursor_a"); await client.detail("notice_a"); await client.markRead("notice_a");
    const group = calls.slice(-3);
    assert.equal(new Headers(group[0]?.init?.headers).get("x-publishable-api-key"), actor === "customer" ? "pk_fixture" : null);
    assert.equal(group[0]?.url.pathname, path + "/notifications"); assert.equal(group[0]?.url.searchParams.get("cursor"), "cursor_a");
    assert.equal(group[1]?.url.pathname, path + "/notifications/notice_a");
    assert.equal(group[2]?.url.pathname, path + "/notifications/notice_a/read"); assert.equal(group[2]?.init?.method, "POST");
    assert.equal(group[2]?.init?.body, "{}");
  }
  const ops = createNotificationOperationsClient("http://localhost:9000", fetcher); await ops.list(); await ops.health();
  assert.equal(calls[calls.length - 1]?.url.pathname, "/admin/gospaza/notification-operations/health");
  for (const call of calls) { assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); }
});
