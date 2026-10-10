import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BigNumber } from "@medusajs/framework/utils";
import type { InitiatePaymentInput, IPaymentProvider } from "@medusajs/framework/types";
import YocoPaymentService from "../src/modules/yoco/service";
import {
  YocoOperationStore, YocoProviderError, type YocoOperation, type YocoOptions,
  type CheckoutReceipt, type RefundReceipt, type YocoWebhookPayload,
} from "../src/modules/yoco/types";
import { fingerprint, initiationRequest } from "../src/modules/yoco/request";
import { verifyYocoEvent } from "../src/modules/yoco/webhook";

const configuration: YocoOptions = {
  secretKey: "sk_test_contract",
  webhookSecret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
  successUrl: "https://customer.example.test/payment/success",
  cancelUrl: "https://customer.example.test/payment/cancel",
  failureUrl: "https://customer.example.test/payment/failure",
  allowedReturnOrigins: ["https://customer.example.test"],
};
const request: InitiatePaymentInput = {
  amount: "109.99", currency_code: "zar",
  data: { operation_id: "operation_fixture", session_id: "payses_fixture" },
  context: { idempotency_key: "payses_fixture" },
};
const checkout: CheckoutReceipt = {
  id: "ch_fixture", redirectUrl: "https://c.yoco.com/checkout/fixture", status: "created",
  amount: 10999, currency: "ZAR", processingMode: "test",
};
const error = (code: YocoProviderError["code"]) => (value: unknown) =>
  value instanceof YocoProviderError && value.code === code;

/** Contract fixture only. This does not prove production DB atomicity/durability. */
class Operations extends YocoOperationStore {
  record: YocoOperation = {
    id: "operation_fixture", attemptId: "attempt_fixture", sessionIds: ["payses_fixture"], canonicalSessionId: "payses_fixture",
    accountFingerprint: fingerprint(configuration.secretKey),
    requestJson: initiationRequest("operation_fixture", "attempt_fixture", 10999, configuration),
    requestFingerprint: fingerprint(initiationRequest("operation_fixture", "attempt_fixture", 10999, configuration)),
    paymentCollectionId: "paycol_fixture", cartId: "cart_fixture", amountMinor: 10999,
    currency: "ZAR", mode: "test", idempotencyKey: "checkout_operation_fixture", state: "prepared",
  };
  failSave = false;
  permit: string | null = null;
  replay = false;
  financialSession: string | null = null;
  async associateSession(id: string, sessionId: string, token: string | undefined) {
    if (id !== this.record.id) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    if (this.record.sessionIds.includes(sessionId)) return;
    if (!token || token !== this.permit || this.financialSession) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    this.record.sessionIds.push(sessionId);
    this.permit = null;
  }
  async claimAuthorization(id: string, sessionId: string) {
    assert.equal(id, this.record.id);
    if (this.record.terminalRefunded || this.record.canonicalSessionId !== sessionId
      || this.financialSession && this.financialSession !== sessionId) return false;
    this.financialSession = sessionId;
    return true;
  }
  async read(id: string) { return id === this.record.id ? structuredClone(this.record) : null; }
  async claimInitiation(id: string, requestJson: string) {
    assert.equal(id, this.record.id);
    if (this.record.requestJson !== undefined) assert.equal(requestJson, this.record.requestJson);
    if (this.record.state !== "prepared" && !(this.replay && this.record.state === "uncertain")) return false;
    this.replay = false;
    this.record.requestJson = requestJson;
    this.record.state = "sending";
    return true;
  }
  async saveCheckout(id: string, receipt: CheckoutReceipt) {
    assert.equal(id, this.record.id);
    if (this.failSave) throw new Error("Synthetic persistence failure");
    this.record.checkout = receipt;
    this.record.state = "created";
  }
  async markInitiationUncertain(id: string, mismatch = false) {
    assert.equal(id, this.record.id);
    this.record.state = mismatch ? "mismatch" : "uncertain";
  }
  async claimRefund(id: string, refundId: string, requestJson: string) {
    assert.equal(id, this.record.id);
    const refund = this.record.technicalRefund;
    assert.ok(refund);
    assert.equal(refundId, refund.id);
    assert.equal(requestJson, JSON.stringify({ amount: refund.amountMinor }));
    if (refund.state !== "prepared") return false;
    refund.state = "sending";
    return true;
  }
  async saveRefund(id: string, refundId: string, receipt: RefundReceipt) {
    assert.equal(id, this.record.id);
    const refund = this.record.technicalRefund;
    assert.ok(refund);
    assert.equal(refundId, refund.id);
    refund.receipt = receipt;
    refund.state = receipt.status;
  }
  async markRefundUncertain(id: string, refundId: string) {
    assert.equal(id, this.record.id);
    const refund = this.record.technicalRefund;
    assert.ok(refund);
    assert.equal(refundId, refund.id);
    refund.state = "uncertain";
  }
}

