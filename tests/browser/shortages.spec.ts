import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtureState, install, pending, resolved, openCustomer, openMerchant, customerBase, merchantBase, customerPath, merchantPath } from "./shortage-fixture";

const financialCopy = "This quantity will not be supplied. Any payment adjustment has not yet been processed.";
const panel = (page: Page) => page.getByRole("region", { name: "Unavailable items", exact: true });
const customerLine = (page: Page) => panel(page).getByRole("article", { name: "Fixture tomatoes", exact: true });
const merchantLine = (page: Page) => page.getByRole("article", { name: "Fixture tomatoes", exact: true });
async function count(page: Page, side: "customer" | "merchant", label: string, value: number) {
  const line = side === "customer" ? customerLine(page) : merchantLine(page);
  await expect(line.locator("dl > div").filter({ has: page.locator("dt").filter({ hasText: new RegExp("^" + label + "$", "u") }) }).locator("dd")).toHaveText(String(value));
}
async function focus(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }
async function confirm(page: Page) {
  await page.getByRole("button", { name: "Leave unavailable quantity out", exact: true }).click();
  await page.getByRole("button", { name: "Confirm leaving these items out", exact: true }).click();
}
// Compile each affected app's route in a separate bounded setup hook. These
// HTTP probes share no authentication, browser context or mutable test fixture.
for (const url of [customerBase + "/orders/order_fixture", merchantBase + merchantPath, merchantBase + "/application"]) {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    try { const response = await request.get(url); expect(response.status()).toBe(200); await response.body(); }
    finally { await request.dispose(); }
  });
}

