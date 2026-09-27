import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { MerchantCapability, MerchantContext, MerchantInvitation, MerchantMember, MerchantMemberRole } from "../../packages/contracts/src";

const base = "http://localhost:3001";
const secret = "A".repeat(43); // Synthetic only; production tokens never enter traces.
const invitedEmail = "teammate@example.test";
const permissions: Record<MerchantMemberRole, MerchantCapability[]> = {
  OWNER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW", "MERCHANT_TEAM_MANAGE"],
  MANAGER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_TEAM_VIEW"],
  PICKER: ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW"],
};
interface Fixture {
  role: MerchantMemberRole;
  authenticated: boolean;
  active: boolean;
  actor: "merchant" | "user";
  acceptStatus: number;
  unavailable: boolean;
  accepted: boolean;
  registered: boolean;
  mutations: string[];
  invitations: MerchantInvitation[];
}
async function mock(page: Page, options: Partial<Fixture> = {}) {
  const state: Fixture = {
    role: "OWNER", authenticated: true, active: true, actor: "merchant", acceptStatus: 200,
    unavailable: false, accepted: false, registered: false, mutations: [], invitations: [], ...options,
  };
  const members: MerchantMember[] = [
    { id: "mmem_owner", role: "OWNER", status: "ACTIVE", created_at: "2026-09-26T10:00:00Z" },
    { id: "mmem_teammate", role: "MANAGER", status: "ACTIVE", created_at: "2026-09-26T10:00:00Z" },
  ];
  const context = (): MerchantContext => ({
    merchant: { id: "mer_fixture", legal_name: "Fixture Business", trading_name: "Fixture Shop" },
    store: { id: "mstore_fixture", name: "Fixture Shop" },
    membership: { id: state.role === "OWNER" ? "mmem_owner" : "mmem_teammate", member_type: state.role, capabilities: permissions[state.role] },
  });
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? base,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "cache-control": "no-store",
    };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method !== "GET") state.mutations.push(method + " " + path);
    if (path === "/auth/merchant/emailpass" || path === "/auth/merchant/emailpass/register") {
      state.registered = path.endsWith("/register");
      state.actor = "merchant";
      await reply({ token: "fixture-session-token" }); return;
    }
    if (path === "/auth/session") { state.authenticated = method === "POST"; await reply({ success: true }); return; }
    if (path === "/merchant/applicant/me") {
      await reply({ applicant: true }, state.authenticated && state.actor === "merchant" ? 200 : 401); return;
    }
    if (path === "/merchant/applications/me") { await reply({ application: null, documents: [], review_history: [], tenant: null }); return; }
    if (path === "/merchant/team/invitations/accept" && method === "POST") {
      if (!state.authenticated || state.actor !== "merchant") { await reply({}, 401); return; }
      const input = request.postDataJSON() as { token: string };
      if (state.acceptStatus !== 200 || input.token !== secret) { await reply({}, state.acceptStatus === 200 ? 409 : state.acceptStatus); return; }
      state.active = true;
      state.accepted = true;
      state.role = "MANAGER";
      await reply({ member_id: "mmem_teammate" }); return;
    }
    if (path === "/merchant/me" && state.unavailable) { await reply({}, 503); return; }
    if (!state.authenticated || !state.active || state.actor !== "merchant") { await reply({}, 401); return; }
    if (path === "/merchant/me") { await reply(context()); return; }
    if (path.startsWith("/merchant/team")) {
      if (!permissions[state.role].includes("MERCHANT_TEAM_VIEW")) { await reply({}, 403); return; }
      if (method !== "GET" && !permissions[state.role].includes("MERCHANT_TEAM_MANAGE")) { await reply({}, 403); return; }
    }
    if (path === "/merchant/team" && method === "GET") { await reply({ members }); return; }
    if (path === "/merchant/team/invitations" && method === "GET") { await reply({ invitations: state.invitations }); return; }
    if (path === "/merchant/team/invitations" && method === "POST") {
      const input = request.postDataJSON() as { email: string; role: "MANAGER" | "PICKER" };
      const invitation: MerchantInvitation = { id: "minv_fixture", email: input.email, role: input.role, state: "PENDING", expires_at: "2099-01-01T10:00:00Z", created_at: "2026-09-26T10:00:00Z" };
      state.invitations.push(invitation);
      await reply({ invitation, token: secret }, 201); return;
    }
    if (path === "/merchant/team/invitations/minv_fixture/revoke" && method === "POST") {
      const invitation = state.invitations.find((row) => row.id === "minv_fixture");
      if (!invitation) { await reply({}, 404); return; }
      invitation.state = "REVOKED";
      await reply({ invitation }); return;
    }
    if (path.startsWith("/merchant/team/members/") && method === "PATCH") {
      const member = members.find((row) => row.id === path.split("/").at(-1));
      if (!member) { await reply({}, 404); return; }
      if (member.role === "OWNER") { await reply({}, 403); return; }
      const input = request.postDataJSON() as { role?: "MANAGER" | "PICKER"; status?: "ACTIVE" | "INACTIVE" };
      if (input.role) member.role = input.role;
      if (input.status) member.status = input.status;
      await reply({ member }); return;
    }
    await reply({}, 404); // Unexpected requests must not silently succeed.
  });
  return state;
}

test.beforeAll(async ({ request }) => {
  for (const path of ["/merchant", "/merchant/team", "/invite"]) {
    const response = await request.get(base + path);
    expect(response.ok(), "M4 route must be ready: " + path).toBe(true);
    await response.dispose();
  }
});

