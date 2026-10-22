import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DriverAccountDTO, DriverAffiliationDTO, MerchantContext } from "@gospaza/contracts";

const driverBase = "http://localhost:3002";
const merchantBase = "http://localhost:3001";
const adminBase = "http://localhost:3003";
const affiliationId = "daff_fixture";
const profileId = "drv_fixture";
const date = "2026-10-18T08:00:00.000Z";
function initial(): DriverAccountDTO {
  return { profile: { id: profileId, display_name: "Fixture Driver", contact_phone: "0821234567", status: "INCOMPLETE", revision: 1, submitted_at: null, reviewed_at: null },
    affiliation: null, eligibility: { eligible: false, reason: "PROFILE_INACTIVE" } };
}
function affiliation(kind: "PLATFORM" | "MERCHANT", status: DriverAffiliationDTO["status"]): DriverAffiliationDTO {
  return { id: affiliationId, kind, status, revision: 1, merchant_store_id: kind === "MERCHANT" ? "store_fixture" : null, created_at: date };
}
async function fixture(page: Page, role: "OWNER" | "MANAGER" | "PICKER" = "OWNER") {
  const state = {
    account: initial(), hasProfile: true, session: true, wrongActor: false, membership: true, outage: false, existingEmail: false,
    history: [] as DriverAffiliationDTO[], reads: [] as string[], writes: [] as { path: string; body: Record<string, unknown> }[],
    conflict: null as null | (() => void), gate: null as null | Promise<void>,
  };
  const projection = () => {
    state.account.eligibility = state.account.profile.status !== "ACTIVE" ? { eligible: false, reason: "PROFILE_INACTIVE" }
      : state.account.affiliation?.status !== "ACTIVE" ? { eligible: false, reason: "AFFILIATION_INACTIVE" }
      : { eligible: true, reason: "ELIGIBLE" };
    return state.account;
  };
  await page.route("http://localhost:9000/**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    const headers = { "access-control-allow-origin": request.headers().origin ?? driverBase, "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "cache-control": "no-store" };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method === "GET") state.reads.push(path + url.search);
    if (path.includes("/emailpass")) { await reply(path.endsWith("/register") && state.existingEmail ? {} : { token: "transient-fixture" }, path.endsWith("/register") && state.existingEmail ? 401 : 200); return; }
    if (path === "/auth/session") { state.session = method === "POST"; await reply({}); return; }
    if (!state.session || state.wrongActor) { await reply({}, 401); return; }
    if (path === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (path === "/merchant/applications/me") { await reply({ application: null, documents: [] }); return; }
    if (path.startsWith("/merchant/") && !state.membership) { await reply({}, 401); return; }
    if (path === "/merchant/me") {
      const context: MerchantContext = { merchant: { id: "mer_fixture", legal_name: "Fixture Shop", trading_name: "Fixture Shop" }, store: { id: "store_fixture", name: "Fixture Shop" },
        membership: { id: "member_fixture", member_type: role, capabilities: role === "PICKER" ? [] : ["MERCHANT_DRIVER_VIEW", "MERCHANT_DRIVER_AFFILIATION_MANAGE"] } };
      await reply(context); return;
    }
    if (path === "/admin/gospaza/me") { await reply({ actor: { type: "user", id: "user_fixture" } }); return; }
    if (state.outage) { await reply({ message: "private diagnostic" }, 503); return; }
    if (path === "/driver/onboarding/me") { await reply({ onboarding: true }); return; }
    if (path === "/driver/availability") {
      await reply({ intent: "OFFLINE", revision: 0, generation: null, effective: "OFFLINE", location_fresh: false, available_since: null }); return;
    }
    if (path === "/driver/dispatch/current") { await reply({ commitment: null }); return; }
    if (path === "/driver/profile/bootstrap") { state.hasProfile = true; state.writes.push({ path, body: request.postDataJSON() }); await reply(projection()); return; }
    if (path === "/driver/profile" && method === "GET") { await reply(state.hasProfile ? projection() : {}, state.hasProfile ? 200 : 401); return; }
    if (path === "/driver/affiliation-targets") { await reply({ items: [{ id: "store_fixture", name: "Fixture Shop" }], limit: 20, offset: 0 }); return; }
    if (path === "/driver/affiliations" && method === "GET") {
      const items = [...(state.account.affiliation ? [state.account.affiliation] : []), ...state.history];
      await reply({ items, count: items.length, limit: 20, offset: 0 }); return;
    }
    if (path === "/admin/gospaza/drivers" && method === "GET") {
      const items = !url.searchParams.get("status") || url.searchParams.get("status") === state.account.profile.status ? [state.account.profile] : [];
      await reply({ items, count: items.length, limit: 20, offset: Number(url.searchParams.get("offset")) }); return;
    }
    if (path === "/admin/gospaza/drivers/" + profileId && method === "GET") { await reply(projection()); return; }
    if (path.startsWith("/merchant/drivers") && method === "GET") {
      if (role === "PICKER") { await reply({}, 403); return; }
      const a = state.account.affiliation;
      const item = a?.kind === "MERCHANT" ? { affiliation: a, profile_revision: state.account.profile.revision, display_name: state.account.profile.display_name,
        contact_phone: a.status === "ACTIVE" ? state.account.profile.contact_phone : null, persistently_eligible: projection().eligibility.eligible,
        available_actions: state.account.profile.status === "DEACTIVATED" ? [] : a.status === "REQUESTED"
          ? state.account.profile.status === "SUSPENDED" ? ["decline"] : ["endorse", "decline"] : ["revoke"] } : null;
      if (path === "/merchant/drivers") { await reply({ items: item ? [item] : [], count: item ? 1 : 0, limit: 20, offset: 0 }); return; }
      await reply(path === "/merchant/drivers/" + affiliationId && item ? { item } : {}, path === "/merchant/drivers/" + affiliationId && item ? 200 : 404); return;
    }
    if (["POST", "PATCH"].includes(method)) {
      const body: Record<string, unknown> = request.postDataJSON(); state.writes.push({ path, body });
      await state.gate;
      if (state.conflict) { state.conflict(); await reply({ code: "DRIVER_CONFLICT" }, 409); return; }
      expect(body.expected_revision).toBe(state.account.profile.revision);
      if (path === "/driver/profile") {
        expect(Object.keys(body).sort()).toEqual(["contact_phone", "display_name", "expected_revision"]);
        state.account.profile.display_name = String(body.display_name); state.account.profile.contact_phone = String(body.contact_phone);
      } else if (path === "/driver/affiliations") {
        expect(Object.keys(body).sort()).toEqual(body.kind === "PLATFORM" ? ["expected_revision", "kind"] : ["expected_revision", "kind", "merchant_store_id"]);
        expect(state.account.affiliation).toBeNull();
        state.account.affiliation = affiliation(body.kind === "MERCHANT" ? "MERCHANT" : "PLATFORM", "REQUESTED");
      } else if (path.endsWith("/submit")) { state.account.profile.status = "PENDING_REVIEW"; }
      else if (path.endsWith("/withdraw")) {
        if (state.account.affiliation) state.history.push({ ...state.account.affiliation, status: "REVOKED" });
        state.account.affiliation = null;
      } else {
        expect(Object.keys(body).sort()).toEqual(["confirmed", "expected_revision", "reason"]); expect(body.confirmed).toBe(true);
        if (path.endsWith("/endorse") && state.account.affiliation) state.account.affiliation.status = "ENDORSED";
        else if (path.endsWith("/approve")) { state.account.profile.status = "ACTIVE"; if (state.account.affiliation) state.account.affiliation.status = "ACTIVE"; }
        else if (path.endsWith("/require-changes")) state.account.profile.status = "CHANGES_REQUIRED";
        else if (path.endsWith("/suspend")) state.account.profile.status = "SUSPENDED";
        else if (path.endsWith("/reactivate")) state.account.profile.status = "ACTIVE";
        else if (path.endsWith("/deactivate")) state.account.profile.status = "DEACTIVATED";
        else if (path.endsWith("/activate") && state.account.affiliation) state.account.affiliation.status = "ACTIVE";
        else if (path.endsWith("/revoke") || path.endsWith("/decline")) {
          if (state.account.affiliation) state.history.push({ ...state.account.affiliation, status: path.endsWith("/decline") ? "REJECTED" : "REVOKED" });
          state.account.affiliation = null;
        } else throw new Error("Unexpected fixture mutation: " + path);
      }
      state.account.profile.revision++;
      await reply(path.startsWith("/merchant/") ? { receipt: { action: "fixture", revision: state.account.profile.revision, occurred_at: date } }
        : { ...projection(), receipt: { action: "fixture", revision: state.account.profile.revision, occurred_at: date } }); return;
    }
    await reply({}, 404);
  });
  return state;
}
async function focus(page: Page, path: string) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
}
async function decide(page: Page, action: string, region?: string) {
  const container = region ? page.getByRole("region", { name: region, exact: true }) : page.locator("main");
  await container.getByLabel("Action", { exact: true }).selectOption(action);
  await container.getByLabel("Reason", { exact: true }).fill("Reviewed this request");
  await container.getByLabel("I confirm this decision", { exact: true }).check();
  await container.getByRole("button", { name: "Confirm decision", exact: true }).click();
}