for (const preference of ["CONTACT_ME", "NO_SUBSTITUTION"] as const) {
  test("default is not explicit consent; customer saves and replays " + preference + " before freeze", async ({ page, context }) => {
    const state = fixtureState(); await install(context, state); await openCustomer(page);
    await expect(panel(page).getByText("This is the default; you have not explicitly selected a preference.", { exact: true })).toBeVisible();
    await page.getByLabel("Unavailable item preference", { exact: true }).selectOption(preference);
    await page.getByRole("button", { name: "Save preference", exact: true }).click();
    await expect(page.getByText("Saved. Showing the latest order information.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save preference", exact: true })).toBeEnabled();
    expect(state.writes[0]?.body).toEqual({ preference, expected_revision: 0 });
    await expect(panel(page).getByText("This is the default; you have not explicitly selected a preference.", { exact: true })).toHaveCount(0);
    const replayResponse = page.waitForResponse((response) => new URL(response.url()).pathname === customerPath + "/substitution-preference" && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save preference", exact: true }).click();
    expect((await replayResponse).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Save preference", exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(2);
    expect(state.shortages.preference.revision).toBe(1);
    pending(state);
    if (preference === "NO_SUBSTITUTION") resolved(state);
    await focus(page);
    await expect(page.getByLabel("Unavailable item preference", { exact: true })).toHaveCount(0);
    await expect(page.getByText("The preference is fixed for this order because a shortage has been recorded.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Unavailable item preference", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Your order preference", exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(2);
  });
}

test("preference freezes during an open edit: conflict refetches without replay", async ({ page, context }) => {
  const state = fixtureState(); await install(context, state); await openCustomer(page);
  await page.getByLabel("Unavailable item preference", { exact: true }).selectOption("NO_SUBSTITUTION");
  state.conflict = () => pending(state);
  await page.getByRole("button", { name: "Save preference", exact: true }).click();
  await expect(page.getByText("The order changed. Review the updated quantities and preference before deciding again.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Unavailable item preference", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave unavailable quantity out", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  expect(state.shortages.preference.preference).toBe("CONTACT_ME");
});

test("CONTACT_ME requires explicit current-quantity confirmation; duplicate clicks cannot replay", async ({ page, context }) => {
  const state = fixtureState(); pending(state); await install(context, state);
  await page.setViewportSize({ width: 390, height: 844 }); await openCustomer(page);
  await count(page, "customer", "Ordered", 5); await count(page, "customer", "Physically picked", 2);
  await count(page, "customer", "Unavailable and unresolved", 3);
  await expect(panel(page).getByRole("spinbutton")).toHaveCount(0);
  await page.getByRole("button", { name: "Leave unavailable quantity out", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  state.beforeWrite = async () => { started?.(); await gate; };
  try {
    await page.getByRole("button", { name: "Confirm leaving these items out", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await requested;
    await expect(page.getByText("Saving your decision…", { exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(1);
  } finally { release?.(); }
  await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
  expect(state.writes[0]?.body).toEqual({ expected_revision: 1, confirmed: true });
  await count(page, "customer", "Physically picked", 2); await count(page, "customer", "Omitted", 3);
  await expect(page.getByRole("button", { name: "Leave unavailable quantity out", exact: true })).toHaveCount(0);
  await expect(panel(page).getByText(/refunded|credited|payment reversed|R\s*\d/i)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("case_1");
});

test("NO_SUBSTITUTION displays server omission with no additional decision", async ({ page, context }) => {
  const state = fixtureState(); state.shortages.preference = { preference: "NO_SUBSTITUTION", revision: 1, chosen_at: "2026-10-17T09:00:00Z", frozen_at: null };
  pending(state, 3); resolved(state); await install(context, state); await openCustomer(page);
  await expect(page.getByText("Your earlier order preference was used to leave this quantity out.", { exact: true })).toBeVisible();
  await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
  await count(page, "customer", "Physically picked", 3); await count(page, "customer", "Omitted", 2);
  await expect(panel(page).getByRole("button")).toHaveCount(1); // Refresh only.
  expect(state.writes).toHaveLength(0);
});

test("stale omission refetches changed quantity and requires new consent", async ({ page, context }) => {
  const state = fixtureState(); pending(state); await install(context, state); await openCustomer(page);
  state.conflict = () => pending(state, 3, "case_2");
  await confirm(page);
  await expect(page.getByText("The order changed. Review the updated quantities and preference before deciding again.", { exact: true })).toBeVisible();
  await count(page, "customer", "Unavailable and unresolved", 2);
  await expect(page.getByRole("button", { name: "Confirm leaving these items out", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]?.path).toBe(customerPath + "/shortages/case_1/omit");
  state.conflict = undefined;
  await confirm(page);
  await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]?.path).toBe(customerPath + "/shortages/case_2/omit");
});

test("original found before omission removes open consent on focus; errors hide choices and retry", async ({ page, context }) => {
  const state = fixtureState(); pending(state); await install(context, state); await openCustomer(page);
  await page.getByRole("button", { name: "Leave unavailable quantity out", exact: true }).click();
  state.shortages.shortages = [];
  await focus(page);
  await expect(page.getByText("No unavailable items are awaiting a decision.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm leaving these items out", exact: true })).toHaveCount(0);
  state.outage = true; await page.getByRole("button", { name: "Refresh shortages", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toHaveText("Shortage information is unavailable. Refresh before making a decision.");
  await expect(page.getByRole("heading", { name: "Your order preference", exact: true })).toHaveCount(0);
  state.outage = false; pending(state, 3, "case_new");
  await page.getByRole("button", { name: "Refresh shortages", exact: true }).click();
  await count(page, "customer", "Unavailable and unresolved", 2);
  expect(state.writes).toHaveLength(0);
});

test("foreign customer Order never exposes preference or shortage choices", async ({ page, context }) => {
  const state = fixtureState(); pending(state); await install(context, state);
  await page.goto(customerBase + "/orders/order_foreign?customer_id=cus_fixture");
  await expect(page.locator(".order-page [role=alert]")).toHaveText("Order unavailable.");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

for (const role of ["OWNER", "MANAGER", "PICKER"] as const) {
  test(role + " sees separate physical and omitted evidence, then immutable completion", async ({ page, context }) => {
    const state = fixtureState(role); pending(state, 3); await install(context, state); await openMerchant(page);
    await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toBeEnabled();
    const customer = await context.newPage(); await openCustomer(customer); await confirm(customer);
    await expect(customer.getByText(financialCopy, { exact: true })).toBeVisible();
    await page.bringToFront(); await focus(page);
    await count(page, "merchant", "Picked", 3); await count(page, "merchant", "Omitted", 2);
    await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    if (role === "PICKER") await expect(page.getByRole("link", { name: "Orders", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Complete picking", exact: true }).click();
    await page.getByRole("button", { name: "Confirm completion", exact: true }).click();
    await expect(page.getByText("Picking is complete. No further picking changes are available.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Picking is complete. No further picking changes are available.", { exact: true })).toBeVisible();
    await count(page, "merchant", "Picked", 3); await count(page, "merchant", "Omitted", 2);
    await expect(page.getByRole("button", { name: "Complete picking", exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]?.path).toBe(merchantPath + "/complete");
  });
}

test("reassignment retains shortage evidence without supervisor bypass; membership loss clears it", async ({ page, context }) => {
  const state = fixtureState("OWNER"); pending(state, 3); await install(context, state); await openMerchant(page);
  state.picking.assigned_member_id = "member_other";
  await focus(page);
  await expect(page.getByText("This pick is read-only for you. Only the assigned employee may record goods.", { exact: true })).toBeVisible();
  await count(page, "merchant", "Unresolved", 2);
  await expect(page.getByLabel("Picked quantity for Fixture tomatoes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reassign picking", exact: true })).toBeEnabled();
  state.active = false; await focus(page);
  await expect(page.getByText("Fixture tomatoes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reassign picking", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(merchantBase + "/application");
  expect(state.writes).toHaveLength(0);
});


test("older shortage response cannot restore consent after a newer terminal refresh", async ({ page, context }) => {
  const state = fixtureState(); pending(state); await install(context, state); await openCustomer(page);
  const old = structuredClone(state.shortages);
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  let intercepted = false;
  await context.route("http://localhost:9000" + customerPath + "/shortages", async (route) => {
    if (route.request().method() !== "GET" || intercepted) { await route.fallback(); return; }
    intercepted = true; started?.(); await gate;
    await route.fulfill({ status: 200, contentType: "application/json", headers: {
      "access-control-allow-origin": customerBase, "access-control-allow-credentials": "true", "cache-control": "no-store",
    }, body: JSON.stringify(old) });
  });
  try {
    await page.getByRole("button", { name: "Refresh shortages", exact: true }).click(); await requested;
    resolved(state);
    await page.getByRole("button", { name: "Refresh shortages", exact: true }).click();
    await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === customerPath + "/shortages" && response.request().method() === "GET");
    release?.(); await (await oldResponse).json();
    await expect(page.getByText(financialCopy, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Leave unavailable quantity out", exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
  } finally { release?.(); }
});