test("owner receives a copyable one-time link, manages team, and cannot edit OWNER", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const state = await mock(page);
  await page.goto(base + "/merchant/team");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  const owner = page.getByRole("row").filter({ hasText: "mmem_owner" });
  await expect(owner.getByText("Owner protected")).toBeVisible();
  await expect(owner.getByRole("button")).toHaveCount(0);
  await expect(page.getByLabel("Invitation role").getByRole("option", { name: "OWNER", exact: true })).toHaveCount(0);
  await page.getByLabel("Invitation email").fill(invitedEmail);
  await page.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect(page.getByLabel("One-time invitation link")).toHaveValue(base + "/invite#" + secret);
  await page.getByRole("button", { name: "Copy invitation link" }).click();
  await expect(page.getByRole("status")).toHaveText("Invitation link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base + "/invite#" + secret);
  await page.reload();
  await expect(page.getByRole("cell", { name: invitedEmail, exact: true })).toBeVisible();
  await expect(page.getByLabel("One-time invitation link")).toHaveCount(0);
  page.on("dialog", (dialog) => dialog.accept());
  const teammate = page.getByRole("row").filter({ hasText: "mmem_teammate" });
  await teammate.getByRole("button", { name: "Make PICKER", exact: true }).click();
  await expect(teammate.getByRole("cell", { name: "PICKER", exact: true })).toBeVisible();
  await teammate.getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(teammate.getByRole("cell", { name: "INACTIVE", exact: true })).toBeVisible();
  await teammate.getByRole("button", { name: "Reactivate", exact: true }).click();
  await expect(teammate.getByRole("cell", { name: "ACTIVE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("cell", { name: "REVOKED", exact: true })).toBeVisible();
  expect(state.invitations[0]?.state).toBe("REVOKED");
  expect(state.mutations.some((path) => path.endsWith("/members/mmem_owner"))).toBe(false);
});

for (const register of [false, true]) test("invitee " + (register ? "registers" : "signs in") + " and accepts without persisting the secret", async ({ page }) => {
  const state = await mock(page, { authenticated: false, active: false });
  await page.goto(base + "/invite#" + secret);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page).toHaveURL(base + "/invite");
  await expect(page.getByText("Fixture Shop", { exact: true })).toHaveCount(0);
  if (register) await page.getByRole("button", { name: "Create a merchant account" }).click();
  await page.getByLabel("Email address").fill(invitedEmail);
  await page.getByLabel("Password", { exact: true }).fill("fixture-long-password");
  await page.getByRole("button", { name: register ? "Create account and accept" : "Sign in and accept", exact: true }).click();
  await expect(page).toHaveURL(base + "/merchant");
  await expect(page.getByRole("heading", { name: "Merchant portal", exact: true })).toBeVisible();
  expect(state.accepted).toBe(true);
  expect(state.registered).toBe(register);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(storage).not.toContain(secret);
});

test("signed-in invitee can accept directly and safely recover from an invalid invitation", async ({ page }) => {
  const state = await mock(page, { active: false, acceptStatus: 409 });
  await page.goto(base + "/invite#" + secret);
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("expired, revoked, used");
  await expect(page.getByText("Fixture Shop", { exact: true })).toHaveCount(0);
  expect(state.accepted).toBe(false);
  await page.reload();
  await expect(page.getByText(/This invitation link is missing or incomplete/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
});

for (const role of ["MANAGER", "PICKER"] as const) test(role + " sees only permitted portal controls", async ({ page }) => {
  const state = await mock(page, { role });
  await page.goto(base + "/merchant");
  await expect(page.getByRole("heading", { name: "Merchant portal", exact: true })).toBeVisible();
  if (role === "MANAGER") {
    await page.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "mmem_teammate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deactivate", exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByRole("navigation").getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
    await page.goto(base + "/merchant/team");
    await expect(page.getByRole("heading", { name: "Team access unavailable" })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Create invitation", exact: true })).toHaveCount(0);
  expect(state.mutations).toEqual([]); // Actual forbidden POST/PATCH calls are tested against the real API.
});

test("member deactivation removes an already open portal on focus", async ({ page }) => {
  const state = await mock(page, { role: "MANAGER" });
  await page.goto(base + "/merchant/team");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  state.active = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(base + "/application");
  await expect(page.getByRole("heading", { name: "Merchant team", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start application", exact: true })).toBeVisible();
});

test("backend outage stays an error rather than redirecting a member to an application", async ({ page }) => {
  const state = await mock(page, { unavailable: true });
  await page.goto(base + "/merchant");
  await expect(page.locator('p.auth-error[role="alert"]')).toBeVisible();
  await expect(page).toHaveURL(base + "/merchant");
  state.unavailable = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Merchant portal", exact: true })).toBeVisible();
});

test("active owner is routed to the portal and can sign out", async ({ page }) => {
  await mock(page);
  // Await the client redirect, including its Next.js route response and chunks.
  await Promise.all([
    page.waitForURL(base + "/merchant"),
    page.goto(base + "/"),
  ]);
  await expect(page).toHaveURL(base + "/merchant");
  await expect(page.getByRole("heading", { name: "Merchant portal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(base + "/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("role reduction removes team contents and navigation on focus", async ({ page }) => {
  const state = await mock(page, { role: "MANAGER" });
  await page.goto(base + "/merchant/team");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  state.role = "PICKER";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Team access unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("navigation").getByRole("link", { name: "Team", exact: true })).toHaveCount(0);
});
