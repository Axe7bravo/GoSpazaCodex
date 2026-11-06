import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { POST } from "../src/api/admin/gospaza/operations/deliveries/[id]/rescue/route";
test("M23-C rejects unknown request fields before workflow/domain persistence", async () => {
  const keys = ["DELIVERY_OPERATIONS_VIEW_USER_IDS", "DELIVERY_RESCUE_USER_IDS"] as const, saved = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = "operator";
  let status = 200, domainCalls = 0;
  const scope = { resolve(name: string) {
    if (name === Modules.AUTH) return { retrieveAuthIdentity: async () => ({ app_metadata: { user_id: "operator" } }) };
    if (name === Modules.USER) return { retrieveUser: async () => ({ id: "operator" }) };
    domainCalls++; throw Error("Invalid request must not reach workflow or domain dependencies");
  } };
  const req = { scope, auth_context: { actor_type: "user", actor_id: "operator", auth_identity_id: "identity" }, params: { id: "delivery_a" }, query: {},
    body: { request_id: "request_a", expected_revision: 2, expected_generation: 1, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true, unknown_private_field: "private_sentinel" } } as unknown as AuthenticatedMedusaRequest;
  const res = { setHeader: () => undefined, status(value: number) { status = value; return this; }, json(value: unknown) { assert.doesNotMatch(JSON.stringify(value), /private_sentinel/); return this; } } as unknown as MedusaResponse;
  try { await POST(req, res); assert.equal(status, 400); assert.equal(domainCalls, 0); }
  finally { keys.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});
