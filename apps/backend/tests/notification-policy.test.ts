import assert from "node:assert/strict";
import test from "node:test";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { blockNativeNotifications, nativeNotificationMatcher } from "../src/lib/notification-http-boundary";
import { canReplay, classify, createInput, deepLink, digest, identity, nextState, providerKey, render, requestFingerprint,
  REPLAY_MS, retryAt, sourceEligible } from "../src/lib/notification-policy";
import { notificationModuleConfiguration, resendConfiguration } from "../src/lib/notification-config";
import { providerPayload, ResendHttpTransport, unpackProvider } from "../src/lib/notification-transport";

const input = createInput.parse({ source: { type: "fixture", id: "source_a", transition: "confirmed", committed_at: "2030-01-01T00:00:00Z", evidence: "proof_a" },
  kind: "FOUNDATION_TEST", recipient: { type: "customer", id: "customer_a" }, channel: "EMAIL", destination: "recipient@example.test",
  template: "test.notification", version: 1, input: { detail: '<script>"&</script>' }, link: { route: "FOUNDATION_TEST", resource: "order_a" } });
const envelope = { from: "GoSpaza <sender@example.test>", to: "recipient@example.test", subject: "Foundation test", text: "Bounded notice",
  html: "<p>Bounded notice</p>", reply_to: null };

