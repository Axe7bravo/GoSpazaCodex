import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requestLogging } from "../src/lib/request-logging";

test("logging generates correlation IDs and excludes sensitive request data", (context) => {
  const lines: string[] = [];
  context.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  const headers: Record<string, string> = {};
  const response = Object.assign(new EventEmitter(), {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    setHeader(key: string, value: string) { headers[key] = value; },
  });
  let continued = false;
  const request = {
    method: "GET",
    headers: { authorization: "secret-token", "x-request-id": "untrusted-id" },
    originalUrl: "/health/live?token=secret-token",
    body: { password: "secret-password" },
  };
  requestLogging(request as unknown as MedusaRequest, response as unknown as MedusaResponse, () => { continued = true; });
  response.emit("finish");
  assert.ok(continued);
  assert.match(headers["X-Request-ID"]!, /^[0-9a-f-]{36}$/);
  assert.equal(response.locals.requestId, headers["X-Request-ID"]);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.requestId, headers["X-Request-ID"]);
  assert.equal(record.event, "http.request.completed");
  assert.ok(!lines[0]!.includes("secret"));
  assert.ok(!lines[0]!.includes("untrusted-id"));
});

