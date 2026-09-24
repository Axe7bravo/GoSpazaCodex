import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, createAuthClient, createCustomerAuthClient, validateCredentials } from "../src/auth";

test("registration validates email and password length", () => {
  assert.match(validateCredentials("invalid", "long-test-password", true)!, /email/);
  assert.match(validateCredentials("test@example.test", "short", true)!, /12/);
  assert.equal(validateCredentials("test@example.test", "test-password-long", true), null);
});
test("login exchanges a transient token for a native session and checks actor identity", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init });
    if (path === "/auth/merchant/emailpass") return Response.json({ token: "fixture-token" });
    if (path === "/auth/session") return Response.json({});
    return Response.json({ actor: { type: "merchant", id: "merchant_fixture" } });
  };
  const client = createAuthClient("merchant", { baseUrl: "http://localhost:9000", fetcher });
  assert.deepEqual(await client.login("test@example.test", "fixture-password"), { type: "merchant", id: "merchant_fixture" });
  assert.deepEqual(calls.map((c) => c.path), ["/auth/merchant/emailpass", "/auth/session", "/merchant/me"]);
  assert.equal(calls[0]!.init!.credentials, "omit");
  assert.equal(calls[1]!.init!.credentials, "include");
  assert.equal(new Headers(calls[1]!.init!.headers).get("Authorization"), "Bearer fixture-token");
  assert.equal(new Headers(calls[2]!.init!.headers).has("Authorization"), false);
  assert.equal("register" in client, false);
  assert.equal("account" in client, false);
});
test("invalid credentials and unavailable backend have distinct safe errors", async () => {
  const invalid: typeof fetch = async () => Response.json({ message: "private provider details" }, { status: 401 });
  await assert.rejects(createAuthClient("user", { baseUrl: "http://localhost:9000", fetcher: invalid }).login("test@example.test", "fixture-password"),
    (e: unknown) => e instanceof AuthError && e.kind === "credentials" && !e.message.includes("private"));
  const unavailable: typeof fetch = async () => { throw new Error("internal URL"); };
  await assert.rejects(createAuthClient("user", { baseUrl: "http://localhost:9000", fetcher: unavailable }).me(),
    (e: unknown) => e instanceof AuthError && e.kind === "unavailable");
});
test("wrong-actor responses fail closed; unprovisioned login clears the native session", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push((init?.method ?? "GET") + " " + path);
    if (path.endsWith("emailpass")) return Response.json({ token: "fixture" });
    if (path === "/auth/session") return Response.json({});
    return Response.json({ actor: { type: "customer", id: "customer_fixture" } });
  };
  const client = createAuthClient("driver", { baseUrl: "http://localhost:9000", fetcher });
  await assert.rejects(client.login("test@example.test", "fixture-password"), (e: unknown) => e instanceof AuthError && e.kind === "unprovisioned");
  assert.equal(calls.at(-1), "DELETE /auth/session");
});
test("native customer registration ignores existing cookies and refreshes login before account retrieval", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname.includes("emailpass")) return Response.json({ token: "fixture-token" });
    if (url.pathname === "/store/gospaza/me") return Response.json({ actor: { type: "customer", id: "cus_fixture" } });
    if (url.pathname === "/store/customers/me") return Response.json({ customer: { id: "cus_fixture", email: "test@example.test", metadata: { private: true } } });
    return Response.json({});
  };
  const client = createCustomerAuthClient({ baseUrl: "http://localhost:9000", publishableKey: "pk_fixture", fetcher });
  const account = await client.register("test@example.test", "fixture-password-long");
  assert.deepEqual(account, { id: "cus_fixture", email: "test@example.test", first_name: null, last_name: null });
  assert.deepEqual(calls.map((c) => c.url.pathname), ["/auth/customer/emailpass/register", "/store/customers", "/auth/customer/emailpass", "/auth/session", "/store/gospaza/me", "/store/customers/me"]);
  assert.equal(calls[1]!.init!.credentials, "omit");
  assert.equal(new Headers(calls[1]!.init!.headers).get("x-publishable-api-key"), "pk_fixture");
  assert.equal(new Headers(calls.at(-1)!.init!.headers).has("Authorization"), false);
  await client.logout();
  assert.equal(calls.at(-1)!.init!.method, "DELETE");
});
test("registration can resume with an existing EmailPass identity but does not swallow customer creation failure", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path.endsWith("/register")) return Response.json({}, { status: 401 });
    if (path.endsWith("emailpass")) return Response.json({ token: "fixture" });
    return Response.json({}, { status: 400 });
  };
  const client = createCustomerAuthClient({ baseUrl: "http://localhost:9000", publishableKey: "pk_fixture", fetcher });
  await assert.rejects(client.register("test@example.test", "fixture-password-long"), /already exist/);
  assert.deepEqual(calls, ["/auth/customer/emailpass/register", "/auth/customer/emailpass", "/store/customers"]);
});
test("anonymous me and already-expired logout are handled correctly", async () => {
  const fetcher: typeof fetch = async () => Response.json({}, { status: 401 });
  const client = createAuthClient("user", { baseUrl: "http://localhost:9000", fetcher });
  await assert.rejects(client.me(), (e: unknown) => e instanceof AuthError && e.kind === "unauthorized");
  await assert.doesNotReject(client.logout());
});

