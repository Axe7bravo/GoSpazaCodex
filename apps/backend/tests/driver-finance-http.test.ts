import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { driverFinanceHandler } from "../src/lib/driver-finance-http";
test("M21 finance reads reject wrong actor classes before looking up known IDs", async () => {
  for (const actor_type of ["merchant", "customer", undefined]) for (const action of ["own", "own-payments", "own-earning", "own-payment", "earnings", "earning", "payments", "payment", "reviews"] as const) {
    let status = 0;
    const res = { setHeader: () => undefined, status: (code: number) => { status = code; return res; }, json: () => undefined };
    await driverFinanceHandler(action)({ auth_context: { actor_type, actor_id: "foreign", auth_identity_id: "foreign" } } as unknown as MedusaRequest, res as unknown as MedusaResponse);
    assert.equal(status, 401);
  }
});
