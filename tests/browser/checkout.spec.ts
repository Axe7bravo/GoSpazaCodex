import { test as baseTest, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CheckoutConfirmation, CheckoutQuote, CustomerCheckoutStatus } from "@gospaza/contracts";
import { transition } from "./transitions";

// Cold browser-page startup has its own bounded fixture budget. The warm-up
// page is never used by a test; normal test contexts remain isolated.
const test = baseTest.extend<Record<never, never>, { checkoutWarmupPage: Page }>({
  checkoutWarmupPage: [async ({ browser }, use) => {
    const context = await browser.newContext();
    try {
      await use(await context.newPage());
    } finally {
      await context.close();
    }
  }, { scope: "worker", timeout: 30000 }],
});
const base = "http://localhost:3000";
const endpoint = "/store/gospaza/checkout";
const address = { id: "addr_checkout", first_name: "Test", last_name: "Customer", address_1: "1 Test Street", address_2: "",
  city: "Bloemfontein", province: "FS", postal_code: "9301", country_code: "za" as const, phone: "0123456789", location: null };
const quote: CheckoutQuote = { cart_id: "cart_checkout", address_id: address.id, address,
  checkout_revision: "a".repeat(64), expires_at: "2099-01-01T12:00:00Z", currency_code: "zar",
  totals: { total_minor: 3500, subtotal_minor: 2500, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 1000 } };
