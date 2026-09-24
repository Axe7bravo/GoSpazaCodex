import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient } from "../src/index";

test("health client checks the response and sends no credentials", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "http://localhost:9000/health/live");
    assert.equal(init?.credentials, "omit");
    return Response.json({ status: "ok" });
  };
  assert.deepEqual(await createApiClient("http://localhost:9000", fetcher).liveness(), { status: "ok" });
});
test("HTTP failure retains status and request ID without response body", async () => {
  const fetcher: typeof fetch = async () => new Response("sensitive", { status: 503, headers: { "x-request-id": "abc" } });
  await assert.rejects(createApiClient("http://localhost:9000", fetcher).liveness(),
    (error: unknown) => error instanceof ApiError && error.status === 503 && error.requestId === "abc" && !error.message.includes("sensitive"));
});
test("invalid URLs and malformed success bodies are rejected", async () => {
  assert.throws(() => createApiClient("file:///tmp/test"));
  assert.throws(() => createApiClient("https://user:password@example.com"));
  const fetcher: typeof fetch = async () => Response.json({ status: "unexpected" });
  await assert.rejects(createApiClient("http://localhost:9000", fetcher).liveness(), /Invalid liveness/);
});
