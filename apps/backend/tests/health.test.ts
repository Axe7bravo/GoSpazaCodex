import assert from "node:assert/strict";
import { test } from "node:test";
import { readiness } from "../src/lib/health";
import { GET } from "../src/api/health/live/route";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

test("liveness returns 200 and disables caching without checking dependencies", async () => {
  let status = 0;
  let body: unknown;
  const headers: Record<string, string> = {};
  const response = {
    setHeader(key: string, value: string) { headers[key] = value; },
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; },
  };
  await GET({} as MedusaRequest, response as unknown as MedusaResponse);
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
  assert.equal(headers["Cache-Control"], "no-store");
});

test("readiness requires both dependencies", async () => {
  const ok = async () => undefined;
  const fail = async () => { throw new Error("secret-connection-string"); };
  assert.equal((await readiness(ok, ok)).statusCode, 200);
  for (const [pg, redis] of [[fail, ok], [ok, fail], [fail, fail]] as const) {
    const result = await readiness(pg, redis);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.status, "unavailable");
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});
