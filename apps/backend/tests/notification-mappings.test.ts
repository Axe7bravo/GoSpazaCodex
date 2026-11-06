import assert from "node:assert/strict";
import test from "node:test";
import { formatZarMinor } from "@gospaza/contracts";
import { createInput, deepLink, render } from "../src/lib/notification-policy";
import { productionCatalogue } from "../src/lib/notification-catalogue";
import { merchantEligible, platformEligible, type MerchantRecipient } from "../src/lib/notification-recipients";
import type { NotificationFact } from "../src/modules/marketplace/notification-sources";
import { notificationSignal } from "../src/subscribers/notification-discovery";

const source = { type: "fixture", id: "source", transition: "confirmed", committed_at: "2030-01-01T00:00:00Z", evidence: "receipt" };
const fact = (patch: Partial<NotificationFact> = {}): NotificationFact => ({ source, template: "merchant.new_order", kind: "NEW_ORDER_REQUIRING_ACTION",
  audience: "merchant", input: { reference: "order" }, merchantId: "merchant", storeId: "store", link: null, guards: [], merchantPolicy: "MANAGEMENT", ...patch });
const member = (role: MerchantRecipient["role"]): MerchantRecipient => ({ role, memberId: "member_" + role, identity: "identity_" + role, merchantId: "merchant", storeId: "store" });

