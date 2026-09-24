import assert from "node:assert/strict";
import { test } from "node:test";
import { backendEnv } from "@gospaza/config/env";
import { backendTestEnv } from "@gospaza/test-utils";

test("backend accepts isolated test configuration", () => {
  assert.equal(backendEnv(backendTestEnv()).appEnv, "test");
});
test("missing or unsafe settings fail without disclosing values", () => {
  for (const key of ["DATABASE_URL", "REDIS_URL", "BACKEND_URL", "JWT_SECRET", "COOKIE_SECRET", "STORE_CORS", "ADMIN_CORS", "AUTH_CORS"]) {
    const env = backendTestEnv();
    delete env[key];
    assert.throws(() => backendEnv(env), new RegExp(key));
  }
  assert.throws(() => backendEnv({ ...backendTestEnv(), JWT_SECRET: "short" }), /JWT_SECRET/);
  assert.throws(() => backendEnv({ ...backendTestEnv(), STORE_CORS: "*" }));
  assert.throws(() => backendEnv({ ...backendTestEnv(), DATABASE_URL: "postgres://user:secret@localhost/gospaza" }), /_test/);
  assert.throws(() => backendEnv({ ...backendTestEnv(), REDIS_URL: "redis://localhost:6379/0" }), /database/);
});

test("backend defaults to shared mode with Medusa Admin enabled", () => {
  const env = backendTestEnv();
  delete env.MEDUSA_WORKER_MODE;
  delete env.DISABLE_MEDUSA_ADMIN;
  const parsed = backendEnv(env);
  assert.equal(parsed.workerMode, "shared");
  assert.equal(parsed.disableMedusaAdmin, false);
});

test("backend accepts every worker mode and both explicit admin settings", () => {
  for (const workerMode of ["shared", "server", "worker"]) {
    for (const disableAdmin of ["true", "false"]) {
      const parsed = backendEnv({
        ...backendTestEnv(),
        MEDUSA_WORKER_MODE: workerMode,
        DISABLE_MEDUSA_ADMIN: disableAdmin,
      });
      assert.equal(parsed.workerMode, workerMode);
      assert.equal(parsed.disableMedusaAdmin, disableAdmin === "true");
    }
  }
});

test("backend rejects invalid worker modes and admin flags clearly", () => {
  for (const value of ["", " ", "invalid", "SERVER", "shared | server | worker"]) {
    assert.throws(() => backendEnv({ ...backendTestEnv(), MEDUSA_WORKER_MODE: value }),
      /Invalid MEDUSA_WORKER_MODE: expected shared, server, or worker/);
  }
  for (const value of ["", " ", "TRUE", "1", "yes"]) {
    assert.throws(() => backendEnv({ ...backendTestEnv(), DISABLE_MEDUSA_ADMIN: value }),
      /Invalid DISABLE_MEDUSA_ADMIN: expected true or false/);
  }
});
