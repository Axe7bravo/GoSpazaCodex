import assert from "node:assert/strict";
import { test } from "node:test";
import { commissionAt, commissionCalculation, commissionDelta, commissionPublication, commissionConfigurationAllowed, discountAttribution } from "../src/modules/marketplace/commission-policy";

const input = { merchandise_net_minor: 10000, merchant_discount_minor: 0, platform_subsidy_minor: 0,
  merchandise_tax_minor: 0, shipping_net_minor: 0, shipping_tax_minor: 0, external_minor: 10000, credit_minor: 0 };
test("M19 merchandise commission is independent of tender and excludes recorded tax/shipping", () => {
  assert.equal(commissionCalculation(input, 1000).commission_minor, 1000);
  assert.equal(commissionCalculation({ ...input, external_minor: 3658, credit_minor: 6342 }, 1000).basis_minor, 10000);
  const taxed = commissionCalculation({ ...input, merchandise_tax_minor: 1500, shipping_net_minor: 2000,
    shipping_tax_minor: 300, external_minor: 13800 }, 1000);
  assert.equal(taxed.basis_minor, 10000); assert.equal(taxed.commission_minor, 1000);
});
test("M19 proven sponsor allocations affect consideration once", () => {
  const allocation = { source_id:"immutable-allocation", net_minor:1000, makes_merchant_whole:true };
  assert.deepEqual(discountAttribution(1000,[{...allocation,sponsor:"MERCHANT"}]),{merchant_discount_minor:1000,platform_subsidy_minor:0});
  assert.deepEqual(discountAttribution(1000,[{...allocation,sponsor:"PLATFORM"}]),{merchant_discount_minor:0,platform_subsidy_minor:1000});
  assert.equal(discountAttribution(1000,[]),null);
  assert.equal(discountAttribution(1000,[{...allocation,sponsor:"PLATFORM",makes_merchant_whole:false}]),null);
  assert.equal(commissionCalculation({ ...input, merchandise_net_minor: 9000,
    merchant_discount_minor: 1000, external_minor: 9000 }, 1000).commission_minor, 900);
  assert.equal(commissionCalculation({ ...input, merchandise_net_minor: 9000,
    platform_subsidy_minor: 1000, external_minor: 9000 }, 1000).commission_minor, 1000);
});
test("M19 odd cents, explicit zero and cumulative reversals", () => {
  assert.equal(commissionAt(105, 1000), 11);
  assert.equal(commissionAt(10000, 0), 0);
  assert.equal(commissionAt(10000, 800), 800);
  assert.equal(commissionAt(668, 1000), 67);
  assert.equal(commissionDelta(1001, 668, 1000), -33);
  assert.equal(commissionDelta(10, 5, 1000) + commissionDelta(5, 0, 1000), commissionDelta(10, 0, 1000));
  assert.equal(commissionAt(Number.MAX_SAFE_INTEGER, 10000), Number.MAX_SAFE_INTEGER);
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => commissionAt(invalid, 1000));
  assert.throws(() => commissionAt(1, 10001));
  assert.throws(() => commissionCalculation({ ...input, credit_minor: 1 }, 1000));
});
test("M19 strict publication and independent configuration grant", () => {
  const valid = { scope: "PLATFORM", decision: "SET", basis_points: 0, expected_revision: 0,
    request_id: "fixture_request", reason: "Initial fixture", confirmed: true };
  assert.ok(commissionPublication.safeParse(valid).success);
  assert.equal(commissionPublication.safeParse({ ...valid, commission_minor: 100 }).success, false);
  assert.equal(commissionPublication.safeParse({ ...valid, decision: "CLEAR" }).success, false);
  assert.equal(commissionPublication.safeParse({ ...valid, actor_id: "forged" }).success, false);
  assert.equal(commissionConfigurationAllowed("viewer", { FINANCIAL_VIEW_USER_IDS: "viewer" }), false);
  assert.equal(commissionConfigurationAllowed("writer", { COMMISSION_CONFIGURE_USER_IDS: "writer" }), true);
});
