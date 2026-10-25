import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixture, offer } from "./fixtures/delivery";
type Phase = "PREPARING" | "PICKUP_READY" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "ATTENTION_REQUIRED";
async function delivery(page: Page) {
  const base = await fixture(page);
  base.commitment = { ...offer(), status: "ASSIGNED", revision: 2, restricted_content_present: false };
  base.availability.effective = "BUSY";
  const state = { phase: "PICKUP_READY" as Phase, revision: 4, restricted: false, denied: false, stale: false,
    code: "314159", expires: new Date(Date.now() + 600000).toISOString(), regenerate: false,
    writes: [] as string[], reads: [] as string[], lose: false, gate: undefined as Promise<void> | undefined };
  await page.route("http://localhost:9000/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    const handled = path.startsWith("/driver/deliveries/") || path === "/driver/location" && req.postData()?.includes('"DELIVERY"')
      || /\/orders\/order_fixture\/(delivery|tracking|handoff-code(?:\/regenerate)?)$/.test(path);
    if (!handled) { await route.fallback(); return; }
    const headers = { "access-control-allow-origin": req.headers().origin ?? "http://localhost:3002",
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "cache-control": "private, no-store" };
    const reply = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method === "GET") state.reads.push(path);
    if (state.denied || path.includes("foreign")) { await reply({}, 404); return; }
    const handoff = () => ({ delivery_id: "delivery_fixture", revision: state.revision,
      state: ["PREPARING", "PICKUP_READY"].includes(state.phase) ? "UNAVAILABLE" : state.phase,
      arrived_at: state.phase === "ARRIVED" ? "2026-10-24T12:00:00Z" : null,
      delivered_at: state.phase === "DELIVERED" ? "2026-10-24T12:01:00Z" : null, compliance_required: state.restricted });
    if (method === "GET" && path.endsWith("/current")) {
      await reply({ pickup: state.phase === "DELIVERED" ? null : { delivery_id: "delivery_fixture", revision: state.revision,
        state: state.phase === "ARRIVED" ? "IN_TRANSIT" : state.phase, picked_up_at: null, restricted_content_present: state.restricted } }); return;
    }
    if (method === "GET" && path.endsWith("/latest")) { await reply({ handoff: handoff() }); return; }
    if (method === "GET" && path.endsWith("/handoff")) { await reply(handoff()); return; }
    if (path.endsWith("/delivery")) {
      await reply({ status: state.phase === "ATTENTION_REQUIRED" ? "ATTENTION_REQUIRED" : "ASSIGNED",
        ...(["PREPARING", "PICKUP_READY"].includes(state.phase) ? { pickup_state: state.phase } : { delivery_phase: state.phase }) }); return;
    }
    if (method === "GET" && path.endsWith("/tracking")) {
      await reply({ state: state.phase, tracking: !state.stale && ["IN_TRANSIT", "ARRIVED"].includes(state.phase)
        ? { latitude: -29.12345, longitude: 26.23456, recorded_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120000).toISOString(), stale: false } : null }); return;
    }
    if (method === "GET" && path.endsWith("/handoff-code")) {
      await reply({ state: Date.parse(state.expires) > Date.now() ? "AVAILABLE" : "EXPIRED", code: state.code,
        expires_at: state.expires, revision: state.revision, can_regenerate: state.regenerate, compliance_required: state.restricted }); return;
    }
    if (method === "POST" || method === "PUT") {
      state.writes.push(path); await state.gate;
      const body = req.postDataJSON();
      if (path.endsWith("/location")) {
        expect(Object.keys(body).sort()).toEqual(["accuracy", "generation", "latitude", "longitude", "purpose", "sequence"]);
        await reply({ accepted: true }); return;
      }
      if (path.endsWith("/verify")) {
        expect(Object.keys(body).sort()).toEqual(["code", "expected_revision"]);
        if (state.restricted) { await reply({ code: "HANDOFF_COMPLIANCE_REQUIRED" }, 409); return; }
        if (body.code !== state.code || Date.parse(state.expires) <= Date.now()) { await reply({ code: "HANDOFF_UNAVAILABLE" }, 409); return; }
        state.phase = "DELIVERED"; base.commitment = null; base.availability.effective = "OFFLINE";
      } else {
        expect(body).toEqual({ expected_revision: state.revision });
        if (path.endsWith("/pickup")) state.phase = "IN_TRANSIT";
        if (path.endsWith("/arrive")) state.phase = "ARRIVED";
        if (path.endsWith("/regenerate")) { state.code = "271828"; state.regenerate = false; }
        if (path.endsWith("/tracking")) { state.revision++; await reply({ generation: "track_fixture", sequence: 0, revision: state.revision }); return; }
      }
      state.revision++;
      if (state.lose) { await route.abort("failed"); return; }
      await reply(handoff()); return;
    }
    await reply({}, 404);
  });
  return state;
}
const driver = "http://localhost:3002/";
const customer = "http://localhost:3000/orders/order_fixture";
const merchant = "http://localhost:3001/merchant/orders/order_fixture";

