import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mayReplayRefund, REFUND_REPLAY_WINDOW_MS, REFUND_REPLAY_SAFETY_MS, refundCommand, refundRequest, type RefundRow, type RefundAttemptRow } from "../src/modules/marketplace/refund-policy";
import { hasFinancialCapability } from "../src/modules/marketplace/financial-policy";
import { YocoRefundTransport } from "../src/modules/yoco/refund-transport";
import { fingerprint } from "../src/modules/yoco/request";
import { verifyYocoInboxEvent } from "../src/modules/yoco/webhook";

test("refund replay window is strictly bounded and uses immutable attempt identity", () => {
  const start = new Date("2026-10-30T00:00:00Z");
  assert.equal(mayReplayRefund(start, new Date(start.getTime() + REFUND_REPLAY_WINDOW_MS - REFUND_REPLAY_SAFETY_MS - 1)), true);
  assert.equal(mayReplayRefund(start, new Date(start.getTime() + REFUND_REPLAY_WINDOW_MS - REFUND_REPLAY_SAFETY_MS)), false);
  assert.equal(mayReplayRefund(start, new Date(start.getTime() + REFUND_REPLAY_WINDOW_MS - 1)), false);
  assert.equal(mayReplayRefund(start, new Date(start.getTime() + REFUND_REPLAY_WINDOW_MS)), false);
  assert.equal(mayReplayRefund(start, new Date(start.getTime() - 1)), false);
  assert.equal(mayReplayRefund("invalid", start), false);
  assert.deepEqual(refundRequest("rfop_a", "rfat_a", 6342), refundRequest("rfop_a", "rfat_a", 6342));
  assert.notEqual(refundRequest("rfop_a", "rfat_a", 6342).fingerprint, refundRequest("rfop_a", "rfat_b", 6342).fingerprint);
  for (const amount of [0, -1, 63.42, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => refundRequest("rfop_a", "rfat_a", amount));
});

test("financial execution is an explicit capability and commands reject mass assignment", () => {
  const env = { FINANCIAL_VIEW_USER_IDS: "viewer", FINANCIAL_EXECUTE_REFUND_USER_IDS: "executor" };
  assert.equal(hasFinancialCapability("viewer", "EXECUTE_REFUND", env), false);
  assert.equal(hasFinancialCapability("executor", "EXECUTE_REFUND", env), true);
  assert.equal(hasFinancialCapability("executor", "VIEW", env), false);
  const command = { action: "EXECUTE", reason: "APPROVED_ADJUSTMENT", confirmed: true };
  assert.equal(refundCommand.safeParse(command).success, true);
  assert.equal(refundCommand.safeParse({ action: "RETRY_NOT_CREATED", reason: "RETRY_CONFIRMED_NOT_CREATED", confirmed: true }).success, false);
  assert.equal(refundCommand.safeParse({ action: "RETRY_NOT_CREATED", reason: "RETRY_CONFIRMED_NOT_CREATED", confirmed: true, expected_attempt_number: 1 }).success, true);
  for (const key of ["amount_minor", "currency", "checkout_id", "payment_id", "customer_id", "merchant_id", "idempotency_key", "status"])
    assert.equal(refundCommand.safeParse({ ...command, [key]: "forged" }).success, false);
});

test("signed refund preserves operation-specific identity and rejects invalid/stale envelopes", () => {
  const key = Buffer.alloc(32, 7), secret = "whsec_" + key.toString("base64"), now = 1793318400000;
  const body = { id: "evt_a", type: "refund.succeeded", payload: { id: "rfd_a", paymentId: "pmt_a", type: "refund", status: "succeeded",
    amount: 6342, currency: "ZAR", mode: "test", metadata: { checkoutId: "ch_a", gospazaRefundOperationId: "rfop_a", gospazaRefundAttemptId: "rfat_a" } } };
  const rawData = JSON.stringify(body), timestamp = String(now / 1000);
  const headers = { "webhook-id": "wh_a", "webhook-timestamp": timestamp,
    "webhook-signature": "v1," + createHmac("sha256", key).update("wh_a." + timestamp + "." + rawData).digest("base64") };
  const event = verifyYocoInboxEvent({ rawData, headers, data: {} }, secret, now);
  assert.deepEqual(event, { id: "evt_a", type: "refund.succeeded", refundId: "rfd_a", paymentId: "pmt_a", checkoutId: "ch_a",
    refundOperationId: "rfop_a", refundAttemptId: "rfat_a", amount: 6342, currency: "ZAR", mode: "test" });
  assert.throws(() => verifyYocoInboxEvent({ rawData: rawData + " ", headers, data: {} }, secret, now));
  assert.throws(() => verifyYocoInboxEvent({ rawData, headers, data: {} }, secret, now + 181000));
});

test("refund transport sends identical integer-cent requests; 202 is pending and network failure is unknown", async () => {
  const values = { YOCO_ENABLED: "true", APP_ENV: "test", YOCO_SECRET_KEY: "sk_test_refund_fixture",
    YOCO_WEBHOOK_SECRET: "whsec_" + Buffer.alloc(32, 7).toString("base64"), YOCO_SUCCESS_URL: "http://localhost:3000/checkout/return",
    YOCO_CANCEL_URL: "http://localhost:3000/checkout/return", YOCO_FAILURE_URL: "http://localhost:3000/checkout/return", YOCO_RETURN_ORIGINS: "http://localhost:3000" };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try {
    const request = refundRequest("rfop_a", "rfat_a", 6342);
    // Transport consumes only these frozen fields; domain-row construction is
    // exercised by the real database verifier rather than fabricated here.
    const row = { checkout_id: "ch_a", mode: "test", account_fingerprint: fingerprint(values.YOCO_SECRET_KEY) } as RefundRow;
    const attempt = { idempotency_key: "gospaza_rfat_a", request_json: request.json, request_fingerprint: request.fingerprint, first_sent_at: new Date(Date.now() - 1000) } as RefundAttemptRow;
    const sent: string[] = [];
    const transport = new YocoRefundTransport(async (url, init) => {
      assert.equal(String(url), "https://payments.yoco.com/api/checkouts/ch_a/refund");
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), attempt.idempotency_key);
      sent.push(String(init?.body));
      return Response.json({ refundId: "rfd_a", status: "pending" }, { status: 202 });
    });
    assert.deepEqual(await transport.send(row, attempt), { kind: "ACCEPTED", refundId: "rfd_a", status: 202 });
    await transport.send(row, attempt);
    assert.deepEqual(sent, [request.json, request.json]);
    assert.equal(JSON.parse(sent[0] ?? "{}").amount, 6342);
    assert.deepEqual(await new YocoRefundTransport(async () => { throw new Error("response lost"); }).send(row, attempt), { kind: "UNKNOWN" });
    assert.deepEqual(await new YocoRefundTransport(async () => Response.json({ code: "invalid_request" }, { status: 400 })).send(row, attempt), { kind: "NOT_CREATED", status: 400 });
    assert.deepEqual(await new YocoRefundTransport(async () => Response.json({ code: "idempotency_mismatch" }, { status: 422 })).send(row, attempt), { kind: "UNKNOWN" });
    assert.deepEqual(await new YocoRefundTransport(async () => new Response("<html>gateway failure</html>", { status: 502 })).send(row, attempt), { kind: "UNKNOWN" });
    assert.deepEqual(await new YocoRefundTransport(async () => Response.json({ refundId: "rfd_a", status: "succeeded" }, { status: 200 })).send(row, attempt), { kind: "UNKNOWN" });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
