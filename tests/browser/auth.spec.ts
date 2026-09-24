import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Browser UX tests intercept HTTP. The backend's separate test:integration script
// proves real EmailPass/Redis/PostgreSQL behavior without mocks.
async function mockAuth(page: Page, actor: string, scenario: "success" | "invalid" | "unavailable" | "wrong" = "success") {
  let active = false;
  let registered = false;
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { "access-control-allow-origin": request.headers().origin ?? "http://localhost:3000",
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,authorization,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (path.includes("/emailpass")) {
      if (scenario === "unavailable") { await route.abort(); return; }
      if (scenario === "invalid") { await reply({}, 401); return; }
      await reply({ token: "browser-fixture-token" }); return;
    }
    if (path === "/auth/session") { active = request.method() === "POST"; await reply({ success: true }); return; }
    if (path === "/store/customers" && request.method() === "POST") { registered = true; await reply({ customer: { id: "cus_fixture" } }); return; }
    if (!active) { await reply({}, 401); return; }
    if (path === "/store/customers/me") {
      await reply({ customer: { id: "cus_fixture", email: "browser@example.test", first_name: null, last_name: null } }); return;
    }
    if (path.endsWith("/me")) {
      await reply({ actor: { type: scenario === "wrong" ? "not-the-requested-actor" : actor, id: actor + "_fixture" } }); return;
    }
    await reply({}, 404);
  });
  return { registered: () => registered, active: () => active, expire: () => { active = false; } };
}
const apps = [
  { app: "customer", actor: "customer", port: 3000, protectedPath: "/account" },
  { app: "merchant", actor: "merchant", port: 3001, protectedPath: "/" },
  { app: "driver", actor: "driver", port: 3002, protectedPath: "/" },
  { app: "admin", actor: "user", port: 3003, protectedPath: "/" },
];
for (const app of apps) {
  test(app.app + ": anonymous protection, login, restored session and logout", async ({ page }) => {
    await mockAuth(page, app.actor);
    const base = "http://localhost:" + app.port;
    await page.goto(base + app.protectedPath);
    await expect(page).toHaveURL(base + "/login");
    await page.getByLabel("Email address").fill("browser@example.test");
    await page.getByLabel("Password", { exact: true }).fill("browser-fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(base + app.protectedPath);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    if (app.actor === "customer") await expect(page.getByText("browser@example.test", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(base + "/login");
  });
  for (const scenario of ["invalid", "unavailable", "wrong"] as const) {
    test(app.app + ": " + scenario + " authentication fails safely", async ({ page }) => {
      await mockAuth(page, app.actor, scenario);
      await page.goto("http://localhost:" + app.port + "/login");
      await page.getByLabel("Email address").fill("browser@example.test");
      await page.getByLabel("Password", { exact: true }).fill("browser-fixture-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.locator('p.auth-error[role="alert"]')).toBeVisible();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    });
  }
}
test("customer registration validates input and displays the authenticated account", async ({ page }) => {
  const state = await mockAuth(page, "customer");
  await page.goto("http://localhost:3000/register");
  await page.getByLabel("Email address").fill("invalid");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("valid email");
  expect(state.registered()).toBe(false);
  await page.getByLabel("Email address").fill("browser@example.test");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.locator('p.auth-error[role="alert"]')).toContainText("12 characters");
  await page.getByLabel("Password", { exact: true }).fill("browser-fixture-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL("http://localhost:3000/account");
  await expect(page.getByText("browser@example.test", { exact: true })).toBeVisible();
  expect(state.registered()).toBe(true);
});
test("protected account rechecks an expired or changed session on focus", async ({ page }) => {
  const state = await mockAuth(page, "customer");
  await page.goto("http://localhost:3000/login");
  await page.getByLabel("Email address").fill("browser@example.test");
  await page.getByLabel("Password", { exact: true }).fill("browser-fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  state.expire();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL("http://localhost:3000/login");
});

