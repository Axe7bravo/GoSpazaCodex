import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, createDriverAuthClient, createCustomerAuthClient } from "../src/auth";
import { createDriverClient, createMerchantDriverClient, createAdminDriverClient } from "../src/drivers";

test("driver onboarding uses native DRIVER scope without actor metadata or a new customer", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, init });
    if (path.includes("emailpass")) return Response.json({ token: "transient" });
    if (path === "/auth/session") return Response.json({});
    return Response.json({ onboarding: true });
  };
  const client = createDriverAuthClient({ baseUrl: "http://localhost:9000", fetcher });
  assert.deepEqual(await client.login("same@example.test", "existing-password"), { type: "driver", scope: "onboarding" });
  assert.deepEqual(calls.map(c => c.path), ["/auth/driver/emailpass", "/auth/session", "/driver/onboarding/me"]);
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(new Headers(calls[1]?.init?.headers).get("Authorization"), "Bearer transient");
  assert.equal(new Headers(calls[2]?.init?.headers).has("Authorization"), false);
  calls.length = 0;
  await client.register("new@example.test", "long-new-password");
  assert.deepEqual(calls.map(c => c.path), ["/auth/driver/emailpass/register", "/auth/session", "/driver/onboarding/me"]);
});
test("existing-email driver registration directs to sign-in without replay or password replacement", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async input => { paths.push(new URL(String(input)).pathname); return Response.json({ message: "private" }, { status: 401 }); };
  await assert.rejects(createDriverAuthClient({ baseUrl: "http://localhost:9000", fetcher }).register("same@example.test", "long-password"), /existing GoSpaza credentials/);
  assert.deepEqual(paths, ["/auth/driver/emailpass/register"]);
});
test("same-email customer and driver logins retain distinct actor probes", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path.includes("emailpass")) return Response.json({ token: "transient" });
    if (path === "/driver/onboarding/me") return Response.json({ onboarding: true });
    if (path === "/store/gospaza/me") return Response.json({ actor: { type: "customer", id: "cus_fixture" } });
    return Response.json({});
  };
  const options = { baseUrl: "http://localhost:9000", fetcher };
  await createCustomerAuthClient({ ...options, publishableKey: "pk_fixture" }).login("same@example.test", "existing-password");
  await createDriverAuthClient(options).login("same@example.test", "existing-password");
  assert.deepEqual(calls, ["/auth/customer/emailpass", "/auth/session", "/store/gospaza/me", "/auth/driver/emailpass", "/auth/session", "/driver/onboarding/me"]);
});
test("missing driver profile requires a still-valid onboarding session; outages do not become bootstrap", async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    return path === "/driver/profile" ? Response.json({}, { status: 401 }) : Response.json({ onboarding: true });
  };
  assert.equal(await createDriverClient("http://localhost:9000", fetcher).restore(), null);
  assert.deepEqual(paths, ["/driver/onboarding/me", "/driver/profile", "/driver/onboarding/me"]);
  const unavailable: typeof fetch = async () => Response.json({ message: "internal" }, { status: 503 });
  await assert.rejects(createDriverClient("http://localhost:9000", unavailable).restore(), (error: unknown) => error instanceof AuthError && error.kind === "unavailable");
});
test("driver, merchant and admin requests send only explicit contract fields and never replay conflicts", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => { calls.push({ path: new URL(String(input)).pathname, init }); return Response.json({}); };
  const driver = createDriverClient("http://localhost:9000", fetcher);
  const forged = { display_name: "Driver", contact_phone: "0821234567", status: "ACTIVE", auth_identity_id: "foreign" };
  await driver.update(3, forged);
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { expected_revision: 3, display_name: "Driver", contact_phone: "0821234567" });
  await driver.requestAffiliation({ kind: "MERCHANT", expected_revision: 4, merchant_store_id: "store_selected" });
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { kind: "MERCHANT", expected_revision: 4, merchant_store_id: "store_selected" });
  const decision = { expected_revision: 5, confirmed: true, reason: "Reviewed", merchant_id: "forged", eligibility: true } as const;
  await createMerchantDriverClient("http://localhost:9000", fetcher).decide("aff_fixture", "endorse", decision);
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { expected_revision: 5, confirmed: true, reason: "Reviewed" });
  await createAdminDriverClient("http://localhost:9000", fetcher).decide("drv_fixture", "approve", decision);
  assert.equal(calls.at(-1)?.path, "/admin/gospaza/drivers/drv_fixture/approve");
  for (const call of calls) { assert.equal(call.init?.credentials, "include"); assert.equal(call.init?.cache, "no-store"); }
  let count = 0;
  const conflict: typeof fetch = async () => { count++; return Response.json({ message: "private database diagnostic" }, { status: 409 }); };
  await assert.rejects(createMerchantDriverClient("http://localhost:9000", conflict).decide("aff_fixture", "revoke", decision), (error: unknown) => error instanceof AuthError && error.status === 409 && !error.message.includes("private"));
  assert.equal(count, 1);
});

test("driver read clients use bounded actor-specific pages without identity authority", async () => {
  const urls: URL[] = [];
  const fetcher: typeof fetch = async input => { urls.push(new URL(String(input))); return Response.json({ items: [], count: 0, limit: 20, offset: 20 }); };
  await createDriverClient("http://localhost:9000", fetcher).targets(20);
  await createDriverClient("http://localhost:9000", fetcher).history(20);
  await createMerchantDriverClient("http://localhost:9000", fetcher).list(20);
  await createAdminDriverClient("http://localhost:9000", fetcher).list(20, "PENDING_REVIEW");
  assert.deepEqual(urls.map(u => u.pathname), ["/driver/affiliation-targets", "/driver/affiliations", "/merchant/drivers", "/admin/gospaza/drivers"]);
  for (const url of urls) { assert.equal(url.searchParams.get("limit"), "20"); assert.equal(url.searchParams.get("offset"), "20"); }
  assert.equal(urls.at(-1)?.searchParams.get("status"), "PENDING_REVIEW");
});
