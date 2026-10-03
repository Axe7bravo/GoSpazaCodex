import test from "node:test";
import assert from "node:assert/strict";
import { CartError, createCartClient } from "../src/cart";

const empty = { cart: null, state: "empty", eligibility: "pending" };
const current = {
  cart: {
    id: "cart_fixture", store: { id: "mstore_fixture", name: "Fixture Shop" },
    items: [], currency_code: "zar", subtotal_minor: 0, item_count: 0,
  },
  state: "current", eligibility: "pending",
};

test("cart restoration and mutation refresh use customer credentials and returned cart id", async () => {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.pathname + url.search, method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-publishable-api-key"), "pk_fixture");
    if (url.pathname === "/store/gospaza/cart/items") return Response.json({ cart_id: "cart_fixture" });
    return Response.json(url.searchParams.get("cart_id") ? current : empty);
  };
  const client = createCartClient("http://localhost:9000", "pk_fixture", fetcher);
  assert.deepEqual(await client.current(), empty);
  assert.deepEqual(await client.add({
    variant_id: "variant_fixture", quantity: 1, location: { address_id: "cuaddr_fixture" },
  }), current);
  assert.deepEqual(requests, [
    { url: "/store/gospaza/cart", method: "GET" },
    { url: "/store/gospaza/cart/items", method: "POST",
      body: { variant_id: "variant_fixture", quantity: 1, location: { address_id: "cuaddr_fixture" } } },
    { url: "/store/gospaza/cart?cart_id=cart_fixture", method: "GET" },
  ]);
});

test("cart client preserves safe conflict and uncertain response codes", async () => {
  for (const [body, expected] of [
    [{ code: "CART_MERCHANT_CONFLICT", message: "private details" }, "conflict"],
    [{ code: "CART_MUTATION_UNCERTAIN", message: "private details" }, "uncertain"],
  ] as const) {
    const fetcher: typeof fetch = async () => Response.json(body, { status: body.code === "CART_MERCHANT_CONFLICT" ? 409 : 503 });
    await assert.rejects(
      createCartClient("http://localhost:9000", "pk_fixture", fetcher).add({
        cart_id: "cart_fixture", variant_id: "variant_fixture", quantity: 1,
        location: { latitude: -29, longitude: 26 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CartError);
        assert.equal(error.kind, expected);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("remove, update and switch send only the explicit cart contract", async () => {
  const mutations: { path: string; method: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/store/gospaza/cart") return Response.json(current);
    mutations.push({ path: url.pathname, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    return Response.json({ cart_id: "cart_fixture" });
  };
  const client = createCartClient("http://localhost:9000", "pk_fixture", fetcher);
  await client.update("cali_fixture", { cart_id: "cart_fixture", quantity: 2, location: { latitude: -29, longitude: 26 } });
  await client.remove("cali_fixture", "cart_fixture");
  await client.switchStore({
    cart_id: "cart_fixture", variant_id: "variant_second", quantity: 1,
    location: { address_id: "cuaddr_fixture" }, confirm: true,
  });
  assert.deepEqual(mutations, [
    { path: "/store/gospaza/cart/items/cali_fixture", method: "PATCH",
      body: { cart_id: "cart_fixture", quantity: 2, location: { latitude: -29, longitude: 26 } } },
    { path: "/store/gospaza/cart/items/cali_fixture", method: "DELETE", body: { cart_id: "cart_fixture" } },
    { path: "/store/gospaza/cart/switch-store", method: "POST",
      body: { cart_id: "cart_fixture", variant_id: "variant_second", quantity: 1,
        location: { address_id: "cuaddr_fixture" }, confirm: true } },
  ]);
});


test("a successful mutation followed by failed restoration is not replayed or reported as success", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push((init?.method ?? "GET") + " " + url.pathname + url.search);
    return url.pathname === "/store/gospaza/cart/items"
      ? Response.json({ cart_id: "cart_committed" })
      : Response.json({ message: "internal database details" }, { status: 503 });
  };
  const client = createCartClient("http://localhost:9000", "pk_fixture", fetcher);
  await assert.rejects(client.add({ variant_id: "variant_fixture", quantity: 1,
    location: { latitude: -29, longitude: 26 } }), (error: unknown) => {
    assert.ok(error instanceof CartError);
    assert.equal(error.kind, "uncertain");
    assert.match(error.message, /Reload your cart/);
    assert.equal(error.message.includes("internal"), false);
    return true;
  });
  assert.deepEqual(calls, [
    "POST /store/gospaza/cart/items", "GET /store/gospaza/cart?cart_id=cart_committed",
  ]);
});

test("uncertain updates, removals and switches never replay the native mutation", async () => {
  const cases = [
    { method: "PATCH", path: "/store/gospaza/cart/items/cali_fixture",
      run: (client: ReturnType<typeof createCartClient>) => client.update("cali_fixture", { cart_id: "cart_fixture", quantity: 1 }) },
    { method: "DELETE", path: "/store/gospaza/cart/items/cali_fixture",
      run: (client: ReturnType<typeof createCartClient>) => client.remove("cali_fixture", "cart_fixture") },
    { method: "POST", path: "/store/gospaza/cart/switch-store",
      run: (client: ReturnType<typeof createCartClient>) => client.switchStore({ cart_id: "cart_fixture",
        variant_id: "variant_second", quantity: 1, location: { address_id: "cuaddr_fixture" }, confirm: true }) },
  ];
  for (const scenario of cases) {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push((init?.method ?? "GET") + " " + new URL(String(input)).pathname);
      return Response.json({ code: "CART_MUTATION_UNCERTAIN" }, { status: 503 });
    };
    await assert.rejects(scenario.run(createCartClient("http://localhost:9000", "pk_fixture", fetcher)),
      (error: unknown) => {
        assert.ok(error instanceof CartError);
        assert.equal(error.kind, "uncertain");
        assert.match(error.message, /Reload your cart/);
        return true;
      });
    assert.deepEqual(calls, [scenario.method + " " + scenario.path]);
  }
});


test("lost or unreadable write responses require restoration without replay", async () => {
  const failures: (() => Promise<Response>)[] = [
    async () => { throw new TypeError("Network connection lost"); },
    async () => new Response("truncated-json", { status: 200 }),
    async () => Response.json({}),
    async () => new Response("gateway lost upstream response", { status: 502 }),
    async () => Response.json(null, { status: 502 }),
  ];
  for (const fail of failures) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return fail(); };
    await assert.rejects(createCartClient("http://localhost:9000", "pk_fixture", fetcher).add({
      variant_id: "variant_fixture", quantity: 1, location: { latitude: -29, longitude: 26 },
    }), (error: unknown) => {
      assert.ok(error instanceof CartError);
      assert.equal(error.kind, "uncertain");
      assert.match(error.message, /Reload your cart/);
      return true;
    });
    assert.equal(calls, 1, "never replay or restore using a missing cart hint");
  }
});

test("ordinary read outages and explicit pre-write unavailability are not uncertain writes", async () => {
  const offline: typeof fetch = async () => { throw new TypeError("Network connection lost"); };
  await assert.rejects(createCartClient("http://localhost:9000", "pk_fixture", offline).current(),
    (error: unknown) => error instanceof CartError && error.kind === "unavailable");
  const rejected: typeof fetch = async () => Response.json({ code: "CART_UNAVAILABLE" }, { status: 503 });
  await assert.rejects(createCartClient("http://localhost:9000", "pk_fixture", rejected).add({
    variant_id: "variant_fixture", quantity: 1, location: { latitude: -29, longitude: 26 },
  }), (error: unknown) => error instanceof CartError && error.kind === "unavailable");
});