test("driver bootstrap, profile edit, platform request and submission restore after reload", async ({ page }) => {
  const state = await fixture(page); state.hasProfile = false;
  await page.goto(driverBase);
  await page.getByRole("button", { name: "Create driver profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("New Driver");
  await page.getByLabel("Contact phone", { exact: true }).fill("0825551234");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New Driver", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Request affiliation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Platform / Requested");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Not eligible for delivery work");
  await expect(page.getByRole("button", { name: "Request affiliation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Pending review");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Pending review");
  expect(state.writes.map(w => w.path)).toEqual(["/driver/profile/bootstrap", "/driver/profile", "/driver/affiliations", "/driver/profile/submit"]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});
test("driver merchant choice uses server targets and shows endorsement then platform approval", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(driverBase);
  await page.getByLabel("Affiliation type", { exact: true }).selectOption("MERCHANT");
  await page.getByLabel("Merchant store", { exact: true }).selectOption("store_fixture");
  await page.getByRole("button", { name: "Request affiliation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Awaiting merchant endorsement");
  state.account.affiliation = affiliation("MERCHANT", "ENDORSED"); state.account.profile.revision++;
  await focus(page, "/driver/profile");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Merchant endorsed. Awaiting platform approval.");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]?.body).toEqual({ kind: "MERCHANT", expected_revision: 1, merchant_store_id: "store_fixture" });
});
test("driver changes required allows correction and deliberate resubmission", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "CHANGES_REQUIRED"; state.account.affiliation = affiliation("PLATFORM", "REQUESTED");
  await page.goto(driverBase);
  await page.getByLabel("Display name", { exact: true }).fill("Corrected Driver");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Corrected Driver", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resubmit for review", exact: true }).click();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Pending review");
  expect(state.writes).toHaveLength(2);
});
for (const status of ["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const) {
  test("driver " + status + " restores a read-only profile and server eligibility", async ({ page }) => {
    const state = await fixture(page); state.account.profile.status = status; state.account.affiliation = affiliation("MERCHANT", "ACTIVE");
    await page.goto(driverBase);
    const summary = page.getByRole("region", { name: "Driver status" });
    await expect(summary).toContainText(status === "ACTIVE" ? "Eligible for delivery work" : "Not eligible for delivery work");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Submit for review|Resubmit for review|Online|Available|Accept delivery/ })).toHaveCount(0);
    if (status === "DEACTIVATED") await expect(page.getByRole("button", { name: "Withdraw affiliation", exact: true })).toHaveCount(0);
    await page.reload(); await expect(summary).toBeVisible(); expect(state.writes).toHaveLength(0);
  });
}
test("driver revoked affiliation stays visible in history without automatic platform conversion", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "ACTIVE"; state.account.affiliation = affiliation("MERCHANT", "ACTIVE");
  await page.goto(driverBase); await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Eligible for delivery work");
  state.history.push({ ...state.account.affiliation, status: "REVOKED" }); state.account.affiliation = null; state.account.profile.revision++;
  await focus(page, "/driver/profile");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Not eligible for delivery work");
  await expect(page.getByRole("region", { name: "Affiliation history" })).toContainText("Merchant · Revoked");
  expect(state.writes).toHaveLength(0);
});
test("driver CUSTOMER session cannot enter onboarding and existing email is directed to sign in", async ({ page }) => {
  const state = await fixture(page); state.wrongActor = true;
  await page.goto(driverBase); await expect(page).toHaveURL(driverBase + "/login");
  await expect(page.getByRole("button", { name: "Create driver profile", exact: true })).toHaveCount(0);
  state.wrongActor = false; state.session = false; state.existingEmail = true;
  await page.goto(driverBase + "/register");
  await page.getByLabel("Email address").fill("same@example.test"); await page.getByLabel("Password", { exact: true }).fill("long-existing-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("existing GoSpaza credentials");
  expect(state.session).toBe(false); expect(state.writes).toHaveLength(0);
});
for (const role of ["OWNER", "MANAGER"] as const) {
  test("merchant " + role + " roster and endorsement remain ineligible until platform approval", async ({ page }) => {
    const state = await fixture(page, role); state.account.affiliation = affiliation("MERCHANT", "REQUESTED");
    await page.goto(merchantBase + "/merchant/drivers");
    // Next App Router commits the URL after its destination RSC request.
    // Observe that transition before clicking; do not use the generic assertion budget.
    await Promise.all([
      page.waitForURL(merchantBase + "/merchant/drivers/" + affiliationId),
      page.getByRole("link", { name: "Fixture Driver", exact: true }).click(),
    ]);
    await expect(page).toHaveURL(merchantBase + "/merchant/drivers/" + affiliationId);
    await expect(page.getByRole("heading", { name: "Driver affiliation", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toBeVisible();
    await decide(page, "endorse");
    await expect(page.getByText("Affiliation: Endorsed", { exact: true })).toBeVisible();
    await expect(page.getByText("Not eligible for delivery work", { exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(1);
  });
}
test("PICKER sees no driver management and makes no roster request", async ({ page }) => {
  const state = await fixture(page, "PICKER");
  await page.goto(merchantBase + "/merchant/drivers");
  await expect(page.getByRole("heading", { name: "Driver access unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Drivers", exact: true })).toHaveCount(0);
  expect(state.reads.some(p => p.startsWith("/merchant/drivers"))).toBe(false);
});
test("merchant foreign affiliation ID is unavailable without private data", async ({ page }) => {
  await fixture(page);
  await page.goto(merchantBase + "/merchant/drivers/foreign");
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("unavailable");
  await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm decision", exact: true })).toHaveCount(0);
});
test("merchant revocation clears roster eligibility and never creates another affiliation", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "ACTIVE"; state.account.affiliation = affiliation("MERCHANT", "ACTIVE");
  await page.goto(merchantBase + "/merchant/drivers/" + affiliationId);
  await expect(page.getByText("Eligible for delivery work", { exact: true })).toBeVisible();
  await decide(page, "revoke");
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("unavailable");
  await expect(page.getByText("Eligible for delivery work", { exact: true })).toHaveCount(0);
  expect(state.account.affiliation).toBeNull(); expect(state.writes).toHaveLength(1);
});
test("merchant membership loss removes driver data and controls on focus", async ({ page }) => {
  const state = await fixture(page); state.account.affiliation = affiliation("MERCHANT", "REQUESTED");
  await page.goto(merchantBase + "/merchant/drivers/" + affiliationId);
  await expect(page.getByLabel("Action", { exact: true })).toBeEnabled();
  state.membership = false;
  await focus(page, "/merchant/me");
  await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm decision", exact: true })).toHaveCount(0);
  await page.waitForURL(merchantBase + "/application");
  expect(state.writes).toHaveLength(0);
});
test("admin queue, approval, suspension, reactivation and terminal deactivation", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "PENDING_REVIEW"; state.account.affiliation = affiliation("PLATFORM", "REQUESTED");
  await page.goto(adminBase + "/admin/drivers");
  await Promise.all([
    page.waitForURL(adminBase + "/admin/drivers/" + profileId),
    page.getByRole("link", { name: "Fixture Driver", exact: true }).click(),
  ]);
  await expect(page).toHaveURL(adminBase + "/admin/drivers/" + profileId);
  await expect(page.getByRole("heading", { name: "Review driver", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toBeVisible();
  await decide(page, "approve", "Profile decisions");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Eligible for delivery work");
  await decide(page, "suspend", "Profile decisions");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Suspended");
  await decide(page, "reactivate", "Profile decisions");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Eligible for delivery work");
  await decide(page, "deactivate", "Profile decisions");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Deactivated");
  await expect(page.getByRole("button", { name: "Confirm decision", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(4);
});
test("admin requires changes and stale review refetches without mutation replay", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "PENDING_REVIEW"; state.account.affiliation = affiliation("MERCHANT", "ENDORSED");
  await page.goto(adminBase + "/admin/drivers/" + profileId);
  await decide(page, "require-changes", "Profile decisions");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Changes required");
  state.account.profile.status = "PENDING_REVIEW"; state.account.profile.revision++;
  await focus(page, "/admin/gospaza/drivers/" + profileId);
  state.conflict = () => { state.account.profile.status = "ACTIVE"; state.account.profile.revision++; state.account.affiliation = null; };
  const prior = state.reads.length;
  await decide(page, "approve", "Profile decisions");
  await expect(page.getByText("Details changed. The latest state has been loaded. Review it before a new action.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("No open affiliation");
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Not eligible for delivery work");
  expect(state.reads.slice(prior)).toContain("/admin/gospaza/drivers/" + profileId);
  expect(state.writes).toHaveLength(2);
});
test("admin duplicate clicks send one decision and affiliation changes require explicit confirmation", async ({ page }) => {
  const state = await fixture(page); state.account.profile.status = "ACTIVE"; state.account.affiliation = affiliation("MERCHANT", "ENDORSED");
  await page.goto(adminBase + "/admin/drivers/" + profileId);
  const region = page.getByRole("region", { name: "Affiliation decisions", exact: true });
  await region.getByLabel("Action", { exact: true }).selectOption("activate");
  await region.getByLabel("Reason", { exact: true }).fill("Reviewed");
  await expect(region.getByRole("button", { name: "Confirm decision", exact: true })).toBeDisabled();
  await region.getByLabel("I confirm this decision", { exact: true }).check();
  let release = () => {};
  state.gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const observed = page.waitForRequest(r => new URL(r.url()).pathname.endsWith("/activate") && r.method() === "POST");
    await region.getByRole("button", { name: "Confirm decision", exact: true }).evaluate(button => { if (button instanceof HTMLButtonElement) { button.click(); button.click(); } });
    await observed;
    await expect.poll(() => state.writes.length).toBe(1);
  } finally { release(); }
  await expect(page.getByRole("region", { name: "Driver status" })).toContainText("Eligible for delivery work");
  expect(state.writes).toHaveLength(1);
});
test("driver outage clears stale profile and refresh restores without a write", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(driverBase); await expect(page.getByLabel("Display name", { exact: true })).toBeVisible();
  state.outage = true; await focus(page, "/driver/onboarding/me");
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("temporarily unavailable");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  state.outage = false; await page.getByRole("button", { name: "Refresh profile", exact: true }).click();
  await expect(page.getByLabel("Display name", { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0);
});

test("merchant stale endorsement refetches the winning affiliation without another write", async ({ page }) => {
  const state = await fixture(page); state.account.affiliation = affiliation("MERCHANT", "REQUESTED");
  await page.goto(merchantBase + "/merchant/drivers/" + affiliationId);
  await expect(page.getByLabel("Action", { exact: true })).toBeEnabled();
  state.conflict = () => { state.account.affiliation = affiliation("MERCHANT", "ENDORSED"); state.account.profile.revision++; };
  const before = state.reads.length;
  await decide(page, "endorse");
  await expect(page.getByText("Details changed. The latest state has been loaded. Review it before a new action.", { exact: true })).toBeVisible();
  await expect(page.getByText("Affiliation: Endorsed", { exact: true })).toBeVisible();
  expect(state.reads.slice(before)).toContain("/merchant/drivers/" + affiliationId);
  expect(state.writes).toHaveLength(1);
  await expect(page.getByLabel("I confirm this decision", { exact: true })).not.toBeChecked();
});
test("driver explicit withdrawal records the closed affiliation and leaves no automatic request", async ({ page }) => {
  const state = await fixture(page); state.account.affiliation = affiliation("PLATFORM", "REQUESTED");
  await page.goto(driverBase);
  await expect(page.getByRole("button", { name: "Withdraw affiliation", exact: true })).toBeDisabled();
  await page.getByLabel("Confirm withdrawal of current affiliation", { exact: true }).check();
  await page.getByRole("button", { name: "Withdraw affiliation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Affiliation history" })).toContainText("Platform · Revoked");
  await expect(page.getByRole("button", { name: "Request affiliation", exact: true })).toBeVisible();
  expect(state.account.affiliation).toBeNull(); expect(state.writes).toHaveLength(1);
});
test("driver new registration and later login restore the same backend profile", async ({ page }) => {
  const state = await fixture(page); state.session = false;
  await page.goto(driverBase + "/register");
  await page.getByLabel("Email address").fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill("long-existing-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(driverBase + "/login");
  await page.getByLabel("Email address").fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill("long-existing-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Driver", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("merchant empty roster is explicit and suspended requests cannot be endorsed", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(merchantBase + "/merchant/drivers");
  await expect(page.getByText("No open driver affiliations for this store.", { exact: true })).toBeVisible();
  state.account.profile.status = "SUSPENDED"; state.account.affiliation = affiliation("MERCHANT", "REQUESTED");
  await page.goto(merchantBase + "/merchant/drivers/" + affiliationId);
  await expect(page.getByLabel("Action", { exact: true })).toBeEnabled();
  await expect(page.getByRole("option", { name: "Endorse request", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Decline request", exact: true })).toHaveCount(1);
  expect(state.writes).toHaveLength(0);
});