function fixture(context: TestContext, response: unknown = checkout) {
  const operations = new Operations();
  const calls: { url: string; init?: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    // A fake HTTP boundary: never communicate with Yoco from contract tests.
    calls.push({ url: String(url), init });
    return Response.json(response);
  });
  const provider = new YocoPaymentService({ yocoOperations: operations }, configuration);
  const contract: IPaymentProvider = provider;
  return { operations, calls, provider, contract };
}

function event(type: "payment.succeeded" | "payment.failed" = "payment.succeeded") {
  return {
    id: "evt_fixture", type, createdDate: "2026-10-03T00:00:00Z",
    payload: {
      id: "pay_fixture", type: "payment", status: type === "payment.succeeded" ? "succeeded" : "failed",
      amount: 10999, currency: "ZAR", mode: "test",
      metadata: { checkoutId: "ch_fixture", session_id: "payses_fixture", operation_id: "operation_fixture" },
    },
  };
}

function signed(body: unknown = event(), seconds = Math.floor(Date.now() / 1000)): YocoWebhookPayload {
  const rawData = JSON.stringify(body);
  const signature = createHmac("sha256", Buffer.alloc(32, 7))
    .update("delivery_fixture." + seconds + "." + rawData).digest("base64");
  return {
    data: { deliberatelyNotTheSignedBody: true }, rawData,
    headers: { "webhook-id": "delivery_fixture", "webhook-timestamp": String(seconds), "webhook-signature": "v1," + signature },
  };
}

async function captured(context: TestContext) {
  const state = fixture(context);
  await state.provider.initiatePayment(request);
  const payment = verifyYocoEvent(signed(), configuration.webhookSecret);
  assert.ok(payment);
  state.operations.record.payment = payment; // Represents a verified, persisted inbox result.
  state.operations.record.technicalRefund = {
    id: "compensation_fixture", idempotencyKey: "refund_payment_fixture", paymentId: "pay_fixture",
    amountMinor: 10999, state: "prepared",
  };
  return state;
}

test("Yoco uses pinned Medusa inputs, exact cents, fixed URLs and distinct session identifiers", async (context) => {
  const { provider, operations, calls } = fixture(context);
  const result = await provider.initiatePayment({
    ...request,
    data: { ...request.data, cart_id: "forged_cart", redirectUrl: "https://evil.test", amount: 1 },
  });
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.ok(sent);
  assert.equal(sent.url, "https://payments.yoco.com/api/checkouts");
  assert.equal(new Headers(sent.init?.headers).get("Idempotency-Key"), "checkout_operation_fixture");
  assert.equal(sent.init?.body, operations.record.requestJson);
  assert.deepEqual(JSON.parse(String(sent.init?.body)), {
    amount: 10999, currency: "ZAR",
    metadata: { operation_id: "operation_fixture", attempt_id: "attempt_fixture" },
    externalId: "operation_fixture", successUrl: configuration.successUrl,
    cancelUrl: configuration.cancelUrl, failureUrl: configuration.failureUrl,
  });
  assert.equal(result.id, "ch_fixture");
  assert.equal(result.status, "pending");
  assert.deepEqual(result.data, {
    operation_id: "operation_fixture", attempt_id: "attempt_fixture", session_id: "payses_fixture",
    payment_collection_id: "paycol_fixture", cart_id: "cart_fixture", yocoCheckoutId: "ch_fixture",
    redirectUrl: checkout.redirectUrl, yocoPaymentId: undefined,
  });
});

test("native number, BigNumber and raw amount representations convert once", async (context) => {
  const { provider, calls } = fixture(context);
  for (const amount of [109.99, "109.99", new BigNumber("109.99"), { value: "109.99", precision: 20 }]) {
    await provider.initiatePayment({ ...request, amount });
  }
  assert.equal(calls.length, 1);
  await assert.rejects(provider.initiatePayment({ ...request, amount: 10999 }), error("YOCO_RECONFIRM_REQUIRED"));
});

