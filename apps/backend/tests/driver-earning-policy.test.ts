import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { driverEarningDisposition, driverEarningEventOrder, driverEarningSourceMatches, driverEarningsView, type DriverEarningEvidence } from "../src/modules/marketplace/driver-earning-policy";
import { driverEarningRead } from "../src/lib/driver-earning-http";

const platformSnapshot = { id: "snapshot_a", state: "RESOLVED_GOSPAZA_PAYABLE", path: "PLATFORM", payer: "GOSPAZA", currency: "zar", amount_minor: "5000" };
const payable: DriverEarningEvidence = { state: "READY", snapshot: platformSnapshot };
test("M21-C uses the exact payable snapshot and never substitutes another financial source", () => {
  assert.deepEqual(driverEarningDisposition(payable), { state: "EARNED", amount_minor: "5000" });
  assert.deepEqual(driverEarningDisposition({ ...payable, snapshot: { id: "merchant_snapshot", state: "RESOLVED_NON_GOSPAZA_PAYABLE", path: "MERCHANT", payer: "NON_GOSPAZA_PAYABLE", currency: "zar", amount_minor: null } }), { state: "NON_GOSPAZA_PAYABLE" });
  for (const amount_minor of [null, "0", "-1", "1.5", "9007199254740992"])
    assert.throws(() => driverEarningDisposition({ ...payable, snapshot: { ...platformSnapshot, amount_minor } }));
});
test("M21-C pending, missing, historical and return evidence cannot produce an ordinary earning", () => {
  for (const source of [{ state: "PENDING" }, { state: "UNRESOLVED", reason: "SNAPSHOT_MISSING" }, { state: "HISTORICAL_REVIEW" },
    { state: "NO_ORDINARY_EARNING", reason: "RESTRICTED_RETURN" }] as DriverEarningEvidence[])
    assert.notEqual(driverEarningDisposition(source).state, "EARNED");
  assert.equal(driverEarningSourceMatches("original", "different"), false);
  assert.equal(driverEarningSourceMatches("original", undefined), false);
  assert.equal(driverEarningSourceMatches("original", "original"), true);
});
test("M21-C event financial fields and compensation/settlement grants grant no earnings authority", () => {
  assert.equal(driverEarningEventOrder({ order_id: "order_real", driver_profile_id: "forged", amount_minor: 1, payer: "forged" }), "order_real");
  assert.equal(driverEarningEventOrder({ amount_minor: 5000 }), null);
  assert.equal(driverEarningEventOrder({ order_id: "../foreign" }), null);
  const env = { DRIVER_EARNINGS_VIEW_USER_IDS: "viewer", DRIVER_COMPENSATION_MANAGE_USER_IDS: "manager", SETTLEMENT_VIEW_USER_IDS: "settlement" };
  assert.equal(driverEarningsView("viewer", env), true);
  for (const actor of ["manager", "settlement", "driver", ""]) assert.equal(driverEarningsView(actor, env), false);
  assert.equal(driverEarningsView("viewer", { ...env, DRIVER_EARNINGS_VIEW_USER_IDS: "" }), false);
});
test("M21-C financial reads deny all other actor classes before resource lookup", async () => {
  for (const actor_type of ["driver", "customer", "merchant", undefined]) {
    let status = 0; const res = { setHeader: () => undefined, status: (s: number) => { status = s; return res; }, json: () => undefined };
    await driverEarningRead({ auth_context: { actor_type, actor_id: "known_id" } } as unknown as MedusaRequest, res as unknown as MedusaResponse);
    assert.equal(status, 401);
  }
});