test("driver pickup, arrival and handoff converge after lost response without replay", async ({ page }) => {
  const state = await delivery(page);
  await page.goto(driver);
  await expect(page.getByText("Ready for pickup", { exact: true })).toBeVisible();
  let release = () => {};
  state.gate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole("button", { name: "Confirm pickup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm pickup", exact: true })).toBeDisabled();
  release(); state.gate = undefined;
  await expect(page.getByText("In transit", { exact: true })).toBeVisible();
  expect(state.writes.filter(p => p.endsWith("/pickup"))).toHaveLength(1);
  await page.getByRole("button", { name: "Mark arrived", exact: true }).click();
  await page.getByLabel("Customer handoff code", { exact: true }).fill(state.code);
  state.lose = true;
  await page.getByRole("button", { name: "Confirm handoff", exact: true }).click();
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assigned delivery", exact: true })).toHaveCount(0);
  await expect(page.getByText("Capacity reserved for your delivery", { exact: true })).toHaveCount(0);
  expect(state.writes.filter(p => p.endsWith("/verify"))).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible();
  expect(state.writes.filter(p => p.endsWith("/verify"))).toHaveLength(1);
});
test("assigned offline driver shares tracking without inferring arrival", async ({ page, context }) => {
  const state = await delivery(page); state.phase = "IN_TRANSIT";
  await context.grantPermissions(["geolocation"]); await context.setGeolocation({ latitude: -29.12345, longitude: 26.23456 });
  await page.goto(driver);
  await expect(page.getByText("Intent: Offline", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Share delivery location", exact: true }).click();
  await expect(page.getByText("Current delivery location shared.", { exact: true })).toBeVisible();
  expect(state.phase).toBe("IN_TRANSIT");
  expect(state.writes).toEqual(["/driver/deliveries/delivery_fixture/tracking", "/driver/location"]);
});
for (const phase of ["PREPARING", "ATTENTION_REQUIRED"] as const) test("driver " + phase + " keeps capacity without completion controls", async ({ page }) => {
  const state = await delivery(page); state.phase = phase;
  await page.goto(driver);
  await expect(page.getByText(phase === "PREPARING" ? "Pickup is not ready yet." : "Delivery needs attention. Your assignment remains recorded. Refresh for a confirmed outcome.", { exact: true })).toBeVisible();
  await expect(page.getByText("Capacity reserved for your delivery", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirm pickup|Confirm handoff|Mark arrived/ })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("restricted arrival never exposes final handoff controls", async ({ page }) => {
  const state = await delivery(page); state.phase = "ARRIVED"; state.restricted = true;
  await page.goto(driver);
  await expect(page.getByText("Additional restricted handoff verification is required. Delivery completion is unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Customer handoff code", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("wrong or expired driver code refetches without automatic submission or capacity release", async ({ page }) => {
  const state = await delivery(page); state.phase = "ARRIVED";
  await page.goto(driver);
  await page.getByLabel("Customer handoff code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Confirm handoff", exact: true }).click();
  await expect(page.getByLabel("Customer handoff code", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Customer handoff code", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm handoff", exact: true })).toBeDisabled();
  await expect(page.getByText("Capacity reserved for your delivery", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  state.expires = new Date(Date.now() - 1).toISOString();
  await page.getByLabel("Customer handoff code", { exact: true }).fill(state.code);
  await page.getByRole("button", { name: "Confirm handoff", exact: true }).click();
  await expect(page.getByLabel("Customer handoff code", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Customer handoff code", { exact: true })).toBeEnabled();
  await expect(page.getByText("Driver arrived", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2); expect(state.phase).toBe("ARRIVED");
});
test("wrong driver read removes operational controls", async ({ page }) => {
  const state = await delivery(page); state.denied = true;
  await page.goto(driver);
  await expect(page.getByText("Delivery information is unavailable. Refresh before another action.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirm pickup|Confirm handoff|Mark arrived/ })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("customer restores tracking, stable code, explicit regeneration and terminal privacy", async ({ page }) => {
  const state = await delivery(page); state.phase = "IN_TRANSIT";
  await page.goto(customer);
  await expect(page.getByLabel("Courier location", { exact: true })).toContainText("-29.12345");
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveCount(0);
  state.stale = true;
  await page.getByRole("button", { name: "Refresh tracking and code", exact: true }).click();
  await expect(page.getByText("Courier location is currently unavailable. This does not prevent handoff.", { exact: true })).toBeVisible();
  state.phase = "ARRIVED";
  await page.getByRole("button", { name: "Refresh tracking and code", exact: true }).click();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveText("314159");
  const expiry = state.expires;
  await page.reload();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveText("314159");
  expect(state.expires).toBe(expiry); expect(state.writes).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Request new handoff code", exact: true })).toBeDisabled();
  state.regenerate = true;
  await page.getByRole("button", { name: "Refresh tracking and code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Request new handoff code", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Request new handoff code", exact: true }).click();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveText("271828");
  expect(state.writes).toEqual(["/store/gospaza/orders/order_fixture/handoff-code/regenerate"]);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/314159|271828|-29\.12345/);
  state.phase = "DELIVERED";
  await page.getByRole("button", { name: "Refresh tracking and code", exact: true }).click();
  await expect(page.getByText("Delivery completed. Location and handoff code are no longer available.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Courier location", { exact: true })).toHaveCount(0);
});
test("foreign customer response removes code and coordinates", async ({ page }) => {
  const state = await delivery(page); state.phase = "ARRIVED";
  await page.goto(customer);
  await expect(page.getByLabel("Handoff code", { exact: true })).toBeVisible();
  state.denied = true;
  await page.getByRole("button", { name: "Refresh tracking and code", exact: true }).click();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Courier location", { exact: true })).toHaveCount(0);
});
test("expired customer code is hidden and never regenerated automatically", async ({ page }) => {
  const state = await delivery(page); state.phase = "ARRIVED"; state.expires = new Date(Date.now() - 1).toISOString();
  await page.goto(customer);
  await expect(page.getByText("The handoff code is unavailable, expired or exhausted. Refresh for the current state.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Handoff code", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
for (const [phase, label] of [["PICKUP_READY", "Ready for pickup"], ["IN_TRANSIT", "In transit"], ["ARRIVED", "Driver arrived"], ["DELIVERED", "Delivered"], ["ATTENTION_REQUIRED", "Delivery needs operational attention"]] as const)
  test("merchant sees read-only " + phase + " without handoff secrets or GPS", async ({ page }) => {
    const state = await delivery(page); state.phase = phase;
    await page.goto(merchant);
    const region = page.getByRole("region", { name: "Delivery status", exact: true });
    await expect(region.getByText(label, { exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: /pickup|handoff|arriv|deliver$/i })).toHaveCount(0);
    expect(await region.textContent()).not.toMatch(/314159|-29\.12345|26\.23456|nonce|fulfillment_id/);
    expect(state.reads.some(p => /handoff-code|tracking/.test(p))).toBe(false);
    expect(state.writes).toHaveLength(0);
  });