test("invalid amounts, sub-cent precision, unsafe values and non-ZAR fail before HTTP", async (context) => {
  const { provider, calls } = fixture(context);
  for (const amount of ["109.999", "-1", "0", "NaN", "9007199254740992", Number.NaN, Infinity]) {
    await assert.rejects(provider.initiatePayment({ ...request, amount }), error("YOCO_INVALID_INPUT"));
  }
  await assert.rejects(provider.initiatePayment({ ...request, currency_code: "usd" }), error("YOCO_INVALID_INPUT"));
  assert.equal(calls.length, 0);
});

test("missing persistence, context-only IDs, foreign operation/session and forged checkout are rejected", async (context) => {
  assert.throws(() => new YocoPaymentService({}, configuration), error("YOCO_OPERATION_REQUIRED"));
  const { provider, calls } = fixture(context);
  await assert.rejects(provider.initiatePayment({ ...request, data: {} }), error("YOCO_OPERATION_REQUIRED"));
  for (const data of [
    { operation_id: "foreign", session_id: "payses_fixture" },
    { operation_id: "operation_fixture", session_id: "foreign" },
    { ...request.data, yocoCheckoutId: "foreign" },
  ]) await assert.rejects(provider.initiatePayment({ ...request, data }), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal(calls.length, 0);
});

test("completed initiation is reused across provider instances without creating a second checkout", async (context) => {
  const { provider, operations, calls } = fixture(context);
  const first = await provider.initiatePayment(request);
  const restarted = new YocoPaymentService({ yocoOperations: operations }, configuration);
  assert.deepEqual(await restarted.initiatePayment(request), first);
  assert.equal(calls.length, 1);
  const changed = new YocoPaymentService({ yocoOperations: operations }, { ...configuration, successUrl: "https://customer.example.test/changed" });
  assert.deepEqual(await changed.initiatePayment(request), first, "changed defaults cannot rewrite an existing immutable request");
  assert.equal(calls.length, 1);
});

test("concurrent adapter calls claim one external initiation; an in-flight call is not blindly replayed", async (context) => {
  const { provider, calls } = fixture(context);
  const results = await Promise.allSettled([provider.initiatePayment(request), provider.initiatePayment(request)]);
  assert.equal(calls.length, 1);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  for (const result of results) {
    if (result.status === "rejected") assert.ok(error("YOCO_INITIATION_UNCERTAIN")(result.reason));
    else assert.equal(result.value.id, "ch_fixture");
  }
});

test("uncertain network initiation is persisted and cannot silently create a new checkout", async (context) => {
  const { provider, operations } = fixture(context);
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Synthetic lost response"); });
  await assert.rejects(provider.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
  assert.equal(operations.record.state, "uncertain");
  assert.ok(operations.record.requestJson);
  const restarted = new YocoPaymentService({ yocoOperations: operations }, configuration);
  await assert.rejects(restarted.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
  await assert.rejects(restarted.getPaymentStatus(request), error("YOCO_STATUS_UNCERTAIN"));
  assert.equal(requests, 1);
});

test("lost persistence after external creation remains uncertain rather than generating another checkout", async (context) => {
  const { provider, operations, calls } = fixture(context);
  operations.failSave = true;
  await assert.rejects(provider.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
  operations.failSave = false;
  await assert.rejects(provider.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
  assert.equal(calls.length, 1);
});

test("provider HTTP errors, invalid JSON and mismatched receipts do not become pending success", async (context) => {
  for (const response of [new Response("no", { status: 503 }), new Response("not json"), Response.json({ ...checkout, amount: 1 }), Response.json({ ...checkout, redirectUrl: "https://evil.test/checkout" })]) {
    const { provider } = fixture(context);
    context.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(provider.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
    await assert.rejects(provider.getPaymentStatus(request), error("YOCO_STATUS_UNCERTAIN"));
  }
});

test("update preserves the session and rejects changed amounts without any new HTTP call", async (context) => {
  const { provider, calls } = fixture(context);
  const initial = await provider.initiatePayment(request);
  assert.deepEqual((await provider.updatePayment(request)).data, initial.data);
  await assert.rejects(provider.updatePayment({ ...request, amount: "110.00" }), error("YOCO_RECONFIRM_REQUIRED"));
  await assert.rejects(provider.updatePayment({ ...request, currency_code: "usd" }), error("YOCO_INVALID_INPUT"));
  assert.equal(calls.length, 1);
});

test("capture requires verified correlated evidence; signed success maps to captured in native major units", async (context) => {
  const { provider, operations, calls } = fixture(context);
  await provider.initiatePayment(request);
  await assert.rejects(provider.capturePayment(request), error("YOCO_CAPTURE_UNCONFIRMED"));
  assert.equal((await provider.getPaymentStatus(request)).status, "pending");
  assert.deepEqual(await provider.getWebhookActionAndData(signed()), {
    action: "captured", data: { session_id: "payses_fixture", amount: "109.99" },
  });
  assert.equal(operations.record.payment, undefined, "normalization must not itself apply business effects");
  const evidence = verifyYocoEvent(signed(), configuration.webhookSecret);
  assert.ok(evidence);
  operations.record.payment = evidence;
  assert.equal((await provider.authorizePayment(request)).status, "captured");
  assert.equal((await provider.capturePayment(request)).data?.yocoPaymentId, "pay_fixture");
  assert.equal((await provider.retrievePayment(request)).data?.status, "captured");
  assert.equal(calls.length, 1, "capture never charges again or uses undocumented GET polling");
});

test("completed checkout without verified payment evidence stays explicitly uncertain", async (context) => {
  const { provider } = fixture(context, { ...checkout, status: "completed" });
  await provider.initiatePayment(request);
  await assert.rejects(provider.authorizePayment(request), error("YOCO_STATUS_UNCERTAIN"));
});

test("payment.failed maps to failed and native error, never captured", async (context) => {
  const { provider, operations } = fixture(context);
  await provider.initiatePayment(request);
  assert.equal((await provider.getWebhookActionAndData(signed(event("payment.failed")))).action, "failed");
  const evidence = verifyYocoEvent(signed(event("payment.failed")), configuration.webhookSecret);
  assert.ok(evidence);
  operations.record.payment = evidence;
  assert.equal((await provider.authorizePayment(request)).status, "error");
  await assert.rejects(provider.capturePayment(request), error("YOCO_CAPTURE_UNCONFIRMED"));
});

test("webhook verification uses exact signed bytes, rejects tampering, missing headers and stale/future timestamps", () => {
  const good = signed();
  assert.ok(verifyYocoEvent({ ...good, rawData: Buffer.from(good.rawData) }, configuration.webhookSecret));
  for (const input of [
    { ...good, rawData: String(good.rawData) + " " },
    { ...good, headers: {} },
    { ...good, headers: { ...good.headers, "webhook-signature": "v1,aW52YWxpZA==" } },
    signed(event(), Math.floor(Date.now() / 1000) - 181),
    signed(event(), Math.floor(Date.now() / 1000) + 181),
  ]) assert.throws(() => verifyYocoEvent(input, configuration.webhookSecret), error("YOCO_INVALID_WEBHOOK"));
  good.headers["webhook-signature"] = "v2,aW52YWxpZA== " + good.headers["webhook-signature"];
  assert.ok(verifyYocoEvent(good, configuration.webhookSecret));
});

test("signed known IDs, wrong amounts/modes and non-ZAR cannot cross correlation checks", async (context) => {
  const { provider } = fixture(context);
  await provider.initiatePayment(request);
  for (const change of [
    { amount: 11000 }, { mode: "live" },
    { metadata: { ...event().payload.metadata, checkoutId: "foreign" } },
    { metadata: { ...event().payload.metadata, session_id: "foreign" } },
    { metadata: { ...event().payload.metadata, operation_id: "foreign" } },
  ]) {
    const body = event();
    await assert.rejects(provider.getWebhookActionAndData(signed({ ...body, payload: { ...body.payload, ...change } })), error("YOCO_CORRELATION_MISMATCH"));
  }
  const body = event();
  await assert.rejects(provider.getWebhookActionAndData(signed({ ...body, payload: { ...body.payload, currency: "USD" } })), error("YOCO_INVALID_WEBHOOK"));
  assert.deepEqual(await provider.getWebhookActionAndData(signed({ id: "evt_other", type: "other.event", payload: {} })), { action: "not_supported" });
});

test("full technical refund uses a durable key independent of changing native refund IDs", async (context) => {
  const { provider, operations } = await captured(context);
  const calls: RequestInit[] = [];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://payments.yoco.com/api/checkouts/ch_fixture/refund");
    assert.ok(init);
    calls.push(init);
    return Response.json({ id: "ch_fixture", refundId: "rfd_fixture", status: "succeeded" });
  });
  const first = await provider.refundPayment({ ...request, context: { idempotency_key: "refund_native_1" } });
  const restarted = new YocoPaymentService({ yocoOperations: operations }, configuration);
  assert.deepEqual(await restarted.refundPayment({ ...request, context: { idempotency_key: "refund_native_2" } }), first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body, '{"amount":10999}');
  assert.equal(new Headers(calls[0]?.headers).get("Idempotency-Key"), "refund_payment_fixture");
  assert.equal(first.data?.yocoRefundId, "rfd_fixture");
});

test("pending refund stays pending and reuses its durable receipt without another refund", async (context) => {
  const { provider, operations } = await captured(context);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ id: "ch_fixture", refundId: "rfd_fixture", status: "pending" });
  });
  await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_PENDING"));
  await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_PENDING"));
  const refund = operations.record.technicalRefund;
  assert.ok(refund?.receipt);
  // Future verified refund reconciliation, not a second outgoing request.
  refund.state = "succeeded";
  refund.receipt.status = "succeeded";
  assert.equal((await provider.refundPayment(request)).data?.yocoRefundId, "rfd_fixture");
  assert.equal(calls, 1);
});