test("M22 stable fact identity separates transitions/recipients/channels, not registry versions", () => {
  assert.equal(identity(input), identity({ ...input, version: 2 }));
  assert.equal(requestFingerprint(input), requestFingerprint({ ...input, version: 2 }));
  assert.notEqual(requestFingerprint(input), requestFingerprint({ ...input, input: { detail: "changed" } }));
  for (const changed of [{ ...input, channel: "IN_APP" as const }, { ...input, recipient: { ...input.recipient, id: "other" } },
    { ...input, source: { ...input.source, transition: "delivered" } }]) assert.notEqual(identity(input), identity(changed));
  assert.equal(providerKey(identity(input)), providerKey(identity({ ...input, version: 2 })));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
test("M22 registry is bounded, versioned, escaped and test-only until C", () => {
  const frozen = render(input, "test");
  assert.equal(frozen.text, input.input.detail);
  assert.equal(frozen.html, "<p>&lt;script&gt;&quot;&amp;&lt;/script&gt;</p>");
  assert.notEqual(render({ ...input, version: 2 }, "test").title, frozen.title);
  assert.throws(() => render(input, "production"));
  for (const patch of [{ template: "arbitrary-file" }, { version: 3 }, { subject: "injected" }, { input: { detail: "x".repeat(2001) } }])
    assert.equal(createInput.safeParse({ ...input, ...patch }).success, false);
  assert.equal(deepLink(input.link, "test"), "/orders/order_a");
  for (const resource of ["//external.test", "javascript:alert(1)", "../secret", "data:text/html,<b>"])
    assert.throws(() => deepLink({ route: "FOUNDATION_TEST", resource }, "test"));
});
test("M22 activation and finite backoff/ambiguity state policy", () => {
  const clock = new Date("2030-01-01T00:00:00Z"), before = new Date(clock.getTime() - 1);
  assert.equal(sourceEligible(null, clock, clock), false);
  assert.equal(sourceEligible(clock, before, clock), false);
  assert.equal(sourceEligible(clock, clock, clock), true);
  assert.equal(sourceEligible(clock, new Date(clock.getTime() + 1), clock), false);
  for (const [number, delay] of [[1, 60000], [2, 300000], [3, 1800000]])
    assert.equal(retryAt(number ?? 0, clock, clock)?.getTime(), clock.getTime() + (delay ?? 0));
  assert.equal(retryAt(4, clock, clock), null);
  assert.equal(canReplay(clock, new Date(clock.getTime() + REPLAY_MS)), false);
  assert.equal(retryAt(1, new Date(clock.getTime() + REPLAY_MS - 1), clock), null);
  assert.equal(nextState({ classification: "AMBIGUOUS", code: "NETWORK" }, null), "ATTENTION_REQUIRED");
  assert.equal(nextState({ classification: "TERMINAL", code: "INVALID" }, clock), "TERMINAL_FAILURE");
  assert.equal(nextState({ classification: "TERMINAL", code: "CONFIGURATION_CHANGED" }, null), "ATTENTION_REQUIRED");
  assert.equal(classify(429, "rate_limit_exceeded").classification, "RETRYABLE");
  assert.equal(classify(409, "concurrent_idempotent_requests").classification, "RETRYABLE");
  assert.equal(classify(409, "invalid_idempotent_request").classification, "TERMINAL");
  assert.equal(classify(500, "internal_server_error").classification, "AMBIGUOUS");
  assert.equal(classify(422, "validation_error").classification, "TERMINAL");
});
test("M22 optional transport configuration is safe and never contains fallback credentials", () => {
  assert.deepEqual(notificationModuleConfiguration({}), []);
  assert.equal(resendConfiguration({ NOTIFICATION_EMAIL_ENABLED: "true" }), null);
  const env = { NOTIFICATION_EMAIL_ENABLED: "true", RESEND_API_KEY: "fixture-key", RESEND_FROM_EMAIL: "sender@example.test", RESEND_FROM_NAME: "GoSpaza" };
  assert.equal(resendConfiguration(env)?.from, '"GoSpaza" <sender@example.test>');
  for (const change of [{ RESEND_FROM_NAME: "bad\r\nBcc: other" }, { RESEND_FROM_EMAIL: "bad" }, { RESEND_API_KEY: "key\nvalue" }])
    assert.equal(resendConfiguration({ ...env, ...change }), null);
});
test("M22 native notification reads/retries cannot bypass actor/capability projections", () => {
  for (const path of ["/admin/notifications", "/admin/notifications/", "/ADMIN/NOTIFICATIONS/noti_foreign/resend"])
    assert.equal(nativeNotificationMatcher.test(path), true);
  assert.equal(nativeNotificationMatcher.test("/admin/gospaza/notifications"), false);
  let status = 0, cache = "", body: unknown;
  const response = { setHeader: (_name: string, value: string) => { cache = value; },
    status: (value: number) => { status = value; return response; }, json: (value: unknown) => { body = value; } };
  blockNativeNotifications({} as MedusaRequest, response as unknown as MedusaResponse);
  assert.equal(status, 404); assert.equal(cache, "private, no-store");
  assert.deepEqual(body, { message: "Notification information is unavailable." });
});
test("M22 provider envelope rejects changed payload, header injection and provider overrides", () => {
  const data = providerPayload(envelope, providerKey(identity(input)), digest(envelope), digest("fixture-key"));
  assert.deepEqual(unpackProvider(data).envelope, envelope);
  assert.throws(() => unpackProvider({ ...data, to: "other@example.test" }));
  assert.throws(() => unpackProvider({ ...data, provider_data: { ...data.provider_data, cc: "other@example.test" } }));
  assert.throws(() => providerPayload({ ...envelope, subject: "bad\r\nheader" }, providerKey(identity(input)), digest(envelope), digest("fixture-key")));
});
test("M22 Resend transport uses fixed endpoint/stable key, bounded evidence and no live test network", async () => {
  const data = providerPayload(envelope, providerKey(identity(input)), digest(envelope), digest("fixture-key"));
  const calls: { url: string; body: string | undefined; key: string | null }[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body?.toString(), key: new Headers(options?.headers).get("Idempotency-Key") });
    return new Response(JSON.stringify({ id: "email_fixture", last_event: "delivered" }), { status: 200 });
  };
  const transport = new ResendHttpTransport("fixture-key", request, "test");
  assert.deepEqual(await transport.send(data), { classification: "ACCEPTED", providerId: "email_fixture" });
  await transport.send(data);
  assert.deepEqual(calls[0], calls[1]);
  const beforeInvalid = calls.length;
  assert.deepEqual(await transport.send({ ...data, to: "other@example.test" }), { classification: "TERMINAL", code: "ENVELOPE_INVALID" });
  assert.equal(calls.length, beforeInvalid);
  assert.deepEqual(await new ResendHttpTransport("different-account-key", request, "test").send(data),
    { classification: "TERMINAL", code: "CONFIGURATION_CHANGED" });
  assert.equal(calls.length, beforeInvalid);
  assert.equal(calls[0]?.url, "https://api.resend.com/emails");
  assert.deepEqual(await transport.retrieve("email_fixture"), { providerId: "email_fixture", event: "delivered" });
  assert.equal(calls[2]?.url, "https://api.resend.com/emails/email_fixture");
  assert.equal((await new ResendHttpTransport("fixture-key", fetch, "test").send(data)).classification, "TERMINAL");
  assert.equal((await new ResendHttpTransport("fixture-key", async () => { throw Error("private secret"); }, "test").send(data)).classification, "AMBIGUOUS");
  const permanent = new ResendHttpTransport("fixture-key", async () => new Response('{"name":"validation_error","message":"private value"}', { status: 422 }), "test");
  assert.deepEqual(await permanent.send(data), { classification: "TERMINAL", code: "PROVIDER_REJECTED" });
});
