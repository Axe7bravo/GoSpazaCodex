import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentDeadlineMinutes, yocoConfiguration } from "../src/lib/yoco-config";

test("payment is opt-in and the deadline is a bounded integer", () => {
  assert.equal(yocoConfiguration({}), null);
  assert.equal(paymentDeadlineMinutes({}), 15);
  assert.equal(paymentDeadlineMinutes({ PAYMENT_PENDING_MINUTES: "1" }), 1);
  assert.equal(paymentDeadlineMinutes({ PAYMENT_PENDING_MINUTES: "1440" }), 1440);
  for (const value of ["", "0", "-1", "1.5", " 15", "1441", "Infinity"]) {
    assert.throws(() => paymentDeadlineMinutes({ PAYMENT_PENDING_MINUTES: value }), /PAYMENT_PENDING_MINUTES/);
  }
  for (const value of ["yes", "TRUE", "1", ""]) {
    assert.throws(() => yocoConfiguration({ YOCO_ENABLED: value }), /YOCO_ENABLED/);
  }
});

test("enabled payment needs validated secrets and server-controlled return origins", () => {
  assert.throws(() => yocoConfiguration({ YOCO_ENABLED: "true" }));
  const env = {
    YOCO_ENABLED: "true", YOCO_SECRET_KEY: "sk_test_verification",
    YOCO_WEBHOOK_SECRET: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
    YOCO_SUCCESS_URL: "http://localhost:3000/cart",
    YOCO_CANCEL_URL: "http://localhost:3000/cart",
    YOCO_FAILURE_URL: "http://localhost:3000/cart",
    YOCO_RETURN_ORIGINS: "http://localhost:3000",
  };
  assert.ok(yocoConfiguration(env));
  assert.throws(() => yocoConfiguration({ ...env, YOCO_SUCCESS_URL: "https://evil.test/return" }));
  assert.throws(() => yocoConfiguration({ ...env, YOCO_SECRET_KEY: "sk_live_verification" }));
});

test("production cannot accept test payment authority and retains opt-in configuration", () => {
  const env = {
    APP_ENV: "production", YOCO_ENABLED: "true", YOCO_SECRET_KEY: "sk_test_verification",
    YOCO_WEBHOOK_SECRET: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
    YOCO_SUCCESS_URL: "https://shop.example.test/checkout/return",
    YOCO_CANCEL_URL: "https://shop.example.test/checkout/return",
    YOCO_FAILURE_URL: "https://shop.example.test/checkout/return",
    YOCO_RETURN_ORIGINS: "https://shop.example.test",
  };
  assert.equal(yocoConfiguration({ APP_ENV: "production" }), null);
  assert.equal(yocoConfiguration({ ...env, YOCO_ENABLED: "false" }), null);
  assert.throws(() => yocoConfiguration(env), /Production payments require a live Yoco secret key/);
  assert.ok(yocoConfiguration({ ...env, YOCO_SECRET_KEY: "sk_live_verification" }));
  assert.throws(() => yocoConfiguration({ ...env, YOCO_SECRET_KEY: "sk_live_verification", YOCO_WEBHOOK_SECRET: "" }));
  assert.ok(yocoConfiguration({ ...env, APP_ENV: "test" }));
});