test("uncertain refund cannot be replayed with a fresh native refund ID", async (context) => {
  const { provider } = await captured(context);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Lost response"); });
  await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_UNCERTAIN"));
  await assert.rejects(provider.refundPayment({ ...request, context: { idempotency_key: "new_native_refund" } }), error("YOCO_REFUND_UNCERTAIN"));
  assert.equal(calls, 1);
});

test("partial, wrong-payment and unapproved refunds are rejected before HTTP", async (context) => {
  const { provider, operations, calls } = await captured(context);
  await assert.rejects(provider.refundPayment({ ...request, amount: "100.00" }), error("YOCO_REFUND_NOT_APPROVED"));
  const refund = operations.record.technicalRefund;
  assert.ok(refund);
  refund.paymentId = "foreign_payment";
  await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_NOT_APPROVED"));
  delete operations.record.technicalRefund;
  await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_NOT_APPROVED"));
  assert.equal(calls.length, 1, "only original initiation contacted provider");
});

test("obsolete successful status or foreign checkout in refund response is not recorded as success", async (context) => {
  for (const receipt of [
    { id: "ch_fixture", refundId: "rfd_fixture", status: "successful" },
    { id: "foreign", refundId: "rfd_fixture", status: "succeeded" },
  ]) {
    const { provider, operations } = await captured(context);
    context.mock.method(globalThis, "fetch", async () => Response.json(receipt));
    await assert.rejects(provider.refundPayment(request), error("YOCO_REFUND_UNCERTAIN"));
    assert.equal(operations.record.technicalRefund?.state, "uncertain");
  }
});

