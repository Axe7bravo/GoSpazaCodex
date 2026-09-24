import assert from "node:assert/strict";

// Integration smoke: run against actual started processes and PostgreSQL/Redis.
const backend = process.env.SMOKE_BACKEND_URL || "http://localhost:9000";
for (const [path, expected] of [
  ["/health/live", { status: "ok" }],
  ["/health/ready", { status: "ready", dependencies: { postgres: "up", redis: "up" } }],
]) {
  const response = await fetch(new URL(path, backend), { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(await response.json(), expected);
}
for (const [app, port, title] of [
  ["customer", 3000, "Customer app"],
  ["merchant", 3001, "Merchant and picker portal"],
  ["driver", 3002, "Driver app"],
  ["admin", 3003, "Platform admin portal"],
]) {
  const url = process.env["SMOKE_" + app.toUpperCase() + "_URL"] || "http://localhost:" + port;
  const response = await fetch(new URL("/login", url), { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, app);
  const html = await response.text();
  assert.ok(html.includes(title.replace(" app", "").replace(" portal", "")), app + " title missing");
  assert.ok(html.includes("Checking your session"), app + " session-loading shell missing");
}
console.log("M1 smoke passed: backend liveness/readiness and all four login shells.");
