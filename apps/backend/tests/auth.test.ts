import assert from "node:assert/strict";
import { test } from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { validateEmailPass } from "../src/lib/auth-rate-limit";
import { AUTH_METHODS } from "../src/lib/auth-config";
import { requireActor, actorIdentity } from "../src/lib/auth-policy";
import { authOrigin, publicRegistrationActors } from "../src/lib/auth-http";

test("all four actors explicitly use only EmailPass", () => {
  assert.deepEqual(AUTH_METHODS, { customer: ["emailpass"], user: ["emailpass"], merchant: ["emailpass"], driver: ["emailpass"] });
});
test("native session guards enforce the complete actor matrix and reject anonymous/actorless requests", async () => {
  const actors = ["customer", "merchant", "driver", "user"] as const;
  for (const expected of actors) {
    for (const actual of [...actors, undefined]) {
      for (const id of ["fixture_actor", ""]) {
        let allowed = false;
        let status = 0;
        const req = {
          session: actual ? { auth_context: { actor_type: actual, actor_id: id, auth_identity_id: "fixture_identity" } } : {},
          headers: {},
          scope: { resolve: () => ({ projectConfig: { http: { jwtSecret: "unit-test-only" } } }) },
        } as unknown as MedusaRequest;
        const res = { status(code: number) { status = code; return this; }, json() {} } as unknown as MedusaResponse;
        await requireActor(expected)(req, res, () => { allowed = true; });
        assert.equal(allowed, actual === expected && !!id);
        if (!allowed) assert.equal(status, 401);
      }
    }
  }
});
test("identity DTO uses an allowlist and never returns auth metadata", async () => {
  let body: unknown;
  const req = { auth_context: { actor_type: "merchant", actor_id: "fixture_merchant", auth_identity_id: "private",
    app_metadata: { bank: "private" }, user_metadata: { password: "private" } } } as unknown as MedusaRequest;
  const res = { setHeader() {}, json(value: unknown) { body = value; } } as unknown as MedusaResponse;
  await actorIdentity("merchant")(req, res);
  assert.deepEqual(body, { actor: { type: "merchant", id: "fixture_merchant" } });
});
test("registration excludes platform users and drivers and browser mutations reject untrusted origins", () => {
  for (const actor of ["user", "driver"]) {
    let status = 0;
    const res = { status(value: number) { status = value; return this; }, json() {} } as unknown as MedusaResponse;
    publicRegistrationActors({ params: { actor_type: actor } } as unknown as MedusaRequest, res, () => assert.fail("allowed registration"));
    assert.equal(status, 403);
  }
  let status = 0;
  const req = { method: "DELETE", get: (header: string) => header === "origin" ? "https://attacker.example" : undefined,
    scope: { resolve: () => ({ projectConfig: { http: { authCors: "http://localhost:3000" } } }) } } as unknown as MedusaRequest;
  const res = { setHeader() {}, status(value: number) { status = value; return this; }, json() {} } as unknown as MedusaResponse;
  authOrigin(req, res, () => assert.fail("allowed untrusted origin"));
  assert.equal(status, 403);
});


test("registration password validation also applies to trailing-slash URLs", () => {
  for (const path of ["/auth/customer/emailpass/register", "/auth/customer/emailpass/register/", "/auth/customer/emailpass/register/?example=1"]) {
    let status = 0;
    const req = { originalUrl: path, body: { email: "customer@example.test", password: "short" } } as unknown as MedusaRequest;
    const res = { status(value: number) { status = value; return this; }, json() {} } as unknown as MedusaResponse;
    validateEmailPass(req, res, () => assert.fail("accepted short registration password"));
    assert.equal(status, 400);
  }
});