test("local deletion retains correlation and cancellation does not pretend the checkout is unpayable", async (context) => {
  const { provider, operations, calls } = fixture(context);
  await provider.initiatePayment(request);
  assert.deepEqual(await provider.deletePayment({ data: {} }), {});
  assert.equal(operations.record.checkout?.id, "ch_fixture");
  await assert.rejects(provider.cancelPayment(request), error("YOCO_STATUS_UNCERTAIN"));
  assert.equal(calls.length, 1);
});

test("server redirect configuration requires allowlisted HTTPS, with test-only loopback HTTP", () => {
  const operations = new Operations();
  for (const changes of [
    { successUrl: "https://evil.test/return" },
    { successUrl: "https://user:pass@customer.example.test/return" },
    { successUrl: "https://customer.example.test/{cart_id}" },
    { successUrl: "http://customer.example.test/return" },
    { webhookSecret: "whsec_invalid" },
  ]) assert.throws(() => new YocoPaymentService({ yocoOperations: operations }, { ...configuration, ...changes }), error("YOCO_INVALID_INPUT"));
  const local = { ...configuration, successUrl: "http://localhost:3000/return", allowedReturnOrigins: [...configuration.allowedReturnOrigins, "http://localhost:3000"] };
  assert.ok(new YocoPaymentService({ yocoOperations: operations }, local));
  assert.throws(() => new YocoPaymentService({ yocoOperations: operations }, { ...local, secretKey: "sk_live_contract" }), error("YOCO_INVALID_INPUT"));
});

