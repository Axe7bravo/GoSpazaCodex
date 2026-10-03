import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CartFoundation, DeliveryAvailability, DeliverySelection, SelectDeliveryInput, ReleaseDeliveryInput } from "@gospaza/contracts";
import { transition } from "./transitions";

const base = "http://localhost:3000";
const selectionPath = "/store/gospaza/cart/delivery-selection";
const optionsPath = "/store/gospaza/cart/delivery-options";
const timezone = "Africa/Johannesburg";
const empty: DeliverySelection = { state: "unselected", revision: 0, timezone, selection: null };
const foundation: CartFoundation = {
  state: "current", eligibility: "pending",
  cart: { id: "cart_delivery", store: { id: "mstore_delivery", name: "Fixture Grocer" }, currency_code: "zar",
    item_count: 1, subtotal_minor: 1000, items: [{ id: "cali_delivery", product_id: "prod_delivery", variant_id: "variant_delivery",
      product_title: "Fixture groceries", variant_title: "Standard", image_url: null, quantity: 1, unit_price_minor: 1000, subtotal_minor: 1000 }] },
};
async function mock(page: Page) {
  const now = Date.now();
  const iso = (minutes: number) => new Date(now + minutes * 60000).toISOString();
  const availability: DeliveryAvailability = {
    revision: 0, timezone, as_of: iso(0),
    options: [
      { id: "doption_asap", mode: "ASAP", revision: 1, fee_minor: 2500, currency_code: "zar" },
      { id: "doption_scheduled", mode: "SCHEDULED", revision: 1, fee_minor: 2500, currency_code: "zar" },
    ],
    slots: [
      { id: "dslot_first", revision: 1, start_at: iso(120), end_at: iso(180), remaining: 1 },
      { id: "dslot_second", revision: 1, start_at: iso(240), end_at: iso(300), remaining: 1 },
    ],
  };
  const state = {
    selection: structuredClone(empty), availability, foundation: structuredClone(foundation),
    writes: [] as (SelectDeliveryInput | ReleaseDeliveryInput)[],
    rejectNext: "", outage: false, unavailable: false,
    beforeRead: undefined as (() => Promise<void>) | undefined,
  };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const headers = { "access-control-allow-origin": base, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-publishable-api-key", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_delivery" } }); return; }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_delivery", email: "delivery@example.test", first_name: null, last_name: null } }); return; }
    if (path === "/store/gospaza/cart") { await reply(state.foundation); return; }
    if (path === selectionPath && method === "GET") {
      const snapshot = structuredClone(state.selection);
      await state.beforeRead?.();
      await reply(state.outage ? { code: "DELIVERY_REFRESH_REQUIRED" } : snapshot, state.outage ? 503 : 200); return;
    }
    if (path === optionsPath) {
      await reply(state.unavailable ? { code: "DELIVERY_UNAVAILABLE" } : { ...state.availability, revision: state.selection.revision }, state.unavailable ? 409 : 200); return;
    }
    if (path === selectionPath && method === "PUT") {
      const body = request.postDataJSON() as SelectDeliveryInput;
      state.writes.push(body);
      if (state.rejectNext) { const code = state.rejectNext; state.rejectNext = ""; await reply({ code }, 409); return; }
      expect(body.expected_revision).toBe(state.selection.revision);
      const option = state.availability.options.find((item) => item.id === body.option_id);
      const slot = state.availability.slots.find((item) => item.id === (body.slot_id ?? "dslot_first"));
      expect(option).toBeDefined(); expect(slot).toBeDefined();
      if (!option || !slot) throw new Error("Invalid delivery fixture selection");
      expect(body.expected_option_revision).toBe(option.revision);
      state.selection = { state: "held", revision: state.selection.revision + 1, timezone,
        selection: { id: "dres_fixture", option_id: option.id, slot_id: slot.id, start_at: slot.start_at, end_at: slot.end_at,
          expires_at: iso(15), fee_minor: option.fee_minor, currency_code: "zar" } };
      await reply(state.selection); return;
    }
    if (path === selectionPath && method === "DELETE") {
      const body = request.postDataJSON() as ReleaseDeliveryInput;
      state.writes.push(body);
      expect(body).not.toHaveProperty("location");
      expect(body.expected_revision).toBe(state.selection.revision);
      state.selection = { ...empty, revision: state.selection.revision + 1 };
      await reply(state.selection); return;
    }
    await reply({}, 404);
  });
  return state;
}
async function locate(page: Page) {
  await transition(page, { responses: [{ path: optionsPath, method: "POST" }] },
    () => page.getByRole("button", { name: "Use current location", exact: true }).click());
  await expect(page.getByLabel("Delivery option", { exact: true })).toBeEnabled();
}
async function choose(page: Page, mode: "asap" | "scheduled", slot = "dslot_first", status = 200) {
  await page.getByLabel("Delivery option", { exact: true }).selectOption("doption_" + mode);
  if (mode === "scheduled") await page.getByLabel("Delivery date and time", { exact: true }).selectOption(slot);
  await transition(page, { responses: [{ path: selectionPath, method: "PUT", status }] },
    () => page.getByRole("button", { name: "Confirm delivery selection", exact: true }).click());
}
test.beforeAll(async ({ request }) => {
  for (const path of ["/cart", "/stores"]) {
    const response = await request.get(base + path);
    expect(response.ok()).toBe(true);
    await response.dispose();
  }
});
test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["geolocation"], { origin: base });
  await context.setGeolocation({ latitude: -29, longitude: 26 });
});

