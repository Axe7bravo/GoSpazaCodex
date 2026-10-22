import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchPolicy, dispatchLocationInput, dispatchConfigurationInput, dispatchRevision,
  dispatchNotBefore, dispatchTimeReady, offerExpiry, initialPath, pathAllowed, locationFresh } from "../src/modules/marketplace/dispatch-policy";
import { accounted } from "../src/modules/marketplace/shortage-policy";

test("approved dispatch timing is centralized and invalid configuration fails fast", () => {
  const p = dispatchPolicy({});
  assert.deepEqual(p, { freshnessMs: 120000, offerMs: 30000, merchantPhaseMs: 120000, searchMs: 300000, leadMs: 1800000 });
  assert.throws(() => dispatchPolicy({ DISPATCH_OFFER_SECONDS: "0" }));
  assert.throws(() => dispatchPolicy({ DISPATCH_SEARCH_SECONDS: "NaN" }));
  assert.throws(() => dispatchPolicy({ DISPATCH_LOCATION_FRESHNESS_SECONDS: "" }));
});
test("ASAP has no scheduled gate; scheduled uses the configured lead, not slot expiry", () => {
  const p = dispatchPolicy({}), start = new Date("2026-10-19T12:00:00Z");
  assert.equal(dispatchNotBefore("ASAP", start, p), null);
  assert.equal(dispatchNotBefore("SCHEDULED", start, p)?.toISOString(), "2026-10-19T11:30:00.000Z");
  assert.equal(dispatchNotBefore("SCHEDULED", start, { ...p, leadMs: 0 })?.getTime(), start.getTime());
  const boundary = dispatchNotBefore("SCHEDULED", start, p); assert.ok(boundary);
  assert.equal(dispatchTimeReady(boundary, new Date(boundary.getTime() - 1)), false);
  assert.equal(dispatchTimeReady(boundary, boundary), true);
  assert.equal(dispatchTimeReady(boundary, new Date(boundary.getTime() + 1)), true);
  assert.equal(dispatchTimeReady(null, new Date(0)), true);
});
test("offer expiry cannot exceed merchant phase or generation; freshness uses server age", () => {
  const now = new Date(1000000), p = dispatchPolicy({});
  assert.equal(offerExpiry(now, new Date(1010000), null, p.offerMs).getTime(), 1010000);
  assert.equal(offerExpiry(now, new Date(1300000), new Date(1005000), p.offerMs).getTime(), 1005000);
  assert.equal(offerExpiry(now, new Date(1300000), now, p.offerMs).getTime(), now.getTime(), "phase boundary cannot produce a positive offer lifetime");
  assert.equal(offerExpiry(now, now, null, p.offerMs).getTime(), now.getTime(), "generation boundary cannot produce a positive offer lifetime");
  assert.equal(locationFresh(now.getTime() - 119999, now, p), true);
  assert.equal(locationFresh(now.getTime() - 120000, now, p), false);
  assert.equal(locationFresh(now.getTime() + 1, now, p), false);
});
test("mode admission never crosses exclusive pools or enables unconfigured dispatch", () => {
  assert.throws(() => initialPath("DISABLED"));
  assert.equal(initialPath("HYBRID"), "MERCHANT");
  assert.equal(initialPath("PLATFORM_ONLY"), "PLATFORM");
  assert.equal(pathAllowed("MERCHANT_ONLY", "PLATFORM"), false);
  assert.equal(pathAllowed("PLATFORM_ONLY", "MERCHANT"), false);
  assert.equal(pathAllowed("DISABLED", "MERCHANT"), false);
});
test("location and decision bodies reject hostile authority and timestamps", () => {
  const sample = { generation: "dgen_fixture", sequence: 1, latitude: -29.1, longitude: 26.2 };
  assert.equal(dispatchLocationInput.safeParse(sample).success, true);
  for (const patch of [{ latitude: 91 }, { longitude: -181 }, { latitude: NaN }, { sequence: 0 },
    { driver_id: "foreign" }, { recorded_at: Date.now() }, { merchant_id: "foreign" }, { mode: "HYBRID" }]) {
    assert.equal(dispatchLocationInput.safeParse({ ...sample, ...patch }).success, false);
  }
  assert.equal(dispatchRevision.safeParse({ expected_revision: 1, status: "ASSIGNED" }).success, false);
  assert.equal(dispatchConfigurationInput.safeParse({ expected_revision: 0, mode: "HYBRID", reason: "approved", driver_id: "foreign" }).success, false);
});
test("M13 terminal omissions remain valid physical completion without financial resolution", () => {
  assert.equal(accounted(5, 3, 2), true);
  assert.equal(accounted(5, 0, 5), true);
  assert.equal(accounted(5, 3, 1), false);
});
