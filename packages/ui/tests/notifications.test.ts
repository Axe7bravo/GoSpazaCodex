import assert from "node:assert/strict";
import test from "node:test";
import { noticeHref, noticeTime, notificationCode, operationStatus } from "../src/notification-presentation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeCard, NoticeFeedback } from "../src/notifications";
test("M22-E frozen links remain internal, role-appropriate and action-free", () => {
  assert.equal(noticeHref("/orders/order_a", "customer"), "/orders/order_a");
  assert.equal(noticeHref("/merchant/picking/order_a", "merchant"), "/merchant/picking/order_a");
  assert.equal(noticeHref("/", "driver"), "/");
  assert.equal(noticeHref(null, "driver"), null);
  for (const path of ["//attacker.example", "https://attacker.example", "/\\attacker", "/orders/../admin", "/orders/a?otp=secret", "/orders/a#private", "javascript:alert(1)"])
    assert.equal(noticeHref(path, "customer"), null);
  assert.equal(noticeHref("/admin/notifications", "customer"), null);
  assert.equal(noticeHref("/driver/offers/expired/accept", "driver"), null);
});
test("M22-E frozen notice text is escaped and read state comes only from the DTO", () => {
  const row = { id: "notice_a", kind: "ORDER_CONFIRMED", title: 'Frozen <script> title', body: '<img src=x onerror="secret()">',
    created_at: "2026-11-01T00:00:00Z", read_at: null, deep_link: "/orders/order_a", destination: "private@example.test", provider_key: "secret-key" };
  const render = (read_at: string | null, deep_link: string | null) => renderToStaticMarkup(createElement(NoticeCard, { notice: { ...row, read_at, deep_link }, surface: "customer", busy: false, markRead: () => undefined }));
  const unread = render(null, row.deep_link);
  assert.match(unread, /Unread/); assert.match(unread, /Mark read/); assert.match(unread, /&lt;img/); assert.doesNotMatch(unread, /<img|<script|private@example.test|secret-key/);
  const read = render("2026-11-02T00:00:00Z", null); assert.match(read, />Read</); assert.doesNotMatch(read, /Mark read|href=/);
  assert.doesNotMatch(render(null, "https://attacker.example"), /href=/);
});
test("M22-E loading, empty and failed reads have bounded separate copy", () => {
  const render = (loading: boolean, error: "" | "load" | "mark", empty = false) => renderToStaticMarkup(createElement(NoticeFeedback, { loading, error, empty }));
  assert.match(render(true, ""), /Loading notifications/);
  assert.match(render(false, "", true), /No notifications yet/);
  assert.match(render(false, "load"), /Notifications are unavailable/);
  assert.doesNotMatch(render(false, "load", true), /No notifications yet/);
  assert.match(render(false, "mark"), /Read status could not be confirmed/);
});
test("M22-E accepted, failed, uncertain and suppressed statuses stay distinct", () => {
  assert.equal(operationStatus({ state: "ACCEPTED", channel: "EMAIL" }), "Accepted by provider");
  assert.equal(operationStatus({ state: "ACCEPTED", channel: "IN_APP" }), "Published in app");
  assert.equal(operationStatus({ state: "ATTENTION_REQUIRED", channel: "EMAIL" }), "Delivery outcome requires attention");
  assert.equal(operationStatus({ state: "TERMINAL_FAILURE", channel: "EMAIL" }), "Known delivery failure");
  assert.equal(operationStatus({ state: "SUPPRESSED", channel: "EMAIL" }), "Suppressed");
  assert.match(notificationCode("LOST_SEND_RESULT"), /could not be confirmed/);
  assert.equal(notificationCode("NO_RECIPIENT"), "No valid contact destination");
  assert.equal(notificationCode("unsafe_raw_provider_body"), "Review the safe operational status");
  assert.equal(noticeTime("bad"), "Time unavailable");
});
