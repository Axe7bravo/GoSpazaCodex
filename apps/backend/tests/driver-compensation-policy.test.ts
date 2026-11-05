import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { compensationActivation, compensationAllowed, compensationPublication, compensationState } from "../src/modules/marketplace/driver-compensation-policy";
import { driverCompensationHandler } from "../src/lib/driver-compensation-http";

const input = { request_id: "m21_request", expected_revision: 0, confirmed: true, reason: "Explicit synthetic rate", amount_minor: 5000, currency: "zar" };
test("M21-B only permits explicit positive flat ZAR terms and strict prospective decision shapes", () => {
  assert.equal(compensationPublication.safeParse(input).success, true);
  for (const amount_minor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(compensationPublication.safeParse({ ...input, amount_minor }).success, false);
  for (const extra of [{ payer: "MERCHANT" }, { driver_profile_id: "foreign" }, { currency: "usd" }, { scope: "ZONE" }, { confirmed: false }, { recorded_at: "2026-11-05T00:00:00Z" }])
    assert.equal(compensationPublication.safeParse({ ...input, ...extra }).success, false);
  assert.equal(compensationPublication.safeParse({ ...input, effective_at: "2026-11-20T00:00:00.1234Z" }).success, false);
  assert.equal(compensationActivation.safeParse({ request_id: "activation", expected_revision: 0, confirmed: true, reason: "Prospective activation" }).success, true);
  assert.equal(compensationActivation.safeParse(input).success, false);
});
test("M21-B distinguishes inactive, missing and known non-payable resolutions", () => {
  assert.equal(compensationState("PLATFORM", false, true), "HISTORICAL_PREACTIVATION");
  assert.equal(compensationState("PLATFORM", true, false), "MISSING_COMPENSATION_TERMS");
  assert.equal(compensationState("PLATFORM", true, true), "RESOLVED_GOSPAZA_PAYABLE");
  assert.equal(compensationState("MERCHANT", true, false), "RESOLVED_NON_GOSPAZA_PAYABLE");
});
test("M21-B management is explicit and unrelated finance grants grant nothing", () => {
  const env = { DRIVER_COMPENSATION_MANAGE_USER_IDS: " manager ", DRIVER_EARNINGS_VIEW_USER_IDS: "viewer",
    FINANCIAL_VIEW_USER_IDS: "financial", COMMISSION_CONFIGURE_USER_IDS: "commission", SETTLEMENT_APPROVE_USER_IDS: "settlement" };
  assert.equal(compensationAllowed("manager", true, env), true);
  assert.equal(compensationAllowed("viewer", false, env), true);
  assert.equal(compensationAllowed("viewer", true, env), false);
  for (const actor of ["financial", "commission", "settlement", "", "operational_admin"]) assert.equal(compensationAllowed(actor, true, env), false);
  assert.equal(compensationAllowed("manager", true, { ...env, DRIVER_COMPENSATION_MANAGE_USER_IDS: "" }), false);
});
test("M21-B denies non-platform actors before resolving services or known commitment IDs", async () => {
  for (const actor_type of ["merchant", "driver", "customer", undefined]) for (const action of ["history", "publish", "activate", "resolution"] as const) {
    let status = 0;
    const res = { setHeader: () => undefined, status: (code: number) => { status = code; return res; }, json: () => undefined };
    await driverCompensationHandler(action)({ auth_context: { actor_type, actor_id: "known_id" } } as unknown as MedusaRequest, res as unknown as MedusaResponse);
    assert.equal(status, 401);
  }
});