test("M22-C exact actor/channel catalogue and production version binding", () => {
  const customerMail = productionCatalogue.filter(row => row.audience === "customer" && row.channels.includes("EMAIL")).map(row => row.kind);
  assert.deepEqual([...new Set(customerMail)].sort(), ["DELIVERY_COMPLETED", "ORDER_CONFIRMED", "ORDER_REJECTED_OR_UNFULFILLABLE", "REFUND_CONFIRMED", "STORE_CREDIT_ISSUED"]);
  for (const row of productionCatalogue.filter(row => row.audience !== "customer")) assert.deepEqual(row.channels, ["IN_APP"]);
  assert.equal(productionCatalogue.some(row => /ARRIVAL|MARKETING|EARNING_CREATED/.test(row.kind)), false);
  for (const definition of productionCatalogue) {
    const input = createInput.parse({ source, kind: definition.kind, template: definition.template, version: 1,
      recipient: { type: definition.audience, id: "recipient" }, channel: definition.channels[0], destination: null, link: null,
      input: { reference: "record", ...(definition.money ? { amount_minor: "6342", currency: "zar" } : {}) } });
    const output = render(input, "production"); assert.ok(output.title); assert.ok(output.text);
    assert.throws(() => render({ ...input, version: 2 }, "production"));
    if (definition.audience !== "customer") assert.throws(() => render({ ...input, channel: "EMAIL" }, "production"));
    assert.throws(() => render({ ...input, recipient: { type: "guest", id: "anonymous" } }, "production"));
  }
});
test("M22-C production render input is escaped, bounded and private by allowlist", () => {
  const input = createInput.parse({ source, kind: "ORDER_CONFIRMED", template: "customer.order_confirmed", version: 1,
    recipient: { type: "customer", id: "customer" }, channel: "EMAIL", destination: "customer@example.test", link: null,
    input: { reference: '<img onerror="alert(1)">&entity;' } });
  const output = render(input, "production");
  assert.ok(output.html.includes("&lt;img")); assert.ok(output.html.includes("&quot;")); assert.ok(output.html.includes("&amp;entity;"));
  assert.equal(output.html.includes('<img onerror='), false);
  assert.ok(render({ ...input, input: { reference: "<script>alert('x')</script>" } }, "production").html.includes("&lt;script&gt;"));
  assert.throws(() => render({ ...input, input: { reference: "bad\r\nheader" } }, "production"));
  for (const forbidden of ["otp", "dob", "school_uniform", "bank_account", "provider_refund_id", "private_storage_key"])
    assert.equal(createInput.safeParse({ ...input, input: { reference: "record", [forbidden]: "secret" } }).success, false);
  const financial = { ...input, kind: "STORE_CREDIT_ISSUED", template: "customer.store_credit_issued", input: { reference: "order", amount_minor: "6342", currency: "zar" as const } };
  assert.ok(render(financial, "production").text.includes(formatZarMinor("6342")));
  assert.throws(() => render({ ...financial, input: { ...financial.input, amount_minor: "63.42" } }, "production"));
  assert.equal(render({ ...input, template: "customer.return_required", kind: "DELIVERY_FAILED_OR_RETURN_REQUIRED",
    channel: "IN_APP", destination: null }, "production").text.includes("does not confirm a refund or credit"), true);
});
test("M22-C shared ZAR display retains exact cents including large and negative values", () => {
  const decimal = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" })
    .formatToParts(0n).find(part => part.type === "decimal")?.value;
  assert.ok(decimal, "ZAR display must include a decimal separator");
  for (const [minor, fraction, digits] of [["6342", "42", "6342"], ["-1", "01", "001"], ["9007199254740991999", "99", "9007199254740991999"]]) {
    const display = formatZarMinor(String(minor));
    assert.ok(display.endsWith(decimal + fraction));
    assert.equal(display.replace(/\D/g, ""), digits, "all major-unit and cent digits must remain exact");
  }
  const minus = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" })
    .formatToParts(-1n).find(part => part.type === "minusSign")?.value;
  assert.ok(minus);
  assert.ok(formatZarMinor("-1").includes(minus), "negative cents must retain their sign");
  assert.equal(formatZarMinor("63.42"), "Amount unavailable");
});
test("M22-C merchant management/finance and assigned picker boundaries remain explicit", () => {
  for (const role of ["OWNER", "MANAGER"] as const) {
    assert.equal(merchantEligible(member(role), fact()), true);
    assert.equal(merchantEligible(member(role), fact({ merchantPolicy: "FINANCE" })), true);
  }
  assert.equal(merchantEligible(member("PICKER"), fact()), false);
  assert.equal(merchantEligible(member("PICKER"), fact({ merchantPolicy: "FINANCE" })), false);
  assert.equal(merchantEligible(member("PICKER"), fact({ merchantPolicy: "DISPOSITION" })), false);
  assert.equal(merchantEligible(member("PICKER"), fact({ merchantPolicy: "RETURN" })), true);
  assert.equal(merchantEligible(member("PICKER"), fact({ merchantPolicy: "PICKING", assignedMember: "other" })), false);
  assert.equal(merchantEligible(member("PICKER"), fact({ merchantPolicy: "PICKING", assignedMember: "member_PICKER" })), true);
  assert.equal(merchantEligible({ ...member("OWNER"), storeId: "foreign" }, fact()), false);
});
test("M22-C platform audience membership never replaces existing domain capability", () => {
  const attention = fact({ audience: "user", platform: "CUSTOMER_FINANCE", platformAction: "REFUND" });
  const env = { NOTIFICATION_AUDIENCE_CUSTOMER_FINANCE_USER_IDS: "operator", FINANCIAL_VIEW_USER_IDS: "operator,viewer",
    FINANCIAL_EXECUTE_REFUND_USER_IDS: "operator,unrelated" };
  assert.equal(platformEligible("operator", attention, env), true);
  for (const user of ["viewer", "unrelated", "native_admin", ""]) assert.equal(platformEligible(user, attention, env), false);
  assert.equal(platformEligible("operator", attention, { ...env, FINANCIAL_EXECUTE_REFUND_USER_IDS: "" }), false);
  assert.equal(platformEligible("operator", attention, { ...env, NOTIFICATION_AUDIENCE_CUSTOMER_FINANCE_USER_IDS: "" }), false);
});
test("M22-C discovery accepts IDs only and deep links use actual role routes", () => {
  assert.deepEqual(notificationSignal({ name: "order.placed", data: { id: "order_a", email: "attacker@example.test", merchant_id: "foreign", amount_minor: 1 } }), { id: "order_a", delivered: false });
  assert.deepEqual(notificationSignal({ name: "gospaza.delivery-completed", data: { order_id: "order_a", driver_id: "foreign" } }), { id: "order_a", delivered: true });
  assert.equal(notificationSignal({ name: "unknown", data: { id: "order_a" } }), null);
  assert.equal(notificationSignal({ name: "order.placed", data: { id: "../foreign" } }), null);
  assert.equal(deepLink({ route: "DRIVER_CURRENT", resource: "delivery_a" }, "production"), "/");
  assert.equal(deepLink({ route: "MERCHANT_PICKING", resource: "order_a" }, "production"), "/merchant/picking/order_a");
  assert.equal(deepLink({ route: "ADMIN_DRIVER_FINANCE", resource: "payment_a" }, "production"), "/admin/driver-finance");
});
