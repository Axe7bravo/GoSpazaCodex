import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { driverPaymentAllowed, driverPaymentCanReconcile, driverPaymentEvidenceValid, driverPaymentSelection,
  driverPaymentTotal, nonpaymentDriverPayment, recordDriverPayment, type PayableDriverEarning } from "../src/modules/marketplace/driver-payment-policy";
import { driverPaymentHandler } from "../src/lib/driver-payment-http";

const earning: PayableDriverEarning = { id: "earning_a", driver_profile_id: "driver_a", payer: "GOSPAZA", currency: "zar",
  amount_minor: "5000", economic_at: "2026-01-01T00:00:00Z", recorded_at: "2026-01-02T00:00:00Z" };
const pair = [earning, { ...earning, id: "earning_b" }];
const decision = { request_id: "request_a", confirmed: true, reason: "Reviewed evidence" };
const evidence = { ...decision, earning_ids: ["earning_b", "earning_a"], amount_minor: 10000, currency: "zar",
  beneficiary_reference: "verified:driver-a", channel: "BANK_TRANSFER", origin_reference: "origin:a", external_transfer_id: "bank:a",
  transferred_at: "2026-01-03T00:00:00+02:00", evidence_reference: "evidence:a" };
test("M21-D whole earnings use exact integer cents; mixed identity/currency/payer and duplicate rows fail", () => {
  assert.equal(driverPaymentTotal(pair), 10000);
  for (const change of [{ driver_profile_id: "other" }, { payer: "MERCHANT" }, { currency: "usd" }, { amount_minor: "0" }, { amount_minor: "1.2" }])
    assert.throws(() => driverPaymentTotal([earning, { ...earning, id: "earning_b", ...change }]));
  assert.throws(() => driverPaymentTotal([]));
  assert.throws(() => driverPaymentTotal([earning, earning]));
  assert.throws(() => driverPaymentTotal([{ ...earning, amount_minor: "9007199254740991" }, { ...earning, id: "b" }]));
});
test("M21-D observed partial/excess amounts and pre-earning/future timestamps cannot prove payment", () => {
  for (const amount of [7500, 12500]) assert.equal(driverPaymentEvidenceValid(pair, amount, "zar", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"), false);
  assert.equal(driverPaymentEvidenceValid(pair, 10000, "zar", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"), true);
  for (const at of ["invalid", "2025-12-31T00:00:00Z", "2099-01-01T00:00:00Z"])
    assert.equal(driverPaymentEvidenceValid(pair, 10000, "zar", at, "2026-01-04T00:00:00Z"), false);
  assert.equal(driverPaymentEvidenceValid(pair, 10000, "usd", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"), false);
});
test("M21-D strict transfer identity, selection canonicalization and mass assignment rejection", () => {
  const parsed = recordDriverPayment.parse(evidence);
  assert.deepEqual(parsed.earning_ids, ["earning_a", "earning_b"]);
  assert.equal(parsed.transferred_at, "2026-01-02T22:00:00.000Z");
  assert.equal(driverPaymentSelection.safeParse(["earning_a", "earning_a"]).success, false);
  for (const change of [{ external_transfer_id: "" }, { origin_reference: " " }, { channel: "CASH" }, { driver_profile_id: "forged" }, { bank_account: "private" }])
    assert.equal(recordDriverPayment.safeParse({ ...evidence, ...change }).success, false);
});
test("M21-D only authoritative proven nonreceipt can release uncertainty", () => {
  const valid = { ...decision, review_reference: "review:a", evidence_reference: "evidence:a", failure_category: "BANK_REJECTED", nonreceipt_confirmed: true };
  assert.equal(nonpaymentDriverPayment.safeParse(valid).success, true);
  for (const failure_category of ["TIMEOUT", "HTTP_FAILURE", "UNKNOWN", "CANCELLED"])
    assert.equal(nonpaymentDriverPayment.safeParse({ ...valid, failure_category }).success, false);
  assert.equal(nonpaymentDriverPayment.safeParse({ ...valid, nonreceipt_confirmed: false }).success, false);
  assert.equal(driverPaymentCanReconcile(false, false, false), false);
  assert.equal(driverPaymentCanReconcile(true, true, false), false);
  assert.equal(driverPaymentCanReconcile(true, false, true), false);
  assert.equal(driverPaymentCanReconcile(true, false, false), true);
});
test("M21-D record/reconcile/view are independent current grants", () => {
  const env = { DRIVER_PAYMENT_RECORD_USER_IDS: "recorder", DRIVER_PAYMENT_RECONCILE_USER_IDS: "reviewer", DRIVER_EARNINGS_VIEW_USER_IDS: "viewer",
    DRIVER_COMPENSATION_MANAGE_USER_IDS: "manager", SETTLEMENT_PAYOUT_RECORD_USER_IDS: "merchant_finance", FINANCIAL_VIEW_USER_IDS: "finance" };
  assert.equal(driverPaymentAllowed("recorder", "RECORD", env), true);
  assert.equal(driverPaymentAllowed("recorder", "RECONCILE", env), false);
  assert.equal(driverPaymentAllowed("reviewer", "RECONCILE", env), true);
  assert.equal(driverPaymentAllowed("reviewer", "RECORD", env), false);
  assert.equal(driverPaymentAllowed("viewer", "VIEW", env), true);
  for (const actor of ["viewer", "manager", "merchant_finance", "finance", "driver", "customer", "merchant", ""])
    assert.equal(driverPaymentAllowed(actor, "RECORD", env), false);
  assert.equal(driverPaymentAllowed("recorder", "RECORD", { ...env, DRIVER_PAYMENT_RECORD_USER_IDS: "" }), false);
});
test("M21-D every mutation denies non-platform actors before resolving any resource", async () => {
  for (const actor_type of ["driver", "merchant", "customer", undefined]) for (const action of ["RECORD", "UNKNOWN", "CONFIRMED_PAID", "CONFIRMED_NOT_PAID", "RECONCILE", "DISCREPANCY"] as const) {
    let status = 0;
    const response = { setHeader: () => undefined, status: (code: number) => { status = code; return response; }, json: () => undefined };
    await driverPaymentHandler(action)({ auth_context: { actor_type, actor_id: "known" } } as unknown as MedusaRequest, response as unknown as MedusaResponse);
    assert.equal(status, 401);
  }
});
