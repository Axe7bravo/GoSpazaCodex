import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DriverAvailabilityDTO, DriverCommitmentDTO, OrderDispatchDTO } from "@gospaza/contracts";

async function fixture(page: Page, kind: "MERCHANT" | "PLATFORM" = "MERCHANT") {
  const state = {
    availability: { intent: "OFFLINE", revision: 1, generation: null, effective: "OFFLINE",
      location_fresh: false, available_since: null, location_sequence: 0 } as DriverAvailabilityDTO,
    commitment: null as DriverCommitmentDTO | null,
    delivery: { status: "FINDING_DRIVER", phase: "MERCHANT" } as OrderDispatchDTO,
    writes: [] as string[], conflict: false, denied: false, lostAcceptanceResponse: false, reads: [] as string[],
    gate: undefined as Promise<void> | undefined,
  };
  await page.route("http://localhost:9000/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    const headers = { "access-control-allow-origin": req.headers().origin ?? "http://localhost:3002",
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "cache-control": "no-store" };
    const reply = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ headers, status: 204 }); return; }
    if (method === "GET") state.reads.push(path);
    if (path === "/driver/onboarding/me") { await reply({ onboarding: true }); return; }
    if (path === "/driver/profile") {
      await reply({ profile: { id: "drv_fixture", display_name: "Fixture Driver", contact_phone: "0821234567", status: "ACTIVE", revision: 2 },
        affiliation: { id: "aff_fixture", kind, status: "ACTIVE", revision: 1, merchant_store_id: kind === "MERCHANT" ? "store_fixture" : null, created_at: new Date().toISOString() },
        eligibility: { eligible: true, reason: "ELIGIBLE" } }); return;
    }
    if (path === "/driver/affiliations") { await reply({ items: [], count: 0, limit: 20, offset: 0 }); return; }
    if (path === "/driver/availability") { await reply(state.availability); return; }
    if (path === "/driver/dispatch/current") { await reply({ commitment: state.denied ? null : state.commitment }); return; }
    if (path.startsWith("/driver/") && method !== "GET") {
      state.writes.push(path);
      await state.gate;
      const body = req.postDataJSON();
      if (path === "/driver/location") {
        expect(Object.keys(body).sort()).toEqual(["accuracy", "generation", "latitude", "longitude", "sequence"]);
        state.availability.location_fresh = true; state.availability.location_sequence = body.sequence;
        state.availability.effective = state.commitment ? "BUSY" : "AVAILABLE";
      } else if (path.includes("/availability/")) {
        expect(body).toEqual({ expected_revision: state.availability.revision });
        const online = path.endsWith("/online");
        state.availability = { ...state.availability, intent: online ? "ONLINE" : "OFFLINE",
          generation: online ? "dgen_fixture" : state.availability.generation,
          effective: state.commitment ? "BUSY" : online ? "UNAVAILABLE" : "OFFLINE",
          revision: state.availability.revision + 1, location_fresh: false };
      } else if (path.includes("/offers/")) {
        expect(body).toEqual({ expected_revision: 1 });
        if (state.conflict) { state.commitment = null; await reply({}, 409); return; }
        if (state.denied) { await reply({}, 404); return; }
        if (path.endsWith("/accept") && state.commitment) {
          state.commitment = { ...state.commitment, status: "ASSIGNED", revision: 2, assigned_at: new Date().toISOString() };
          state.availability.effective = "BUSY";
          if (state.lostAcceptanceResponse) { await route.abort("failed"); return; }
        } else state.commitment = null;
      }
      await reply(state.availability); return;
    }
    if (path === "/merchant/me") {
      await reply({ merchant: { id: "mer_fixture", legal_name: "Fixture Shop", trading_name: "Fixture Shop" },
        store: { id: "store_fixture", name: "Fixture Shop" }, membership: { id: "member_fixture", member_type: "OWNER",
          capabilities: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_ORDER_VIEW"] } }); return;
    }
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_fixture" } }); return; }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_fixture", email: "fixture@example.test" } }); return; }
    if (path.endsWith("/delivery")) {
      if (state.denied) { await reply({}, 404); return; }
      await reply(path.startsWith("/merchant/") ? state.delivery : { status: state.delivery.status }); return;
    }
    if (path.endsWith("/shortages")) {
      await reply({ preference: { preference: "CONTACT_ME", revision: 0, chosen_at: null, frozen_at: null }, shortages: [] }); return;
    }
    if (path.endsWith("/orders/order_fixture")) {
      await reply({ order: { id: "order_fixture", display_id: 42, created_at: "2026-10-20T08:00:00Z",
        operational_status: "ACCEPTED", revision: 1, accepted_at: "2026-10-20T08:05:00Z", rejected_at: null, rejection_reason: null,
        currency_code: "zar", customer: { first_name: "Fixture", last_name: "Customer", city: "Bloemfontein" },
        store: { name: "Fixture Shop" }, items: [{ id: "line_fixture", title: "Tomatoes", variant_title: "1 kg", quantity: 1, unit_price_minor: 2500, total_minor: 2500 }],
        totals: { total_minor: 3500, subtotal_minor: 2500, tax_total_minor: 0, discount_total_minor: 0, shipping_total_minor: 1000 },
        pickup: { store_name: "Fixture Shop", address_line_1: "1 Store Street", city: "Bloemfontein", province: "FS", country_code: "za" },
        delivery: { starts_at: "2026-10-20T10:00:00Z", ends_at: "2026-10-20T11:00:00Z", shipping_name: "Scheduled" } } }); return;
    }
    await reply({}, 404);
  });
  return state;
}
function offer(): DriverCommitmentDTO {
  return { id: "dcommit_fixture", delivery_id: "delivery_fixture", status: "OFFERED", revision: 1,
    expires_at: new Date(Date.now() + 30000).toISOString(), assigned_at: null, restricted_content_present: true,
    attention_required: false, pickup_store: "Fixture Shop", destination_area: "Central service area" };
}
test("driver online, fresh location, stale location and offline use authoritative state", async ({ page, context }) => {
  const state = await fixture(page);
  await context.grantPermissions(["geolocation"]); await context.setGeolocation({ latitude: -29.1, longitude: 26.2 });
  await page.goto("http://localhost:3002/");
  await page.getByRole("button", { name: "Go online", exact: true }).click();
  await expect(page.getByText("Not available for new offers", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Share current location", exact: true }).click();
  await expect(page.getByText("Available for new offers", { exact: true })).toBeVisible();
  state.availability.location_fresh = false; state.availability.effective = "UNAVAILABLE";
  await page.getByRole("button", { name: "Refresh delivery work", exact: true }).click();
  await expect(page.getByText("Not available for new offers", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go offline", exact: true }).click();
  await expect(page.getByText("Intent: Offline", { exact: true })).toBeVisible();
});
test("offer acceptance is explicit, duplicate protected, restored and retained offline", async ({ page }) => {
  const state = await fixture(page); state.commitment = offer();
  state.availability.intent = "ONLINE"; state.availability.effective = "BUSY";
  await page.goto("http://localhost:3002/");
  await expect(page.getByText("Restricted items in this delivery", { exact: true })).toBeVisible();
  let release: () => void = () => {};
  state.gate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Accept offer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept offer", exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toBeVisible();
  expect(state.writes.filter(p => p.endsWith("/accept"))).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go offline", exact: true }).click();
  await expect(page.getByText("Intent: Offline", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toBeVisible();
});
test("lost acceptance response restores authoritative assignment without a second write", async ({ page }) => {
  const state = await fixture(page); state.commitment = offer(); state.lostAcceptanceResponse = true;
  await page.goto("http://localhost:3002/");
  await page.getByRole("button", { name: "Accept offer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toBeVisible();
  expect(state.reads.filter(path => path === "/driver/dispatch/current").length).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Accept offer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toBeVisible();
  expect(state.writes).toEqual(["/driver/offers/dcommit_fixture/accept"]);
});
for (const action of ["accept", "decline"] as const) test(action + " conflict refetches without replay", async ({ page }) => {
  const state = await fixture(page); state.commitment = offer(); state.conflict = true;
  await page.goto("http://localhost:3002/");
  await page.getByRole("button", { name: action === "accept" ? "Accept offer" : "Decline offer", exact: true }).click();
  await expect(page.getByText("No current delivery offer or assignment.", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.reads.filter(p => p === "/driver/dispatch/current").length).toBeGreaterThan(1);
});
test("expired and foreign offers expose no usable acceptance", async ({ page }) => {
  const state = await fixture(page); state.commitment = { ...offer(), expires_at: new Date(Date.now() - 1000).toISOString() };
  await page.goto("http://localhost:3002/");
  await expect(page.getByRole("button", { name: "Accept offer", exact: true })).toBeDisabled();
  state.denied = true;
  await page.getByRole("button", { name: "Refresh delivery work", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept offer", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("platform offer restores on direct navigation and decline reads the next state", async ({ page }) => {
  const state = await fixture(page, "PLATFORM"); state.commitment = offer();
  await page.goto("http://localhost:3002/");
  await expect(page.getByRole("heading", { name: "Delivery offer", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Decline offer", exact: true }).click();
  await expect(page.getByText("No current delivery offer or assignment.", { exact: true })).toBeVisible();
  expect(state.writes).toEqual(["/driver/offers/dcommit_fixture/decline"]);
});
test("denied geolocation never reports available or sends coordinates", async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition: (_success: unknown, failure: (error: { code: number }) => void) => failure({ code: 1 }),
    } });
  });
  await page.goto("http://localhost:3002/");
  await page.getByRole("button", { name: "Go online", exact: true }).click();
  await page.getByRole("button", { name: "Share current location", exact: true }).click();
  await expect(page.getByText("Location could not be obtained. Check permission and try sharing it again.", { exact: true })).toBeVisible();
  await expect(page.getByText("Available for new offers", { exact: true })).toHaveCount(0);
  expect(state.writes).not.toContain("/driver/location");
});
for (const actor of ["merchant", "customer"] as const) test(actor + " restores owned dispatch status without coordinates or assignment controls", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(actor === "merchant" ? "http://localhost:3001/merchant/orders/order_fixture" : "http://localhost:3000/orders/order_fixture");
  const region = page.getByRole("region", { name: "Delivery status", exact: true });
  await expect(region.getByText("Finding a driver", { exact: true })).toBeVisible();
  if (actor === "merchant") await expect(region.getByText("Searching merchant drivers", { exact: true })).toBeVisible();
  state.delivery.phase = "PLATFORM";
  await region.getByRole("button", { name: "Refresh delivery status" }).click();
  if (actor === "merchant") await expect(region.getByText("Searching platform drivers", { exact: true })).toBeVisible();
  state.delivery = { status: "ASSIGNED" };
  await page.reload();
  await expect(region.getByText("Driver assigned", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: /assign|fallback/i })).toHaveCount(0);
  expect(await region.textContent()).not.toMatch(/latitude|longitude|26\.2|-29\.1/);
  state.delivery = { status: "ATTENTION_REQUIRED" };
  await region.getByRole("button", { name: "Refresh delivery status" }).click();
  await expect(region.getByText("Delivery needs operational attention", { exact: true })).toBeVisible();
  await expect(region.getByText("The delivery requires review. This does not confirm a cancellation or refund.", { exact: true })).toBeVisible();
  await expect(region.getByText("Driver assigned", { exact: true })).toHaveCount(0);
  state.denied = true;
  await region.getByRole("button", { name: "Refresh delivery status" }).click();
  await expect(region.getByText("Driver assigned", { exact: true })).toHaveCount(0);
  await expect(region.getByRole("alert")).toBeVisible();
});
