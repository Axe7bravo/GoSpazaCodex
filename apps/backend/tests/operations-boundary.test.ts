import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { OperationsService } from "../src/lib/operations-service";
import { currentPlatform } from "../src/lib/platform-access";

test("M23-B unauthorized sections and lookups are denied before a domain query", async () => {
  const key = "ORDER_OPERATIONS_VIEW_USER_IDS", original = process.env[key]; process.env[key] = "scoped_operator";
  let queries = 0;
  // Unit module-boundary stub only. The separate verifier uses real native
  // users, sessions, PostgreSQL, request scopes and HTTP routes.
  const container = { resolve(name: string) {
    if (name === ContainerRegistrationKeys.PG_CONNECTION) return () => { queries++; throw Error("Forbidden domain queried."); };
    if (name === Modules.USER) return { retrieveUser: async () => ({ id: "scoped_operator" }) };
    throw Error("Unexpected dependency.");
  } } as unknown as MedusaContainer;
  const forbidden = (e: unknown) => MedusaError.isMedusaError(e) && e.type === MedusaError.Types.FORBIDDEN;
  try {
    const service = new OperationsService(container);
    await assert.rejects(service.delivery("scoped_operator", "known_delivery"), forbidden);
    await assert.rejects(service.attention("scoped_operator", "driver_payments", {}), forbidden);
    await assert.rejects(service.lookup("scoped_operator", { type: "DRIVER_PAYMENT", id: "known_payment" }), forbidden);
    assert.equal(queries, 0);
    process.env[key] = ""; await assert.rejects(service.order("scoped_operator", "known_order"), forbidden); assert.equal(queries, 0);
  } finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
});
test("M23-B current platform identity cannot be forged from actor ID alone", async () => {
  const container = { resolve(name: string) {
    if (name === Modules.AUTH) return { retrieveAuthIdentity: async () => ({ app_metadata: { user_id: "actual_user" } }) };
    if (name === Modules.USER) return { retrieveUser: async (id: string) => ({ id }) };
    throw Error("Unexpected dependency.");
  } } as unknown as MedusaContainer;
  await assert.rejects(currentPlatform(container, { actor_type: "merchant", actor_id: "actual_user", auth_identity_id: "identity" }));
  await assert.rejects(currentPlatform(container, { actor_type: "user", actor_id: "forged_user", auth_identity_id: "identity" }));
  assert.equal(await currentPlatform(container, { actor_type: "user", actor_id: "actual_user", auth_identity_id: "identity" }), "actual_user");
});
