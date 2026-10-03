import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDeliverySynchronized, policyInput, resolveDeliveryAssignment, schedulingDefaults, slotInput } from "../src/modules/marketplace/scheduling-policy";
import { minorPrice, nativePrice } from "../src/modules/marketplace/catalogue-policy";

const assignment = { id: "a", priority: 0, delivery_fee_minor: 2599, currency_code: "zar", asap_enabled: true, scheduled_enabled: true };
test("highest assignment priority controls delivery; input order and cheapest price do not", () => {
  const other = { ...assignment, id: "b", priority: 3, delivery_fee_minor: 3999 };
  assert.equal(resolveDeliveryAssignment([assignment, other])?.id, "b");
  assert.equal(resolveDeliveryAssignment([other, assignment])?.id, "b");
  assert.equal(resolveDeliveryAssignment([]), null);
});
test("conflicting equal highest priorities fail closed; equivalent ties are stable", () => {
  for (const change of [{ delivery_fee_minor: 2600 }, { asap_enabled: false }, { scheduled_enabled: false }]) {
    assert.throws(() => resolveDeliveryAssignment([assignment, { ...assignment, id: "b", ...change }]), /DELIVERY_ZONE_AMBIGUOUS/);
  }
  assert.equal(resolveDeliveryAssignment([{ ...assignment, id: "b" }, assignment])?.id, "a");
  assert.equal(resolveDeliveryAssignment([assignment, { ...assignment, id: "b" }])?.id, "a");
});
test("policy defaults are configurable; invalid timezone and forged policy fields fail", () => {
  const result = policyInput.parse({ enabled: true, asap_enabled: true, scheduled_enabled: false });
  assert.equal(result.timezone, schedulingDefaults.timezone);
  assert.equal(result.hold_minutes, 15);
  assert.equal(result.booking_horizon_days, 7);
  assert.equal(result.minimum_lead_minutes, 60);
  assert.equal(policyInput.parse({ ...result, hold_minutes: 10 }).hold_minutes, 10);
  assert.equal(policyInput.safeParse({ ...result, timezone: "Browser/Local" }).success, false);
  assert.equal(policyInput.safeParse({ ...result, fee_minor: 1 }).success, false);
  assert.equal(policyInput.safeParse({ ...result, hold_minutes: 0 }).success, false);
});
test("slots require explicit UTC, integer positive capacity and ordered cutoff/window", () => {
  const slot = { start_at: "2026-10-01T12:00:00Z", end_at: "2026-10-01T13:00:00Z", booking_cutoff_at: "2026-10-01T11:00:00Z", capacity: 2, enabled: true };
  assert.equal(slotInput.safeParse(slot).success, true);
  for (const change of [{ capacity: 0 }, { capacity: 1.5 }, { end_at: slot.start_at },
    { booking_cutoff_at: slot.end_at }, { start_at: "2026-10-01T12:00:00" }]) {
    assert.equal(slotInput.safeParse({ ...slot, ...change }).success, false);
  }
});
test("native revision and price must match published Marketplace configuration", () => {
  const config = { revision: 3, synced_revision: 3, sync_state: "READY", medusa_shipping_option_id: "so_fixture" };
  assertDeliverySynchronized(config, 3, "25.99", 2599);
  for (const change of [{ synced_revision: 2 }, { sync_state: "PENDING" }, { sync_state: "FAILED" }, { medusa_shipping_option_id: null }]) {
    assert.throws(() => assertDeliverySynchronized({ ...config, ...change }, 3, "25.99", 2599), /STALE/);
  }
  assert.throws(() => assertDeliverySynchronized(config, 2, "25.99", 2599), /STALE/);
  assert.throws(() => assertDeliverySynchronized(config, 3, "26.00", 2599), /STALE/);
  assert.throws(() => assertDeliverySynchronized(config, 3, "25.999", 2599));
});
test("shipping workflow number inputs round-trip the existing minor-unit boundary", () => {
  for (const cents of [0, 1, 2599, 2147483647]) assert.equal(minorPrice(Number(nativePrice(cents))), cents);
  assert.throws(() => nativePrice(25.99));
  assert.throws(() => nativePrice(-1));
});
