import { test, expect } from "@playwright/test";
import type { Page, Request } from "@playwright/test";
import type { MerchantOrder, MerchantMemberRole, MerchantCapability, MerchantContext, CustomerOrder } from "@gospaza/contracts";
import { transition } from "./transitions";

// Per-test diagnostics only; no response bodies, credentials or fixture state are logged.
const diagnostics = new WeakMap<Page, object[]>();
test.beforeEach(async ({ page }) => {
  const events: object[] = [];
  diagnostics.set(page, events);
  const ids = new WeakMap<Request, number>();
  let sequence = 0;
  const describe = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://localhost:9000" || !url.pathname.startsWith("/merchant/")) return null;
    if (!ids.has(request)) ids.set(request, ++sequence);
    return { id: ids.get(request), method: request.method(), path: url.pathname,
      query: Object.fromEntries([...url.searchParams].filter(([key]) => ["limit", "offset", "status"].includes(key))) };
  };
  const record = (event: string, request: Request, extra: object = {}) => {
    const details = describe(request);
    if (details) events.push({ event, ...details, ...extra });
  };
  page.on("request", (request) => record("request", request));
  page.on("response", (response) => record("response", response.request(), {
    status: response.status(), contentType: response.headers()["content-type"],
  }));
  page.on("requestfinished", (request) => record("requestfinished", request));
  page.on("requestfailed", (request) => record("requestfailed", request, { failure: request.failure()?.errorText }));
  page.on("pageerror", (error) => events.push({ event: "pageerror", message: error.message }));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) events.push({ event: "navigation", path: new URL(frame.url()).pathname });
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await info.attach("order-request-lifecycle", {
    body: JSON.stringify(diagnostics.get(page) ?? [], null, 2), contentType: "application/json",
  });
});

