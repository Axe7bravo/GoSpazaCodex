import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IApiKeyModuleService, IAuthModuleService, ICustomerModuleService, IUserModuleService } from "@medusajs/framework/types";

// Real HTTP + PostgreSQL/Redis integration. Requires the local backend running.
// Native fixtures only; fake merchant/driver actor IDs exist solely in these tests.
export default async function verifyAuth({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("Auth verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Auth verification requires a loopback backend URL.");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const keys = container.resolve<IApiKeyModuleService>(Modules.API_KEY);
  const prefix = "m1-" + randomUUID();
  const password = randomBytes(24).toString("hex");
  const key = await keys.createApiKeys({ title: prefix, type: "publishable", created_by: prefix });
  const identities: string[] = [];
  const customerIds: string[] = [];
  const userIds: string[] = [];
  const cookies: string[] = [];
  const paths = { customer: "/store/gospaza/me", merchant: "/merchant/me", driver: "/driver/me", user: "/admin/gospaza/me" };
  type Actor = keyof typeof paths;
  async function call(path: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string } = {}) {
    const headers: Record<string, string> = { "x-publishable-api-key": key.token };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = "Bearer " + options.token;
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin) headers.Origin = options.origin;
    return fetch(new URL(path, base), { method: options.method ?? "GET", headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15000) });
  }
  async function login(actor: Actor, email: string, previousCookie?: string) {
    const response = await call("/auth/" + actor + "/emailpass", { method: "POST", body: { email, password } });
    assert.equal(response.status, 200, actor + " native login");
    const { token } = await response.json() as { token: string };
    const session = await call("/auth/session", { method: "POST", token, cookie: previousCookie });
    assert.equal(session.status, 200, "native session exchange");
    const cookie = session.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie, "session cookie missing");
    assert.match(session.headers.getSetCookie().join(";"), /HttpOnly/i);
    cookies.push(cookie);
    return cookie;
  }
  const failures: unknown[] = [];
  try {
    for (const path of Object.values(paths)) assert.equal((await call(path)).status, 401, "anonymous rejected");
    for (const actor of ["driver", "user"]) {
      assert.equal((await call("/auth/" + actor + "/emailpass/register", { method: "POST", body: { email: prefix + "@example.test", password } })).status, 403);
    }
    const accounts = new Map<Actor, { email: string; id: string }>();
    // Customer: full native public registration and workflow, not direct DB insertion.
    const customerEmail = prefix + "-customer@example.test";
    const registration = await call("/auth/customer/emailpass/register", { method: "POST", body: { email: customerEmail, password } });
    assert.equal(registration.status, 200);
    // Retrieve the created identity for cleanup even if customer creation fails.
    const registered = await auth.authenticate("emailpass", { body: { email: customerEmail, password } });
    assert.ok(registered.authIdentity);
    identities.push(registered.authIdentity.id);
    const { token } = await registration.json() as { token: string };
    // Actorless tokens do not authorize a protected identity route.
    const pendingSession = await call("/auth/session", { method: "POST", token });
    assert.equal(pendingSession.status, 200, "actorless native session exchange");
    const pendingCookie = pendingSession.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    cookies.push(pendingCookie);
    assert.equal((await call(paths.customer, { cookie: pendingCookie })).status, 401);
    const created = await call("/store/customers", { method: "POST", token, body: { email: customerEmail } });
    assert.equal(created.status, 200);
    const { customer } = await created.json() as { customer: { id: string } };
    customerIds.push(customer.id);
    accounts.set("customer", { email: customerEmail, id: customer.id });

    for (const actor of ["merchant", "driver", "user"] as const) {
      const email = prefix + "-" + actor + "@example.test";
      const result = await auth.register("emailpass", { body: { email, password } });
      assert.ok(result.success && result.authIdentity);
      identities.push(result.authIdentity.id);
      let actorId = "fixture_" + actor + "_" + randomUUID();
      if (actor === "user") {
        const user = await users.createUsers({ email });
        userIds.push(user.id);
        actorId = user.id;
      }
      await auth.updateAuthIdentities({ id: result.authIdentity.id, app_metadata: { [actor + "_id"]: actorId } });
      accounts.set(actor, { email, id: actorId });
    }
    for (const [actor, account] of accounts) {
      const cookie = await login(actor, account.email);
      for (const [target, path] of Object.entries(paths)) {
        const response = await call(path, { cookie });
        assert.equal(response.status, actor === target && actor !== "merchant" ? 200 : 401, actor + " -> " + target);
        if (actor === target && actor !== "merchant") assert.deepEqual(await response.json(), { actor: { type: actor, id: account.id } });
      }
      if (actor === "customer") {
        const response = await call("/store/customers/me?fields=id,email", { cookie });
        assert.equal(response.status, 200);
        const data = await response.json() as { customer: { email: string } };
        assert.equal(data.customer.email, account.email);
      }
      assert.equal((await call("/auth/session", { method: "DELETE", cookie, origin: "https://attacker.example" })).status, 403);
      assert.equal((await call(actor === "merchant" ? "/merchant/applicant/me" : paths[actor], { cookie })).status, 200, "rejected CSRF did not log out");
      assert.equal((await call("/auth/session", { method: "DELETE", cookie })).status, 200);
      assert.equal((await call(paths[actor], { cookie })).status, 401, "destroyed session cannot be replayed");
    }
    const customerAccount = accounts.get("customer")!;
    const beforeRotation = await login("customer", customerAccount.email);
    const afterRotation = await login("customer", customerAccount.email, beforeRotation);
    assert.notEqual(beforeRotation, afterRotation, "login rotates session ID");
    assert.equal((await call(paths.customer, { cookie: beforeRotation })).status, 401, "previous session ID invalidated");
    assert.equal((await call(paths.customer, { cookie: afterRotation })).status, 200);
    const orphanEmail = prefix + "-unprovisioned@example.test";
    const orphan = await auth.register("emailpass", { body: { email: orphanEmail, password } });
    assert.ok(orphan.authIdentity);
    identities.push(orphan.authIdentity.id);
    const cookie = await login("merchant", orphanEmail);
    assert.equal((await call(paths.merchant, { cookie })).status, 401, "unprovisioned merchant rejected");
    const badLogin = await call("/auth/customer/emailpass", { method: "POST", body: { email: customerEmail, password: randomBytes(24).toString("hex") } });
    assert.equal(badLogin.status, 401);
    const preflight = await fetch(new URL(paths.merchant, base), { method: "OPTIONS",
      headers: { Origin: "http://localhost:3001", "Access-Control-Request-Method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3001");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  } catch (error) {
    failures.push(error);
  } finally {
    // Attempt every cleanup and report operation names without credentials.
    const operations: Array<{ label: string; run: () => Promise<unknown> }> = [
      ...cookies.map((cookie, index) => ({
        label: "session " + (index + 1),
        run: async () => {
          const response = await call("/auth/session", { method: "DELETE", cookie });
          assert.ok([200, 401].includes(response.status), "Session cleanup returned HTTP " + response.status);
        },
      })),
      ...customerIds.map((id) => ({ label: "customer " + id, run: () => customers.deleteCustomers(id) })),
      ...userIds.map((id) => ({ label: "user " + id, run: () => users.deleteUsers([id]) })),
      ...identities.map((id) => ({ label: "auth identity " + id, run: () => auth.deleteAuthIdentities([id]) })),
      { label: "publishable key " + key.id, run: async () => {
        // This fixture uses the module service directly and creates no sales-channel links.
        const [fixtureKey] = await keys.listApiKeys({ id: key.id, title: prefix, type: "publishable" });
        if (!fixtureKey) return; // Already deleted; never target another run's key.
        if (!fixtureKey.revoked_at || new Date(fixtureKey.revoked_at).getTime() > Date.now()) {
          // Native revocation requires nonempty attribution before deletion is allowed.
          await keys.revoke(fixtureKey.id, { revoked_by: prefix, revoke_in: 0 });
        }
        await keys.deleteApiKeys(fixtureKey.id);
      } },
    ];
    const cleanup = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation.run)));
    cleanup.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push(new Error("Auth fixture cleanup failed for " + operations[index]!.label +
          "; inspect local test data with prefix " + prefix));
      }
    });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Auth verification and fixture cleanup failed.");
  console.log("M1 auth integration passed: native registration/session/logout, actor matrix, DTOs, CSRF, CORS and unprovisioned identity.");
}