const window = { start_at: "2099-01-01T13:00:00Z", end_at: "2099-01-01T14:00:00Z" };
function status(state: CustomerCheckoutStatus["state"]): CustomerCheckoutStatus {
  const native: CheckoutConfirmation["state"] = state === "ready_to_pay" ? "CONFIRMED" : state === "succeeded" ? "COMPLETED"
    : state === "recovery_required" ? "RECOVERY_REQUIRED" : state === "failed" ? "FAILED"
      : ["expired", "refund_pending", "refunded"].includes(state) ? "EXPIRED" : "PAYMENT_PENDING";
  return { state, attempt: state === "none" ? null : { id: "chk_checkout", state: native, quote: structuredClone(quote), payment_deadline: "2099-01-01T12:15:00Z" },
    order_id: state === "succeeded" ? "order_verified" : null, delivery_window: state === "none" ? null : window };
}
async function mock(page: Page, initial: CustomerCheckoutStatus["state"] = "none") {
  const state = { status: status(initial), quote: structuredClone(quote), writes: [] as { path: string; body: Record<string, unknown> }[],
    reconfirm: false, outage: false, beforePay: undefined as (() => Promise<void>) | undefined };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = { "access-control-allow-origin": base, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-publishable-api-key", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const reply = (body: unknown, code = 200) => route.fulfill({ status: code, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_checkout" } }); return; }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_checkout", email: "checkout@example.test", first_name: null, last_name: null } }); return; }
    if (path === endpoint + "/status") { await reply(state.outage ? { message: "secret internal error" } : state.status, state.outage ? 503 : 200); return; }
    if (path === "/store/gospaza/addresses") { await reply({ addresses: [address] }); return; }
    if (path === "/store/gospaza/cart") { await reply({ state: "current", eligibility: "pending", cart: { id: quote.cart_id,
      store: { id: "mstore_checkout", name: "Fixture Grocer" }, item_count: 1, subtotal_minor: 2500, currency_code: "zar",
      items: [{ id: "line_checkout", product_id: "prod_checkout", variant_id: "var_checkout", product_title: "Groceries", variant_title: "Standard",
        quantity: 1, image_url: null, unit_price_minor: 2500, subtotal_minor: 2500 }] } }); return; }
    if (path === "/store/gospaza/cart/delivery-selection") { await reply({ state: "held", revision: 2, timezone: "Africa/Johannesburg",
      selection: { id: "hold_checkout", option_id: "opt_checkout", slot_id: "slot_checkout", ...window, expires_at: quote.expires_at, fee_minor: 1000, currency_code: "zar" } }); return; }
    if (request.method() === "POST" && path.startsWith(endpoint)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ path, body });
      if (path.endsWith("/prepare")) { await reply({ quote: state.quote, attempt: null, reconfirmation_required: false }); return; }
      if (path.endsWith("/confirm")) {
        if (state.reconfirm) {
          state.reconfirm = false; state.quote = { ...state.quote, checkout_revision: "b".repeat(64), totals: { ...state.quote.totals, total_minor: 4000 } };
          await reply({ quote: state.quote, attempt: null, reconfirmation_required: true, code: "CHECKOUT_RECONFIRM" }, 409); return;
        }
        expect(body.checkout_revision).toBe(state.quote.checkout_revision);
        state.status = status("ready_to_pay");
        if (state.status.attempt) state.status.attempt.quote = state.quote;
        await reply({ quote: state.quote, attempt: state.status.attempt, reconfirmation_required: false }); return;
      }
      if (path.endsWith("/pay")) {
        await state.beforePay?.(); state.status = status("awaiting_payment");
        await reply({ attempt_id: "chk_checkout", state: "ready", payment_deadline: "2099-01-01T12:15:00Z", redirect_url: "https://c.yoco.com/checkout/fixture" }); return;
      }
    }
    // A native payment/completion request is always a test failure, not a success mock.
    expect(path, "Unexpected/native API request").toMatch(/^\/store\/gospaza\//);
    await reply({}, 404);
  });
  await page.route("https://c.yoco.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Yoco fixture</h1>" }));
  return state;
}
async function prepare(page: Page) {
  await page.goto(base + "/checkout");
  await page.getByLabel("Delivery address", { exact: true }).selectOption(address.id);
  await transition(page, { responses: [{ path: endpoint + "/prepare", method: "POST" }] },
    () => page.getByRole("button", { name: "Review checkout", exact: true }).click());
  await expect(page.getByRole("button", { name: "Confirm checkout", exact: true })).toBeEnabled();
}
test.beforeAll(async ({ request }) => {
  for (const path of ["/checkout", "/checkout/return"]) {
    const response = await request.get(base + path); expect(response.ok()).toBe(true); await response.dispose();
  }
});
// HTTP readiness does not exercise Next hydration. Startup is handled by the
// worker fixture, so this hook measures application readiness only.
test.beforeAll(async ({ checkoutWarmupPage: page }) => {
  await mock(page);
  await page.goto(base + "/checkout");
  await expect(page.getByLabel("Delivery address", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Review checkout", exact: true })).toBeVisible();
});
test("checkout preparation, changed total reconfirmation, explicit Pay and duplicate-click protection", async ({ page }) => {
  const state = await mock(page);
  await prepare(page);
  expect(state.writes[0]?.body).toEqual({ cart_id: quote.cart_id, address_id: address.id, expected_reservation_revision: 2 });
  state.reconfirm = true;
  await transition(page, { responses: [{ path: endpoint + "/confirm", method: "POST", status: 409 }] },
    () => page.getByRole("button", { name: "Confirm checkout", exact: true }).click());
  await expect(page.getByText("Your checkout changed. Review the updated total and confirm again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay securely with Yoco", exact: true })).toHaveCount(0);
  await transition(page, { responses: [{ path: endpoint + "/confirm", method: "POST" }, { path: endpoint + "/status", method: "GET" }] },
    () => page.getByRole("button", { name: "Confirm updated checkout", exact: true }).click());
  await expect(page.getByRole("heading", { name: "Ready to pay", exact: true })).toBeVisible();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  state.beforePay = async () => { started?.(); await gate; };
  try {
    await page.getByRole("button", { name: "Pay securely with Yoco", exact: true }).click();
    await requested;
    await expect(page.getByRole("button", { name: "Pay securely with Yoco", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Pay securely with Yoco", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    expect(state.writes.filter((write) => write.path.endsWith("/pay"))).toHaveLength(1);
  } finally { release?.(); }
  await expect(page).toHaveURL("https://c.yoco.com/checkout/fixture");
  expect(state.writes.at(-1)?.body).toEqual({ cart_id: quote.cart_id, attempt_id: "chk_checkout", checkout_revision: "b".repeat(64), confirmed: true });
});
test("return claims are ignored; pending polling and reload use verified backend outcome", async ({ page }) => {
  await page.clock.install();
  const state = await mock(page, "awaiting_payment");
  await page.goto(base + "/checkout/return?status=success&payment_id=forged&order_id=forged");
  await expect(page.getByRole("heading", { name: "Awaiting verified payment", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Order confirmed", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Awaiting verified payment", exact: true })).toBeVisible();
  state.status = status("succeeded");
  await transition(page, { responses: [{ path: endpoint + "/status", method: "GET" }] }, () => page.clock.fastForward(5000));
  await expect(page.getByRole("heading", { name: "Order confirmed", exact: true })).toBeVisible();
  await expect(page.getByText("Order reference: order_verified", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Order reference: order_verified", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain("chk_checkout"); expect(stored).not.toContain("order_verified");
});
for (const [stateName, heading] of [
  ["failed", "Payment was not completed"], ["expired", "Checkout attempt expired"],
  ["recovery_required", "Unable to confirm your order yet"], ["refund_pending", "Payment refund is being reconciled"],
  ["reconciliation_pending", "Confirming your order"], ["refunded", "Payment refunded"],
] as const) {
  test("restored " + stateName + " never offers another payment or claims an Order", async ({ page }) => {
    const state = await mock(page, stateName);
    await page.goto(base + "/checkout/return?status=success");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay securely with Yoco", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Order confirmed", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(0);
  });
}
test("status outage disables payment and refresh does not repeat initiation", async ({ page }) => {
  const state = await mock(page, "ready_to_pay"); state.outage = true;
  await page.goto(base + "/checkout");
  await expect(page.locator('.checkout-page [role="alert"]')).toBeVisible();
  await expect(page.getByText("secret internal error", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay securely with Yoco", exact: true })).toHaveCount(0);
  state.outage = false;
  await page.getByRole("button", { name: "Refresh checkout status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pay securely with Yoco", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});