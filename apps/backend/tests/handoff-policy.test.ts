import assert from "node:assert/strict";
import test from "node:test";
import { handoffCode, handoffSecret, handoffGuess, handoffCompliance, matchesHandoff, handoffPolicy } from "../src/modules/marketplace/handoff-policy";
const secret = Buffer.from("5c857bf87a61c42498df8a694a17ab5e408d9169c235ef9031b6d8b925f47e06", "hex");
test("handoff derivation is stable, scoped and compared without numeric coercion", () => {
  const code = handoffCode(secret, "delivery_a", "nonce_a", 1);
  assert.match(code, /^\d{6}$/);
  assert.equal(handoffCode(secret, "delivery_a", "nonce_a", 1), code);
  assert.equal(matchesHandoff(code, code), true);
  for (const wrong of ["", "12345", "1234567", "12e345", " 12345"]) assert.equal(matchesHandoff(code, wrong), false);
  assert.notEqual(handoffCode(secret, "delivery_b", "nonce_a", 1), code);
  assert.notEqual(handoffCode(secret, "delivery_a", "nonce_b", 1), code);
  assert.notEqual(handoffCode(secret, "delivery_a", "nonce_a", 2), code);
});
test("handoff payloads reject authority and dedicated secret configuration fails closed", () => {
  for (const key of ["driver_id", "customer_id", "merchant_id", "fulfillment_id", "delivered", "compliance_satisfied", "attempts", "generation"])
    assert.equal(handoffGuess.safeParse({ expected_revision: 1, code: "123456", [key]: true }).success, false);
  for (const HANDOFF_OTP_SECRET of [undefined, "", "test", "a".repeat(64)]) assert.throws(() => handoffSecret({ HANDOFF_OTP_SECRET }));
  assert.throws(() => handoffSecret({ HANDOFF_OTP_SECRET: secret.toString("hex"), JWT_SECRET: secret.toString("hex") }));
  assert.deepEqual(handoffSecret({ HANDOFF_OTP_SECRET: secret.toString("hex") }), secret);
  assert.equal(handoffCompliance(true), "REQUIRED"); assert.equal(handoffCompliance(false), "SATISFIED");
  assert.deepEqual(handoffPolicy, { digits: 6, lifetimeMs: 600000, generationFailures: 5, deliveryFailures: 15, generations: 3, cooldownMs: 60000 });
});