test("sub-cent raw native values and below-minimum prepared operations cannot charge", async (context) => {
  const { provider, operations, calls } = fixture(context);
  await assert.rejects(provider.initiatePayment({ ...request, amount: { value: "109.999", precision: 20 } }), error("YOCO_INVALID_INPUT"));
  operations.record.amountMinor = 199;
  await assert.rejects(provider.initiatePayment({ ...request, amount: "1.99" }), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal(calls.length, 0);
});

test("a failed durable claim prevents an external side effect", async (context) => {
  const { provider, operations, calls } = fixture(context);
  context.mock.method(operations, "claimInitiation", async () => { throw new Error("DB unavailable"); });
  await assert.rejects(provider.initiatePayment(request), /DB unavailable/);
  assert.equal(calls.length, 0);
});

test("browser-like status and refund fields cannot manufacture capture or approve compensation", async (context) => {
  const { provider, operations, calls } = fixture(context);
  await provider.initiatePayment(request);
  const forged = { ...request, data: { ...request.data, status: "captured", yocoPaymentId: "pay_forged", technicalRefund: { state: "succeeded" } } };
  assert.equal((await provider.authorizePayment(forged)).status, "pending");
  assert.equal((await provider.authorizePayment(forged)).data?.yocoPaymentId, undefined);
  const evidence = verifyYocoEvent(signed(), configuration.webhookSecret);
  assert.ok(evidence);
  operations.record.payment = evidence;
  await assert.rejects(provider.refundPayment(forged), error("YOCO_REFUND_NOT_APPROVED"));
  assert.equal(calls.length, 1);
});

test("two concurrent refund calls cannot send two external compensations", async (context) => {
  const { provider } = await captured(context);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ id: "ch_fixture", refundId: "rfd_fixture", status: "succeeded" });
  });
  const outcomes = await Promise.allSettled([
    provider.refundPayment({ ...request, context: { idempotency_key: "native_a" } }),
    provider.refundPayment({ ...request, context: { idempotency_key: "native_b" } }),
  ]);
  assert.equal(calls, 1);
  assert.ok(outcomes.some((result) => result.status === "fulfilled"));
  for (const result of outcomes) {
    if (result.status === "rejected") assert.ok(error("YOCO_REFUND_UNCERTAIN")(result.reason));
    else assert.equal(result.value.data?.yocoRefundId, "rfd_fixture");
  }
});

test("signed status mismatch, missing correlation and wrong signing secret fail closed", () => {
  const body = event();
  for (const payload of [
    { ...body.payload, status: "failed" },
    { ...body.payload, metadata: { checkoutId: "ch_fixture" } },
  ]) assert.throws(() => verifyYocoEvent(signed({ ...body, payload }), configuration.webhookSecret), error("YOCO_INVALID_WEBHOOK"));
  assert.throws(() => verifyYocoEvent(signed(), "whsec_" + Buffer.alloc(32, 8).toString("base64")), error("YOCO_INVALID_WEBHOOK"));
  assert.throws(() => verifyYocoEvent(signed(), "whsec_"), error("YOCO_INVALID_INPUT"));
});

test("replacement session reuses the same request/key after explicit uncertain-operation recovery", async (context) => {
  const { provider, operations } = fixture(context);
  const sent: { key: string | null; body: string }[] = [];
  const created = new Map<string, string>();
  context.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("Idempotency-Key");
    const body = String(init?.body);
    assert.ok(key);
    sent.push({ key, body });
    if (created.has(key)) assert.equal(created.get(key), body);
    else created.set(key, body);
    if (sent.length === 1) throw new Error("Yoco accepted checkout; response lost");
    return Response.json(checkout);
  });
  await assert.rejects(provider.initiatePayment(request), error("YOCO_INITIATION_UNCERTAIN"));
  operations.permit = "server_recovery_permit";
  operations.replay = true;
  const result = await provider.initiatePayment({
    ...request, data: { operation_id: operations.record.id, session_id: "payses_replacement", session_token: operations.permit },
  });
  assert.equal(created.size, 1);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(result.data?.session_id, "payses_replacement");
  assert.deepEqual(operations.record.sessionIds, ["payses_fixture", "payses_replacement"]);
});

