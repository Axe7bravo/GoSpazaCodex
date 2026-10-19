import test from "node:test";
import assert from "node:assert/strict";
import { merchantDriverActions, driverApprovalEligibility, driverCommand, driverFields, driverParse, lifecycleTransition, persistentEligibility } from "../src/modules/marketplace/driver-policy";
import { capabilitiesFor } from "../src/modules/marketplace/team-policy";

test("driver inputs reject authority and incomplete submission", () => {
  for (const field of ["auth_identity_id", "driver_profile_id", "actor_type", "actor_id", "status", "revision", "reviewed_by", "merchant_id"]) {
    assert.throws(() => driverCommand("EDIT", { expected_revision: 1, display_name: "Fixture", [field]: "forged" }));
  }
  assert.throws(() => driverParse(driverFields, { display_name: "", contact_phone: "" }));
  assert.throws(() => driverCommand("REQUEST", { expected_revision: 1, kind: "PLATFORM", merchant_store_id: "foreign" }));
  assert.throws(() => driverCommand("APPROVE", { expected_revision: 1, confirmed: false, reason: "Fixture" }));
  assert.throws(() => driverCommand("APPROVE", { expected_revision: 1, confirmed: true, reason: " " }));
});
test("driver lifecycle is explicit and deactivation terminal", () => {
  assert.equal(lifecycleTransition("INCOMPLETE", "SUBMIT"), "PENDING_REVIEW");
  assert.equal(lifecycleTransition("PENDING_REVIEW", "REQUIRE_CHANGES"), "CHANGES_REQUIRED");
  assert.equal(lifecycleTransition("CHANGES_REQUIRED", "SUBMIT"), "PENDING_REVIEW");
  assert.equal(lifecycleTransition("PENDING_REVIEW", "APPROVE"), "ACTIVE");
  assert.equal(lifecycleTransition("ACTIVE", "SUSPEND"), "SUSPENDED");
  assert.equal(lifecycleTransition("SUSPENDED", "REACTIVATE"), "ACTIVE");
  for (const action of ["APPROVE", "REACTIVATE", "SUBMIT", "SUSPEND"] as const) assert.throws(() => lifecycleTransition("DEACTIVATED", action));
  assert.throws(() => lifecycleTransition("INCOMPLETE", "APPROVE"));
});
test("persistent eligibility never infers a platform grant from missing affiliation", () => {
  const profile = { status: "ACTIVE" } as const;
  const target = { id: "store", merchant_id: "merchant" };
  const platform = { kind: "PLATFORM", status: "ACTIVE", merchant_id: null, merchant_store_id: null } as const;
  assert.equal(persistentEligibility(profile, platform, target, true).eligible, true);
  assert.equal(persistentEligibility(profile, null, target, true).eligible, false);
  assert.equal(persistentEligibility(profile, platform, target, false).eligible, false);
  assert.equal(persistentEligibility(profile, platform, null, true).eligible, false);
  for (const status of ["INCOMPLETE", "PENDING_REVIEW", "CHANGES_REQUIRED", "SUSPENDED", "DEACTIVATED"] as const) assert.equal(persistentEligibility({ status }, platform, target, true).eligible, false);
  for (const status of ["REQUESTED", "ENDORSED", "REJECTED", "REVOKED"] as const) assert.equal(persistentEligibility(profile, { ...platform, status }, target, true).eligible, false);
  const merchant = { ...platform, kind: "MERCHANT", merchant_id: "merchant", merchant_store_id: "store" } as const;
  assert.equal(persistentEligibility(profile, merchant, target, true).eligible, true);
  assert.equal(persistentEligibility(profile, merchant, { ...target, id: "foreign" }, true).eligible, false);
});
test("driver tenant capabilities exclude pickers and retain owner/manager access", () => {
  for (const role of ["OWNER", "MANAGER"] as const) {
    assert.ok(capabilitiesFor(role).includes("MERCHANT_DRIVER_VIEW"));
    assert.ok(capabilitiesFor(role).includes("MERCHANT_DRIVER_AFFILIATION_MANAGE"));
  }
  assert.ok(!capabilitiesFor("PICKER").includes("MERCHANT_DRIVER_VIEW"));
  assert.ok(!capabilitiesFor("PICKER").includes("MERCHANT_DRIVER_AFFILIATION_MANAGE"));
});

test("account approval summary shares eligibility gates without granting a target-store assignment", () => {
  const active = { status: "ACTIVE" } as const;
  assert.deepEqual(driverApprovalEligibility(active, active, true), { eligible: true, reason: "ELIGIBLE" });
  assert.equal(driverApprovalEligibility(active, null, true).eligible, false);
  assert.equal(driverApprovalEligibility(active, active, false).eligible, false);
  assert.equal(driverApprovalEligibility({ status: "SUSPENDED" }, active, true).eligible, false);
  assert.equal(driverApprovalEligibility(active, { status: "REVOKED" }, true).eligible, false);
  assert.equal(persistentEligibility(active, { ...active, kind: "PLATFORM", merchant_id: null, merchant_store_id: null }, null, true).eligible, false);
});

test("merchant action projection matches suspension and terminal lifecycle guards", () => {
  const request = { kind: "MERCHANT", status: "REQUESTED" } as const;
  assert.deepEqual(merchantDriverActions({ status: "INCOMPLETE" }, request), ["endorse", "decline"]);
  assert.deepEqual(merchantDriverActions({ status: "SUSPENDED" }, request), ["decline"]);
  assert.deepEqual(merchantDriverActions({ status: "DEACTIVATED" }, request), []);
  assert.deepEqual(merchantDriverActions({ status: "ACTIVE" }, { ...request, status: "ACTIVE" }), ["revoke"]);
  assert.deepEqual(merchantDriverActions({ status: "ACTIVE" }, { kind: "PLATFORM", status: "ACTIVE" }), []);
});
