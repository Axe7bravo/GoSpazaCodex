import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { AddressWrite, SavedAddress, ServiceZone, ZoneAssignment, ServiceZoneInput } from "@gospaza/contracts";

const customerBase = "http://localhost:3000", adminBase = "http://localhost:3003";
const geometry = { type: "Polygon" as const, coordinates: [[[20, -20], [21, -20], [21, -19], [20, -19], [20, -20]]] };
async function mock(page: Page, actor: "customer" | "user", serviceable = true) {
  const state = { addresses: [] as SavedAddress[], zones: [] as ServiceZone[], assignments: [] as ZoneAssignment[] };
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? (actor === "customer" ? customerBase : adminBase),
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "cache-control": "no-store",
    };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (path === "/store/gospaza/me" || path === "/admin/gospaza/me") {
      await reply({ actor: { type: actor, id: actor + "_fixture" } }); return;
    }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_fixture", email: "fixture@example.test", first_name: null, last_name: null } }); return; }
    if (path === "/store/gospaza/cart") { await reply({ cart: null, state: "empty", eligibility: "pending" }); return; }
    if (path === "/store/gospaza/addresses") {
      if (method === "POST") { state.addresses.push({ ...request.postDataJSON() as AddressWrite, id: "cuaddr_fixture" }); await reply({ success: true }, 201); return; }
      await reply({ addresses: state.addresses }); return;
    }
    if (path === "/store/gospaza/addresses/cuaddr_fixture") {
      if (method === "DELETE") state.addresses = [];
      if (method === "PATCH") state.addresses = [{ ...request.postDataJSON() as AddressWrite, id: "cuaddr_fixture" }];
      await reply({ success: true }); return;
    }
    if (path === "/store/gospaza/serviceability") {
      await reply({ serviceable, eligible_store_count: serviceable ? 1 : 0, zone_ids: serviceable ? ["gszone_fixture"] : [] }); return;
    }
    if (path === "/admin/gospaza/service-zones") {
      if (method === "POST") {
        const zone = { ...request.postDataJSON() as ServiceZoneInput, id: "gszone_fixture" };
        state.zones.push(zone); await reply({ zone, assignments: state.assignments }, 201); return;
      }
      await reply({ zones: state.zones, stores: [{ id: "mstore_fixture", name: "Fixture Shop", active: true, merchant_status: "ACTIVE" }] }); return;
    }
    if (path === "/admin/gospaza/service-zones/gszone_fixture") {
      if (method === "PATCH") state.zones = [{ ...request.postDataJSON() as ServiceZoneInput, id: "gszone_fixture" }];
      await reply({ zone: state.zones[0], assignments: state.assignments }); return;
    }
    if (path === "/admin/gospaza/service-zones/gszone_fixture/stores") {
      state.assignments = [{ id: "mstore_fixture", name: "Fixture Shop", active: true }];
      await reply({ zone: state.zones[0], assignments: state.assignments }); return;
    }
    if (path === "/admin/gospaza/service-zones/gszone_fixture/stores/mstore_fixture") {
      state.assignments[0]!.active = false;
      await reply({ zone: state.zones[0], assignments: state.assignments }); return;
    }
    await reply({}, 404);
  });
  return state;
}
test.beforeAll(async ({ request }) => {
  for (const url of [customerBase + "/account/addresses", adminBase + "/admin/service-zones"]) {
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    await response.dispose();
  }
});
test("admin creates, edits and assigns a geographic service zone", async ({ page }) => {
  const state = await mock(page, "user");
  await page.goto(adminBase + "/admin/service-zones");
  await expect(page.getByText("No service zones configured.", { exact: true })).toBeVisible();
  await page.getByLabel("Zone name", { exact: true }).fill("Fixture delivery zone");
  await page.getByLabel("Delivery fee (ZAR cents)", { exact: true }).fill("2500");
  await page.getByLabel("GeoJSON geometry", { exact: true }).fill(JSON.stringify(geometry));
  await page.getByRole("button", { name: "Save zone", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit zone", exact: true })).toBeVisible();
  await page.getByLabel("Merchant store", { exact: true }).selectOption("mstore_fixture");
  await page.getByRole("button", { name: "Assign store", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unassign Fixture Shop", exact: true })).toBeVisible();
  await page.getByLabel("Zone name", { exact: true }).fill("Updated zone");
  await page.getByLabel("Active zone", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save zone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Updated zone", exact: true })).toBeVisible();
  expect(state.zones[0]?.active).toBe(false);
  expect(state.zones[0]?.delivery_fee_minor).toBe(2500);
  await page.getByRole("button", { name: "Unassign Fixture Shop", exact: true }).click();
  await expect(page.getByText("No active assignments.", { exact: true })).toBeVisible();
});
for (const serviceable of [true, false]) {
  test("customer saves coordinates and sees " + (serviceable ? "serviceable" : "unavailable") + " result", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"], { origin: customerBase });
    await context.setGeolocation({ latitude: -19.5, longitude: 20.5 });
    const state = await mock(page, "customer", serviceable);
    await page.goto(customerBase + "/account/addresses");
    await expect(page.getByText("No saved addresses.", { exact: true })).toBeVisible();
    for (const [label, value] of [["First name", "Test"], ["Last name", "Customer"], ["Address line 1", "1 Test Street"], ["City", "Test city"], ["Province", "Test province"], ["Postal code", "1234"]]) {
      await page.getByLabel(label!, { exact: true }).fill(value!);
    }
    await page.getByRole("button", { name: "Use current location", exact: true }).click();
    await expect(page.getByText("Coordinates attached: -19.5, 20.5", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Check serviceability", exact: true }).click();
    await expect(page.getByText(serviceable ? "Delivery is available at these coordinates." : "Delivery is not available at these coordinates.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save address", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit 1 Test Street", exact: true })).toBeVisible();
    expect(state.addresses[0]?.location).toEqual({ latitude: -19.5, longitude: 20.5, source: "browser_geolocation" });
    await page.getByRole("button", { name: "Edit 1 Test Street", exact: true }).click();
    await page.getByLabel("Address line 1", { exact: true }).fill("2 Test Street");
    await page.getByRole("button", { name: "Save address", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete 2 Test Street", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete 2 Test Street", exact: true }).click();
    await expect(page.getByText("No saved addresses.", { exact: true })).toBeVisible();
  });
}
for (const code of [1, 2]) test("customer geolocation error " + code + " is explicit", async ({ page }) => {
  await mock(page, "customer");
  await page.addInitScript((code) => {
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => {
        failure({ code, message: "Location error", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
      },
    } });
  }, code);
  await page.goto(customerBase + "/account/addresses");
  await page.getByRole("button", { name: "Use current location", exact: true }).click();
  await expect(page.getByText(code === 1 ? "Location permission denied. You can still save your address without coordinates." : "Current location is unavailable. Please try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check serviceability", exact: true })).toBeDisabled();
});