test("legacy already-sent request preserves its original session metadata on replacement", async (context) => {
  const { provider, operations, calls } = fixture(context);
  const legacy = JSON.parse(operations.record.requestJson);
  legacy.metadata.session_id = "payses_fixture";
  operations.record.requestJson = JSON.stringify(legacy);
  operations.record.requestFingerprint = fingerprint(operations.record.requestJson);
  await provider.initiatePayment(request);
  operations.permit = "replace";
  const result = await provider.initiatePayment({
    ...request, data: { operation_id: operations.record.id, session_id: "payses_new", session_token: "replace" },
  });
  assert.equal(result.data?.session_id, "payses_new");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.body, operations.record.requestJson);
  assert.equal(JSON.parse(operations.record.requestJson).metadata.session_id, "payses_fixture");
});

test("captured evidence reconstructs a replacement session without a checkout receipt or HTTP", async (context) => {
  const { provider, operations, calls } = await captured(context);
  delete operations.record.checkout;
  operations.record.checkoutId = "ch_fixture";
  operations.record.state = "uncertain";
  operations.permit = "reconstruct";
  const replacement = { ...request, data: {
    operation_id: operations.record.id, session_id: "payses_reconstructed", session_token: "reconstruct",
  } };
  const result = await provider.initiatePayment(replacement);
  assert.equal(result.status, "captured");
  assert.equal(result.data?.session_id, "payses_reconstructed");
  assert.equal(calls.length, 1, "only original initiation sent a POST");
  operations.record.canonicalSessionId = "payses_reconstructed";
  await assert.rejects(provider.authorizePayment(request), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal((await provider.authorizePayment(replacement)).status, "captured");
  operations.record.canonicalSessionId = "payses_fixture";
  await assert.rejects(provider.authorizePayment(request), error("YOCO_CORRELATION_MISMATCH"));
});

test("422 mismatch cannot be recovered with a new key or treated as pending", async (context) => {
  const { provider, operations } = fixture(context);
  let posts = 0;
  context.mock.method(globalThis, "fetch", async () => {
    posts++;
    return new Response("mismatch", { status: 422 });
  });
  const key = operations.record.idempotencyKey;
  await assert.rejects(provider.initiatePayment(request), error("YOCO_IDEMPOTENCY_MISMATCH"));
  assert.equal(operations.record.state, "mismatch");
  operations.replay = true;
  await assert.rejects(provider.initiatePayment(request), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal(operations.record.idempotencyKey, key);
  assert.equal(posts, 1);
});

test("unpermitted native recreation and terminal-refunded operations cannot become payable", async (context) => {
  const { provider, operations, calls } = fixture(context);
  await provider.initiatePayment(request);
  await assert.rejects(provider.initiatePayment({
    ...request, data: { operation_id: operations.record.id, session_id: "payses_compensation" },
  }), error("YOCO_CORRELATION_MISMATCH"));
  operations.record.terminalRefunded = true;
  await assert.rejects(provider.initiatePayment(request), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal(calls.length, 1);
});

test("new webhook correlation needs the operation, not a surviving originating session", async (context) => {
  const { provider } = fixture(context);
  await provider.initiatePayment(request);
  const body = event();
  const metadata = { checkoutId: body.payload.metadata.checkoutId, operation_id: body.payload.metadata.operation_id };
  assert.equal((await provider.getWebhookActionAndData(signed({
    ...body, payload: { ...body.payload, metadata },
  }))).action, "captured");
});

test("captured evidence without an initiation receipt retains the technical refund target", async (context) => {
  const { provider, operations } = await captured(context);
  operations.record.checkoutId = "ch_fixture";
  delete operations.record.checkout;
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(String(url), "https://payments.yoco.com/api/checkouts/ch_fixture/refund");
    assert.equal(init?.body, '{"amount":10999}');
    return Response.json({ id: "ch_fixture", refundId: "rfd_late", status: "succeeded" });
  });
  assert.equal((await provider.refundPayment(request)).data?.yocoRefundId, "rfd_late");
  assert.equal(requests, 1);
});

test("immutable request or credential mismatch cannot issue a checkout", async (context) => {
  const { provider, operations, calls } = fixture(context);
  operations.record.requestFingerprint = "different";
  await assert.rejects(provider.initiatePayment(request), error("YOCO_CORRELATION_MISMATCH"));
  operations.record.requestFingerprint = fingerprint(operations.record.requestJson);
  const changedAccount = new YocoPaymentService({ yocoOperations: operations },
    { ...configuration, secretKey: "sk_test_different" });
  await assert.rejects(changedAccount.initiatePayment(request), error("YOCO_CORRELATION_MISMATCH"));
  assert.equal(calls.length, 0);
});