const merchantBase = "http://localhost:3001";
const customerBase = "http://localhost:3000";
const path = "/merchant/orders/order_fixture";
const own: MerchantOrder = {
  id: "order_fixture", display_id: 42, created_at: "2026-10-11T10:00:00Z",
  operational_status: "PENDING_ACCEPTANCE", revision: 0, accepted_at: null, rejected_at: null, rejection_reason: null,
  currency_code: "zar", customer: { first_name: "Fixture", last_name: "Customer", city: "Bloemfontein" },
  items: [{ id: "line_fixture", title: "Fixture tomatoes", variant_title: "1 kg", sku: "TOM-1",
    quantity: 2, unit_price_minor: 2500, total_minor: 5000 }],
  totals: { total_minor: 6000, subtotal_minor: 5000, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 1000 },
  delivery: { starts_at: "2026-10-12T10:00:00Z", ends_at: "2026-10-12T11:00:00Z", shipping_name: "Scheduled delivery" },
  pickup: { store_name: "Fixture Shop", address_line_1: "1 Store Street", address_line_2: "", city: "Bloemfontein",
    province: "FS", postal_code: "9301", country_code: "za" },
};
const permissions: Record<MerchantMemberRole, MerchantCapability[]> = {
  OWNER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_ORDER_VIEW", "MERCHANT_ORDER_DECIDE"],
  MANAGER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_ORDER_VIEW", "MERCHANT_ORDER_DECIDE"],
  PICKER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW"],
};
async function mock(page: Page, role: MerchantMemberRole = "OWNER") {
  const state = {
    role, active: true, order: structuredClone(own), outage: false, conflict: false, denyDecision: false,
    writes: [] as { path: string; body: Record<string, unknown> }[],
    reads: [] as string[], beforeDecision: undefined as (() => Promise<void>) | undefined,
  };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const headers = { "access-control-allow-origin": request.headers().origin ?? merchantBase,
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,OPTIONS", "cache-control": "no-store" };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method === "GET") state.reads.push(url.pathname);
    if (url.pathname === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_fixture" } }); return; }
    if (url.pathname === "/store/customers/me") {
      await reply({ customer: { id: "cus_fixture", email: "customer@example.test", first_name: null, last_name: null } }); return;
    }
    if (url.pathname === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (url.pathname === "/merchant/applications/me") {
      await reply({ application: null, documents: [], review_history: [], tenant: null }); return;
    }
    if (url.pathname.startsWith("/merchant/") && !state.active) { await reply({}, 401); return; }
    if (url.pathname === "/merchant/me") {
      const context: MerchantContext = {
        merchant: { id: "mer_fixture", legal_name: "Fixture Shop", trading_name: "Fixture Shop" },
        store: { id: "store_fixture", name: "Fixture Shop" },
        membership: { id: "member_fixture", member_type: state.role, capabilities: permissions[state.role] },
      };
      await reply(context); return;
    }
    if (url.pathname.startsWith("/merchant/orders") && state.role === "PICKER") { await reply({}, 403); return; }
    if (state.outage) { await reply({ message: "private diagnostic" }, 503); return; }
    if (url.pathname === "/merchant/orders" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20), offset = Number(url.searchParams.get("offset") ?? 0);
      const orders = Array.from({ length: 21 }, (_, index) => index === 0 ? state.order
        : { ...state.order, id: "order_page_" + index, display_id: 42 + index });
      const filtered = orders.filter((order) => !url.searchParams.get("status") || order.operational_status === url.searchParams.get("status"));
      await reply({ orders: filtered.slice(offset, offset + limit), limit, offset, count: filtered.length }); return;
    }
    if (url.pathname === path && method === "GET") { await reply({ order: state.order }); return; }
    if ([path + "/accept", path + "/reject"].includes(url.pathname) && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ path: url.pathname, body });
      await state.beforeDecision?.();
      if (state.denyDecision) { await reply({}, 403); return; }
      if (state.conflict) {
        state.order = { ...state.order, operational_status: "REJECTED", revision: 1, rejection_reason: "Already decided" };
        await reply({ code: "ORDER_DECISION_CONFLICT" }, 409); return;
      }
      expect(body).toEqual(url.pathname.endsWith("/reject")
        ? { expected_revision: 0, confirmed: true, reason: body.reason }
        : { expected_revision: 0, confirmed: true });
      const rejected = url.pathname.endsWith("/reject");
      state.order = { ...state.order, revision: 1, operational_status: rejected ? "REJECTED" : "ACCEPTED",
        accepted_at: rejected ? null : "2026-10-11T11:00:00Z", rejected_at: rejected ? "2026-10-11T11:00:00Z" : null,
        rejection_reason: rejected && typeof body.reason === "string" ? body.reason.trim() || null : null };
      const { id, operational_status, revision, accepted_at, rejected_at, rejection_reason } = state.order;
      await reply({ decision: { id, operational_status, revision, accepted_at, rejected_at, rejection_reason } }); return;
    }
    if (url.pathname === "/store/gospaza/orders/order_fixture") {
      const { id, display_id, created_at, operational_status, currency_code, items, totals, delivery } = state.order;
      const order: CustomerOrder = { id, display_id, created_at, operational_status, currency_code, items, totals, delivery, store: { name: "Fixture Shop" } };
      await reply({ order }); return;
    }
    await reply({}, 404);
  });
  return state;
}
async function detail(page: Page) {
  await page.goto(merchantBase + "/merchant/orders/order_fixture");
  await expect(page.getByRole("heading", { name: "Order #42", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
}
// Compile the dynamic Next route before the journey's budget starts. The trace
// showed its first RSC response taking 22 seconds, leaving no time for the
// browser's detail fetch. This HTTP-only setup shares no browser/mock state.
// Prepare the membership-loss redirect destination too; its cold RSC/chunk load
// also exceeded the URL assertion budget. Keep the normal hook timeout and
// still exercise real navigation in fresh browser contexts below.
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    for (const route of [path, "/application"]) {
      const response = await request.get(merchantBase + route);
      expect(response.status(), "Merchant route readiness: " + route).toBe(200);
      await response.body();
    }
  } finally {
    await request.dispose();
  }
});
test("merchant list uses bounded server pages and filters before real detail navigation", async ({ page }) => {
  await mock(page);
  await page.goto(merchantBase + "/merchant/orders");
  await expect(page.getByRole("link", { name: "Order #42", exact: true })).toBeVisible();
  await expect(page.getByText("Foreign Shop", { exact: true })).toHaveCount(0);
  await transition(page, { responses: [{ path: "/merchant/orders", method: "GET", query: { offset: "20" } }] },
    () => page.getByRole("button", { name: "Next", exact: true }).click());
  await expect(page.getByRole("link", { name: "Order #62", exact: true })).toBeVisible();
  await transition(page, { responses: [{ path: "/merchant/orders", method: "GET", query: { status: "REJECTED" } }] },
    () => page.getByRole("combobox", { name: "Order status", exact: true }).selectOption("REJECTED"));
  await expect(page.getByText("No orders found.", { exact: true })).toBeVisible();
  await transition(page, { responses: [{ path: "/merchant/orders", method: "GET", query: { status: "PENDING_ACCEPTANCE" } }] },
    () => page.getByRole("combobox", { name: "Order status", exact: true }).selectOption("PENDING_ACCEPTANCE"));
  await transition(page, { url: merchantBase + path, responses: [{ path, method: "GET" }] },
    () => page.getByRole("link", { name: "Order #42", exact: true }).click());
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
});
for (const role of ["OWNER", "MANAGER"] as const) {
  test(role + " accepts once and reload restores the terminal result", async ({ page }) => {
    const state = await mock(page, role);
    await detail(page);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    state.beforeDecision = async () => { started?.(); await gate; };
    try {
      await page.getByRole("button", { name: "Confirm acceptance", exact: true }).click();
      await requested;
      const button = page.getByRole("button", { name: "Confirm acceptance", exact: true });
      await expect(button).toBeDisabled();
      await button.evaluate((element: HTMLButtonElement) => element.click());
      expect(state.writes).toHaveLength(1);
    } finally { release?.(); }
    await expect(page.getByRole("heading", { name: "Accepted by the store", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Accepted by the store", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  });
  test(role + " rejects with bounded reason and no financial claims", async ({ page }) => {
    const state = await mock(page, role);
    await detail(page);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    expect(state.writes).toHaveLength(0);
    const reason = page.getByLabel("Rejection reason (optional)", { exact: true });
    await expect(reason).toHaveAttribute("maxlength", "500");
    await reason.fill("Unable to fulfil");
    await transition(page, { responses: [{ path: path + "/reject", method: "POST" }, { path, method: "GET" }] },
      () => page.getByRole("button", { name: "Confirm rejection", exact: true }).click());
    await expect(page.getByText("Rejection reason: Unable to fulfil", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await expect(page.getByText(/refund completed|payment reversed|inventory released|customer credited/i)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Merchant cannot fulfill this order", exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(1);
  });
}
test("stale decision refetches the authoritative winner without another write", async ({ page }) => {
  const state = await mock(page); state.conflict = true;
  await detail(page);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  // The client handles a rejected status without consuming its body. Chromium's
  // intercepted 409 has no requestfinished event in the retained failing trace.
  // Observe that status, then require full completion of the authoritative GET.
  const conflict = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === "http://localhost:9000" && url.pathname === path + "/accept"
      && response.request().method() === "POST";
  });
  const [rejected] = await Promise.all([
    conflict,
    transition(page, { responses: [{ path, method: "GET" }] },
      () => page.getByRole("button", { name: "Confirm acceptance", exact: true }).click()),
  ]);
  expect(rejected.status()).toBe(409);
  await expect(page.getByText("Another decision may already be recorded. Review the refreshed order.", { exact: true })).toBeVisible();
  await expect(page.getByText("Rejection reason: Already decided", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
test("focus refresh observes another employee; picker loses order access", async ({ page }) => {
  const state = await mock(page);
  await detail(page);
  state.order = { ...state.order, operational_status: "ACCEPTED", revision: 1 };
  await transition(page, { responses: [{ path, method: "GET" }] }, () => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
  await expect(page.getByRole("heading", { name: "Accepted by the store", exact: true })).toBeVisible();
  state.role = "PICKER";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Order access unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Orders", exact: true })).toHaveCount(0);
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("picker direct navigation never loads order data", async ({ page }) => {
  const state = await mock(page, "PICKER");
  await page.goto(merchantBase + path);
  await expect(page.getByRole("heading", { name: "Order access unavailable", exact: true })).toBeVisible();
  expect(state.reads.filter((value) => value.startsWith("/merchant/orders"))).toHaveLength(0);
});
test("order outage hides details and retry restores data without a mutation", async ({ page }) => {
  const state = await mock(page); state.outage = true;
  await page.goto(merchantBase + path);
  await expect(page.locator(".order-page [role=alert]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  state.outage = false;
  await transition(page, { responses: [{ path, method: "GET" }] }, () => page.getByRole("button", { name: "Refresh order", exact: true }).click());
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});
for (const [status, heading] of [
  ["PENDING_ACCEPTANCE", "Awaiting merchant confirmation"], ["ACCEPTED", "Accepted by the store"],
  ["REJECTED", "Merchant cannot fulfill this order"],
] as const) {
  test("customer restores " + status + " from backend without operational or financial claims", async ({ page }) => {
    const state = await mock(page);
    state.order.operational_status = status;
    state.order.rejection_reason = "Private staff reason";
    await page.goto(customerBase + "/orders/order_fixture?status=ACCEPTED&merchant_id=forged");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Private staff reason", { exact: true })).toHaveCount(0);
    if (status === "REJECTED") {
      await expect(page.getByText("This order will not be fulfilled. Payment resolution is still pending.", { exact: true })).toBeVisible();
      await expect(page.getByText(/refunded|refund completed|credited|inventory|reconciliation/i)).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(0);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain("order_fixture");
  });
}
test("customer foreign Order is unavailable and focus restores an owned updated decision", async ({ page }) => {
  const state = await mock(page);
  await page.goto(customerBase + "/orders/order_foreign");
  await expect(page.locator(".order-page [role=alert]")).toHaveText("Order unavailable.");
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  await page.goto(customerBase + "/orders/order_fixture");
  await expect(page.getByRole("heading", { name: "Awaiting merchant confirmation", exact: true })).toBeVisible();
  state.order.operational_status = "ACCEPTED";
  await transition(page, { responses: [{ path: "/store/gospaza/orders/order_fixture", method: "GET" }] },
    () => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
  await expect(page.getByRole("heading", { name: "Accepted by the store", exact: true })).toBeVisible();
});

test("lost decision response refreshes the server result without replay", async ({ page }) => {
  const state = await mock(page);
  await detail(page);
  let posts = 0;
  await page.route("http://localhost:9000" + path + "/accept", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    posts++;
    state.order = { ...state.order, operational_status: "ACCEPTED", revision: 1, accepted_at: "2026-10-11T11:00:00Z" };
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "Confirm acceptance", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Accepted by the store", exact: true })).toBeVisible();
  await expect(page.getByText("The decision could not be confirmed. Review the refreshed order before taking another action.", { exact: true })).toBeVisible();
  expect(posts).toBe(1);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
});
test("membership loss removes order data and decision controls", async ({ page }) => {
  const state = await mock(page);
  await detail(page);
  state.active = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // Revocation must hide protected content even while the redirect is loading.
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(merchantBase + "/application");
  expect(state.writes).toHaveLength(0);
});