test("delivery discovery, ASAP, reload restoration, scheduled replacement and location-free release", async ({ page }) => {
  const state = await mock(page);
  await page.goto(base + "/cart");
  await locate(page);
  await choose(page, "asap");
  await expect(page.getByRole("heading", { name: "Reserved delivery window", exact: true })).toBeVisible();
  const expiry = state.selection.selection?.expires_at;
  expect(state.writes[0]).toEqual({ cart_id: "cart_delivery", location: { latitude: -29, longitude: 26 },
    option_id: "doption_asap", expected_revision: 0, expected_option_revision: 1 });
  await page.reload();
  await expect(page.locator(".delivery-hold time")).toHaveAttribute("datetime", expiry ?? "missing");
  expect(state.writes).toHaveLength(1);
  await transition(page, { responses: [{ path: selectionPath, method: "GET" }] },
    () => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
  await expect(page.locator(".delivery-hold time")).toHaveAttribute("datetime", expiry ?? "missing");
  await page.getByRole("link", { name: "Stores", exact: true }).click();
  await expect(page).toHaveURL(base + "/stores");
  await page.getByRole("link", { name: "Cart (1)", exact: true }).click();
  await expect(page).toHaveURL(base + "/cart");
  await expect(page.locator(".delivery-hold time")).toHaveAttribute("datetime", expiry ?? "missing");
  expect(state.writes).toHaveLength(1);
  await locate(page);
  await choose(page, "scheduled", "dslot_second");
  await expect(page.getByRole("button", { name: "Release delivery selection", exact: true })).toBeEnabled();
  expect(state.selection.selection?.slot_id).toBe("dslot_second");
  await page.getByRole("button", { name: "Change location", exact: true }).click();
  await expect(page.getByText("Choose a delivery location to see options. You can still release an existing reservation.", { exact: true })).toBeVisible();
  await transition(page, { responses: [{ path: selectionPath, method: "DELETE" }] },
    () => page.getByRole("button", { name: "Release delivery selection", exact: true }).click());
  await expect(page.getByText("No active delivery reservation.", { exact: true })).toBeVisible();
  expect(state.writes.at(-1)).toEqual({ cart_id: "cart_delivery", reservation_id: "dres_fixture", expected_revision: 2 });
});

for (const code of ["DELIVERY_SELECTION_STALE", "DELIVERY_SLOT_UNAVAILABLE", "DELIVERY_CONFIGURATION_STALE"]) {
  test("delivery reconfirmation after " + code, async ({ page }) => {
    const state = await mock(page);
    await page.goto(base + "/cart");
    await locate(page);
    state.rejectNext = code;
    state.availability.options = state.availability.options.map((option) => ({ ...option, revision: 2, fee_minor: 3500 }));
    await choose(page, "scheduled", "dslot_first", 409);
    await expect(page.getByText("Delivery availability or your selection changed. Review the refreshed options and fee, then confirm again.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Delivery option", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Confirm delivery selection", exact: true })).toBeDisabled();
    expect(state.writes).toHaveLength(1);
    await choose(page, "scheduled", "dslot_second");
    await expect(page.locator(".delivery-hold")).toContainText("35");
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).toHaveProperty("expected_option_revision", 2);
  });
}

test("expiry is server-restored and outages, unavailable slots and location errors can be refreshed", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await mock(page);
  await page.goto(base + "/cart");
  await locate(page);
  await choose(page, "asap");
  await expect(page.getByRole("button", { name: "Release delivery selection", exact: true })).toBeEnabled();
  state.selection = { ...empty, state: "expired", revision: 2 };
  await transition(page, { responses: [{ path: selectionPath, method: "GET" }] },
    () => page.clock.fastForward(16 * 60000));
  await expect(page.getByText("Your delivery selection is expired. Review availability and confirm a new selection.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reserved delivery window", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  state.outage = true;
  await page.getByRole("button", { name: "Refresh delivery", exact: true }).click();
  await expect(page.locator('.delivery-panel [role="alert"]')).toHaveText("Delivery could not be loaded. Please try again.");
  state.outage = false;
  state.unavailable = true;
  await page.getByRole("button", { name: "Refresh delivery", exact: true }).click();
  await expect(page.locator('.delivery-panel [role="alert"]')).toContainText("Delivery availability");
  state.unavailable = false;
  state.availability.slots = [];
  await page.getByRole("button", { name: "Refresh delivery", exact: true }).click();
  await expect(page.getByText("No delivery windows are currently available.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm delivery selection", exact: true })).toBeDisabled();
});

test("failed location availability does not block releasing a restored hold", async ({ page }) => {
  const state = await mock(page);
  await page.goto(base + "/cart");
  await locate(page);
  await choose(page, "asap");
  await expect(page.getByRole("button", { name: "Release delivery selection", exact: true })).toBeEnabled();
  state.unavailable = true;
  await page.getByRole("button", { name: "Refresh delivery", exact: true }).click();
  await expect(page.locator('.delivery-panel [role="alert"]')).toContainText("Delivery availability");
  await transition(page, { responses: [{ path: selectionPath, method: "DELETE" }] },
    () => page.getByRole("button", { name: "Release delivery selection", exact: true }).click());
  await expect(page.getByRole("heading", { name: "Reserved delivery window", exact: true })).toHaveCount(0);
  expect(state.writes.at(-1)).not.toHaveProperty("location");
});

for (const stateName of ["stale", "unavailable", "expired"] as const) {
  test("authoritative " + stateName + " restoration removes the valid-hold presentation", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const state = await mock(page);
    await page.goto(base + "/cart");
    await locate(page);
    await choose(page, "asap");
    await expect(page.getByRole("button", { name: "Release delivery selection", exact: true })).toBeEnabled();
    const displayedExpiry = state.selection.selection?.expires_at;
    expect(displayedExpiry).toBeDefined();
    if (!displayedExpiry) throw new Error("Missing held fixture expiry");
    expect(await page.evaluate(() => Date.now())).toBeLessThan(Date.parse(displayedExpiry));
    // The server may invalidate/expire the hold while the browser still thinks
    // time remains. Restoration must win over the local display timer.
    state.selection = { ...empty, state: stateName, revision: 2 };
    await transition(page, { responses: [{ path: selectionPath, method: "GET" }] },
      () => page.evaluate(() => window.dispatchEvent(new Event("focus"))));
    await expect(page.getByText("Your delivery selection is " + stateName + ". Review availability and confirm a new selection.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reserved delivery window", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Release delivery selection", exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(1, "restoration must never renew or reselect");
    await expect(page.getByRole("button", { name: /checkout/i })).toHaveCount(0);
    const persisted = await page.evaluate(() => Object.values(localStorage).join("\n"));
    expect(persisted).not.toContain("dres_fixture");
    expect(persisted).not.toContain("doption_asap");
  });
}

test("a hold response delayed beyond expiry is revalidated without renewal", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await mock(page);
  const slot = state.availability.slots[0];
  expect(slot).toBeDefined();
  if (!slot) throw new Error("Missing delivery fixture slot");
  state.selection = {
    state: "held", revision: 1, timezone,
    selection: { id: "dres_delayed", option_id: "doption_asap", slot_id: slot.id,
      start_at: slot.start_at, end_at: slot.end_at, expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      fee_minor: 2500, currency_code: "zar" },
  };
  let releaseRead: (() => void) | undefined;
  let markReadStarted: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const started = new Promise<void>((resolve) => { markReadStarted = resolve; });
  state.beforeRead = async () => {
    state.beforeRead = undefined;
    markReadStarted?.();
    await gate;
  };
  try {
    await page.goto(base + "/cart");
    await started;
    await page.clock.fastForward(16 * 60000);
    state.selection = { ...empty, state: "expired", revision: 2 };
  } finally {
    releaseRead?.();
  }
  await expect(page.getByText("Your delivery selection is expired. Review availability and confirm a new selection.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reserved delivery window", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0, "expiry revalidation must not renew the hold");
});
