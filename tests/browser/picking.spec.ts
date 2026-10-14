import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { MerchantCapability, MerchantContext, MerchantMemberRole, PickingOrder } from "@gospaza/contracts";

const base = "http://localhost:3001";
const path = "/merchant/picking/order_fixture";
const own: PickingOrder = {
  id: "order_fixture", display_id: 42, created_at: "2026-10-12T10:00:00Z", status: "NOT_STARTED",
  revision: 0, assigned_member_id: null, started_at: null, completed_at: null,
  lines: [{ id: "line_fixture", title: "Fixture tomatoes", variant_title: "1 kg", sku: "TOM-1",
    ordered_quantity: 5, picked_quantity: 0, shortage_recorded: false, unresolved_quantity: 5 }],
};
const common: MerchantCapability[] = ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_PICKING_VIEW", "MERCHANT_PICKING_PERFORM"];
async function mock(page: Page, role: MerchantMemberRole = "PICKER") {
  const state = {
    active: true, order: structuredClone(own), outage: false, loseResponse: false,
    conflict: undefined as ((order: PickingOrder) => void) | undefined,
    beforeWrite: undefined as (() => Promise<void>) | undefined,
    writes: [] as { path: string; body: Record<string, unknown> }[], reads: [] as string[],
  };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const headers = { "access-control-allow-origin": request.headers().origin ?? base,
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "cache-control": "no-store" };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method === "GET") state.reads.push(url.pathname + url.search);
    if (url.pathname === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (url.pathname === "/merchant/applications/me") { await reply({ application: null, documents: [], review_history: [], tenant: null }); return; }
    if (!state.active) { await reply({}, 401); return; }
    if (url.pathname === "/merchant/me") {
      const context: MerchantContext = {
        merchant: { id: "mer_fixture", legal_name: "Fixture Shop", trading_name: "Fixture Shop" },
        store: { id: "store_fixture", name: "Fixture Shop" },
        membership: { id: "member_fixture", member_type: role, capabilities: role === "PICKER" ? common
          : [...common, "MERCHANT_PICKING_REASSIGN", "MERCHANT_TEAM_VIEW", "MERCHANT_ORDER_VIEW", "MERCHANT_ORDER_DECIDE"] },
      };
      await reply(context); return;
    }
    if (url.pathname === "/merchant/team") {
      await reply({ members: [
        { id: "member_fixture", role, status: "ACTIVE", created_at: own.created_at },
        { id: "member_other", role: "PICKER", status: "ACTIVE", created_at: own.created_at },
        { id: "member_inactive", role: "PICKER", status: "INACTIVE", created_at: own.created_at },
      ] }); return;
    }
    if (state.outage) { await reply({ message: "private diagnostic" }, 503); return; }
    if (url.pathname === "/merchant/picking" && method === "GET") {
      const limit = Number(url.searchParams.get("limit")), offset = Number(url.searchParams.get("offset"));
      const orders = Array.from({ length: 21 }, (_, index) => index === 0 ? state.order
        : { ...state.order, id: "order_page_" + index, display_id: 42 + index });
      const filtered = orders.filter((order) => !url.searchParams.get("status") || order.status === url.searchParams.get("status"));
      await reply({ orders: filtered.slice(offset, offset + limit), limit, offset, count: filtered.length }); return;
    }
    if (url.pathname === path && method === "GET") { await reply({ picking: state.order }); return; }
    if (url.pathname.startsWith(path + "/") && ["POST", "PUT"].includes(method)) {
      const body: Record<string, unknown> = request.postDataJSON();
      state.writes.push({ path: url.pathname, body });
      await state.beforeWrite?.();
      if (state.conflict) { state.conflict(state.order); await reply({ code: "PICKING_CONFLICT" }, 409); return; }
      if (state.loseResponse) { await route.abort("failed"); return; }
      if (url.pathname.endsWith("/claim")) {
        expect(body).toEqual({});
        if (state.order.status === "IN_PROGRESS" && state.order.assigned_member_id === "member_fixture") {
          await reply({ picking: state.order, applied_revision: state.order.revision }); return;
        }
        state.order.status = "IN_PROGRESS"; state.order.assigned_member_id = "member_fixture";
      } else {
        expect(body.expected_revision).toBe(state.order.revision);
        if (url.pathname.endsWith("/lines/line_fixture")) {
          const quantity = body.picked_quantity;
          if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0 || quantity > 5 || (quantity === 5 && body.shortage_recorded)) { await reply({}, 400); return; }
          expect(Object.keys(body).sort()).toEqual(["expected_revision", "picked_quantity", "shortage_recorded"]);
          Object.assign(state.order.lines[0], { picked_quantity: quantity, shortage_recorded: body.shortage_recorded, unresolved_quantity: 5 - quantity });
        } else if (url.pathname.endsWith("/reassign")) {
          expect(body).toEqual({ expected_revision: state.order.revision, target_member_id: "member_other" });
          state.order.assigned_member_id = "member_other";
        } else if (url.pathname.endsWith("/complete")) {
          expect(body).toEqual({ expected_revision: state.order.revision, confirmed: true });
          state.order.status = "COMPLETED"; state.order.completed_at = "2026-10-12T11:00:00Z";
        }
      }
      state.order.revision++;
      await reply({ picking: state.order, applied_revision: state.order.revision }); return;
    }
    await reply({}, 404);
  });
  return state;
}
function assigned(order: PickingOrder, member = "member_fixture") {
  order.status = "IN_PROGRESS"; order.assigned_member_id = member; order.revision = 1;
}
async function detail(page: Page) {
  await page.goto(base + path);
  await expect(page.getByRole("heading", { name: "Pick order #42", exact: true })).toBeVisible();
}
async function openQueueOrder(page: Page) {
  // App Router click completion is not route/data completion. Observe the actual
  // browser detail request before checking the URL and hydrated action controls.
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.origin === "http://localhost:9000" && url.pathname === path
        && candidate.request().method() === "GET";
    }),
    page.getByRole("link", { name: "Pick order #42", exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Pick order #42", exact: true })).toBeVisible();
  await expect(page).toHaveURL(base + path);
  await expect(page.getByRole("button", { name: "Claim picking", exact: true })).toBeEnabled();
}
async function saved(page: Page, quantity: string) {
  await page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true }).fill(quantity);
  await page.getByRole("button", { name: "Save Fixture tomatoes", exact: true }).click();
  await expect(page.getByText("Picking saved. Showing the latest state.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveValue(quantity);
  await expect(page.getByRole("button", { name: "Save Fixture tomatoes", exact: true })).toBeEnabled();
}
// Include the queue: its cold document/chunk load consumed the first journey.
// HTTP route readiness compiles the queue and dynamic routes without sharing browser
// auth/mocks. Fresh contexts and fixtures remain per-test; no timeout inflation.
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    for (const route of ["/merchant/picking", path, "/application"]) {
      const response = await request.get(base + route);
      expect(response.status()).toBe(200); await response.body();
    }
  } finally { await request.dispose(); }
});
// Document readiness above does not load/evaluate browser chunks or exercise RSC
// navigation. The OWNER trace reached the detail GET only at the test deadline
// after page startup and Fast Refresh. Prepare that path in an isolated context;
// every journey below still installs fresh mocks and performs its own real click.
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const state = await mock(page, "OWNER");
    await page.goto(base + "/merchant/picking");
    await openQueueOrder(page);
    expect(state.writes).toHaveLength(0);
  } finally {
    await context.close();
  }
});
for (const role of ["OWNER", "MANAGER", "PICKER"] as const) {
  test(role + " can open the picking queue and self-claim", async ({ page }) => {
    const state = await mock(page, role);
    await page.goto(base + "/merchant/picking");
    await openQueueOrder(page);
    await page.getByRole("button", { name: "Claim picking", exact: true }).click();
    await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(1);
    if (role === "PICKER") {
      await expect(page.getByRole("link", { name: "Orders", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Reassign picking", exact: true })).toHaveCount(0);
      await page.goto(base + "/merchant/orders");
      await expect(page.getByRole("link", { name: "Picking", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
      expect(state.reads.some((url) => url.startsWith("/merchant/orders"))).toBe(false);
      expect(state.reads).not.toContain("/merchant/team");
    }
  });
}
test("queue uses server pages and filters before real detail navigation", async ({ page }) => {
  const state = await mock(page);
  await page.goto(base + "/merchant/picking");
  await expect(page.getByRole("link", { name: "Pick order #42", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("link", { name: "Pick order #62", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pick order #42", exact: true })).toHaveCount(0);
  expect(state.reads).toContain("/merchant/picking?limit=20&offset=20");
  await page.getByRole("combobox", { name: "Picking status", exact: true }).selectOption("COMPLETED");
  await expect(page.getByText("No picking orders found.", { exact: true })).toBeVisible();
  expect(state.reads).toContain("/merchant/picking?limit=20&offset=0&status=COMPLETED");
  await page.getByRole("combobox", { name: "Picking status", exact: true }).selectOption("NOT_STARTED");
  await openQueueOrder(page);
});
test("absolute quantity, shortage correction and explicit completion survive reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mock(page); assigned(state.order);
  await detail(page);
  await page.getByLabel("Short or unavailable: Fixture tomatoes", { exact: true }).check();
  await saved(page, "3");
  expect(state.writes[0].body).toEqual({ expected_revision: 1, picked_quantity: 3, shortage_recorded: true });
  await expect(page.getByText("Yes — original goods still needed", { exact: false })).toBeVisible();
  await expect(page.getByRole("article", { name: "Fixture tomatoes" }).getByText("2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toBeDisabled();
  await page.getByLabel("Short or unavailable: Fixture tomatoes", { exact: true }).uncheck();
  await saved(page, "3");
  await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toBeDisabled();
  expect(state.order.lines[0]).toMatchObject({ picked_quantity: 3, shortage_recorded: false, unresolved_quantity: 2 });
  await saved(page, "5");
  await page.getByRole("button", { name: "Complete picking", exact: true }).click();
  expect(state.writes).toHaveLength(3);
  await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Completed", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(4);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Completed", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Save Fixture|Claim picking|Complete picking|Reassign picking/ })).toHaveCount(0);
});
test("over-ordered quantity is rejected and authoritative quantity restored without replay", async ({ page }) => {
  const state = await mock(page); assigned(state.order); await detail(page);
  await page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Save Fixture tomatoes", exact: true }).click();
  await expect(page.getByText(/Check the picked quantity and shortage marker/)).toBeVisible();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveValue("0");
  expect(state.writes).toHaveLength(1);
});
test("claim conflict refetches the winning assignee and remains read-only", async ({ page }) => {
  const state = await mock(page); state.conflict = (order) => assigned(order, "member_other"); await detail(page);
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === path + "/claim" && item.status() === 409);
  await page.getByRole("button", { name: "Claim picking", exact: true }).click(); await response;
  await expect(page.getByText("Assignee: Member member_other", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1); expect(state.reads.filter((url) => url === path).length).toBeGreaterThanOrEqual(2);
});
for (const role of ["OWNER", "MANAGER"] as const) {
  test(role + " explicitly reassigns from eligible team without losing progress", async ({ page }) => {
    const state = await mock(page, role); assigned(state.order);
    Object.assign(state.order.lines[0], { picked_quantity: 3, shortage_recorded: true, unresolved_quantity: 2 });
    await detail(page); await page.getByRole("button", { name: "Reassign picking", exact: true }).click();
    await page.getByRole("combobox", { name: "New assignee", exact: true }).selectOption("member_other");
    await expect(page.getByRole("option", { name: /member_inactive/ })).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
    await page.getByRole("button", { name: "Confirm reassignment", exact: true }).click();
    await expect(page.getByText("Assignee: Member member_other", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Shortage: Yes/)).toBeVisible();
    expect(state.order.lines[0]).toMatchObject({ picked_quantity: 3, shortage_recorded: true, unresolved_quantity: 2 });
    expect(state.writes).toHaveLength(1);
  });
}
test("peer read is immutable and focus removes an old assignee's controls", async ({ page }) => {
  const state = await mock(page); assigned(state.order, "member_other"); await detail(page);
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
  assigned(state.order); await page.getByRole("button", { name: "Refresh picking", exact: true }).click();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toBeEnabled();
  state.order.assigned_member_id = "member_other"; state.order.revision++;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Assignee: Member member_other", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
for (const action of ["line", "completion"] as const) {
  test("stale " + action + " refetches authoritative state without another write", async ({ page }) => {
    const state = await mock(page); assigned(state.order);
    if (action === "completion") Object.assign(state.order.lines[0], { picked_quantity: 5, unresolved_quantity: 0 });
    state.conflict = (order) => {
      order.revision++;
      if (action === "completion") order.status = "COMPLETED";
      else Object.assign(order.lines[0], { picked_quantity: 3, unresolved_quantity: 2 });
    };
    await detail(page);
    if (action === "line") {
      await page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true }).fill("2");
      await page.getByRole("button", { name: "Save Fixture tomatoes", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Complete picking", exact: true }).click();
      await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
    }
    await expect(page.getByText("Picking changed. Review the refreshed state before continuing.", { exact: true })).toBeVisible();
    if (action === "completion") {
      await expect(page.getByRole("heading", { name: "Completed", exact: true })).toBeVisible();
      await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveValue("3");
    }
    expect(state.writes).toHaveLength(1); expect(state.reads.filter((url) => url === path).length).toBeGreaterThanOrEqual(2);
  });
}
test("membership loss removes protected data and controls", async ({ page }) => {
  const state = await mock(page); assigned(state.order); await detail(page);
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toBeEnabled();
  state.active = false; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(base + "/application");
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("duplicate claim clicks produce one request and uncertain claim only refetches", async ({ page }) => {
  const state = await mock(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.beforeWrite = () => gate; state.loseResponse = true;
  await detail(page);
  await page.getByRole("button", { name: "Claim picking", exact: true }).evaluate((button) => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected claim button"); button.click(); button.click(); });
  try {
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(page.getByRole("button", { name: "Claim picking", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByText("Picking could not be confirmed. Refresh before taking another action.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claim picking", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  expect(state.reads.filter((url) => url === path).length).toBeGreaterThanOrEqual(2);
});
test("queue failure exposes a safe explicit refresh", async ({ page }) => {
  const state = await mock(page); state.outage = true;
  await page.goto(base + "/merchant/picking");
  await expect(page.getByRole("alert").filter({ hasText: "Picking could not be confirmed." })).toHaveText("Picking could not be confirmed. Refresh before taking another action.");
  state.outage = false; await page.getByRole("button", { name: "Refresh picking queue", exact: true }).click();
  await expect(page.getByRole("link", { name: "Pick order #42", exact: true })).toBeVisible();
});

test("same-member claim replay restores the existing session", async ({ page }) => {
  const state = await mock(page); await detail(page);
  // Another device belonging to this employee claimed after this page loaded.
  assigned(state.order);
  await page.getByRole("button", { name: "Claim picking", exact: true }).click();
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  expect(state.order.revision).toBe(1);
});
