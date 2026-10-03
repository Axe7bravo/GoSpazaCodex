import test from "node:test";
import assert from "node:assert/strict";
import { AuthError, createStorefrontClient } from "../src/index";

test("discovery uses the native customer session and noncached location body", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "http://localhost:9000/store/gospaza/discovery");
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-publishable-api-key"), "pk_fixture");
    assert.deepEqual(JSON.parse(String(init?.body)), { address_id: "cuaddr_fixture", offset: 0, limit: 20 });
    return Response.json({ mode: "none", stores: [], count: 0, eligible_store_count: 0, limit: 20, offset: 0 });
  };
  await createStorefrontClient("http://localhost:9000", "pk_fixture", fetcher).discover({ address_id: "cuaddr_fixture" });
});
test("storefront errors never render native diagnostic bodies or false empty results", async () => {
  for (const status of [400, 401, 404, 500, 503]) {
    const fetcher: typeof fetch = async () => Response.json({ message: "private SQL and storage details" }, { status });
    await assert.rejects(createStorefrontClient("http://localhost:9000", "pk_fixture", fetcher)
      .product("prod_fixture", { latitude: -29, longitude: 26 }), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.status, status);
      assert.equal(error.message.includes("private SQL"), false);
      return true;
    });
  }
});
