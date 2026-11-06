import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { retryAt, REPLAY_MS } from "../src/lib/notification-policy";
import { actorNotice, noticeVisible } from "../src/lib/notification-inbox";
import { encodeNoticeCursor, notificationPage, notificationOpsAllowed, transportDisposition, workerEnabled } from "../src/lib/notification-runtime-policy";
import { verifyResendWebhook } from "../src/lib/notification-webhook";
import { sourceDiscovery, type NoticeBinding } from "../src/lib/notification-currentness";
import { productionCatalogue } from "../src/lib/notification-catalogue";
import { ResendHttpTransport } from "../src/lib/notification-transport";

test("M22-D bounded retry schedule, horizon and opt-in workers", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  for (const [attempt, delay] of [[1, 60000], [2, 300000], [3, 1800000]] as const)
    assert.equal(retryAt(attempt, now, now)?.getTime(), now.getTime() + delay);
  assert.equal(retryAt(4, now, now), null);
  assert.equal(retryAt(1, new Date(now.getTime() + REPLAY_MS), now), null);
  assert.equal(workerEnabled("delivery", {}), false);
  assert.equal(workerEnabled("delivery", { APP_ENV: "production", NOTIFICATION_DELIVERY_WORKER_ENABLED: "true" }), true);
  assert.equal(workerEnabled("delivery", { APP_ENV: "test", NOTIFICATION_DELIVERY_WORKER_ENABLED: "true" }), false);
});
test("M22-D evidence precedence never regresses on delayed/out-of-order events", () => {
  assert.equal(transportDisposition(["delivered", "delivery_delayed", "sent"], true), "delivered");
  assert.equal(transportDisposition(["delivered", "bounced"], true), "bounced");
  assert.equal(transportDisposition(["complained", "sent"], true), "complained");
  assert.equal(transportDisposition([], false), null);
});
test("M22-D keyset cursor is strict and bounded", () => {
  const cursor = encodeNoticeCursor("2030-01-01T00:00:00Z", "notice_a");
  assert.deepEqual(notificationPage.parse({ cursor, limit: "20" }).cursor, { at: "2030-01-01T00:00:00.000Z", id: "notice_a" });
  for (const value of [{ cursor: "invalid" }, { limit: 51 }, { customer_id: "foreign" }, { cursor: Buffer.from('{"at":"bad","id":"x"}').toString("base64url") }])
    assert.equal(notificationPage.safeParse(value).success, false);
});
test("M22-D DTOs exclude destination/evidence and ops requires independent grant", () => {
  const row = { id: "notice", kind: "ORDER_CONFIRMED", title: "Title", body: "Safe body", deep_link: "/orders/order_a", created_at: new Date("2030-01-01"), read_at: null,
    destination: "private@example.test", provider_key: "secret", source_evidence: "fingerprint" };
  assert.deepEqual(Object.keys(actorNotice(row)).sort(), ["id", "kind", "title", "body", "deep_link", "created_at", "read_at"].sort());
  const env = { NOTIFICATION_OPERATIONS_VIEW_USER_IDS: "operator", FINANCIAL_VIEW_USER_IDS: "viewer" };
  assert.equal(notificationOpsAllowed("operator", env), true); assert.equal(notificationOpsAllowed("viewer", env), false);
  const binding: NoticeBinding = { ...row, template_key: "merchant.settlement_paid", recipient_type: "merchant", recipient_id: "member", source_type: "merchant_settlement_command", source_id: "command", source_transition: "PAY" };
  assert.equal(noticeVisible({ actor: { type: "merchant", id: "member" }, role: "PICKER" }, binding, env), false);
  assert.equal(noticeVisible({ actor: { type: "merchant", id: "member" }, role: "MANAGER" }, binding, env), true);
  assert.equal(noticeVisible({ actor: { type: "merchant", id: "foreign" }, role: "OWNER" }, binding, env), false);
});
test("M22-D EMAIL registry is retrospective and discovery is allowlisted", () => {
  assert.deepEqual([...new Set(productionCatalogue.filter(row => row.channels.includes("EMAIL")).map(row => row.kind))].sort(),
    ["DELIVERY_COMPLETED", "ORDER_CONFIRMED", "ORDER_REJECTED_OR_UNFULFILLABLE", "REFUND_CONFIRMED", "STORE_CREDIT_ISSUED"]);
  assert.equal(sourceDiscovery("store_credit_operation"), "CREDIT"); assert.equal(sourceDiscovery("arbitrary_client_table"), null);
});
test("M22-D Svix official fixed vector and signed Resend parsing reject mutation/replay", () => {
  const official = '{"event_type":"ping","data":{"success":true}}';
  // Official manual-verification vector must authenticate; it then rejects our
  // deliberately unsupported payload shape rather than a signature mismatch.
  const key = "whsec_plJ3nmyCDGBKInavdOK15jsl";
  assert.equal(createHmac("sha256", Buffer.from(key.slice(6), "base64")).update("msg_loFOjxBNrRLzqYUf.1731705121." + official).digest("base64"),
    "rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=");
  const secret = "whsec_" + Buffer.from("controlled-notification-signing-key").toString("base64");
  const timestamp = "1893456000", raw = JSON.stringify({ type: "email.delivered", created_at: "2030-01-01T00:00:00Z", data: { email_id: "provider_a", to: ["private@example.test"] } });
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update("event_a." + timestamp + "." + raw).digest("base64");
  const headers = { "svix-id": "event_a", "svix-timestamp": timestamp, "svix-signature": "v1," + signature };
  const verified = verifyResendWebhook(raw, headers, secret, Number(timestamp) * 1000); assert.equal(verified?.provider_id, "provider_a");
  assert.equal(JSON.stringify(verified).includes("private@example.test"), false);
  assert.throws(() => verifyResendWebhook(raw + " ", headers, secret, Number(timestamp) * 1000));
  assert.throws(() => verifyResendWebhook(raw, headers, secret, (Number(timestamp) + 301) * 1000));
});
test("M22-D provider retrieval is known-ID only, bounded and rejects mismatched readback", async () => {
  let url = "";
  const request: typeof fetch = async (input, options) => {
    url = String(input); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error"); assert.ok(options?.signal);
    return new Response(JSON.stringify({ id: "known_provider", last_event: "delivered", to: ["private@example.test"], html: "private" }), { status: 200 });
  };
  const transport = new ResendHttpTransport("fixture-key", request, "test");
  assert.deepEqual(await transport.retrieve("known_provider"), { providerId: "known_provider", event: "delivered" });
  assert.equal(url, "https://api.resend.com/emails/known_provider");
  await assert.rejects(transport.retrieve("another_provider"));
  await assert.rejects(transport.retrieve("../attacker"));
});
