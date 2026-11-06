import { test, expect, type APIRequestContext } from "@playwright/test";
import { loadNotificationSelection, type NotificationActorName } from "../../../apps/backend/src/scripts/fixtures/notification-acceptance";
import type { ActorNotice, NoticePage, DriverAccountDTO, NotificationOperationPage } from "@gospaza/contracts";
const { manifest: f, password } = loadNotificationSelection();
const api = "http://localhost:9000", customer = "http://localhost:3000", driver = "http://localhost:3002", admin = "http://localhost:3003";
const key = { "x-publishable-api-key": f.publishable_key };
const noticeKeys = ["id", "kind", "title", "body", "deep_link", "created_at", "read_at"].sort();
async function login(request: APIRequestContext, actor: NotificationActorName) {
  const a = f.actors[actor];
  const signedIn = await request.post(api + "/auth/" + a.type + "/emailpass", { data: { email: a.email, password: password(a.email) } });
  expect(signedIn.status()).toBe(200); const { token } = await signedIn.json() as { token: string }; expect(token).toBeTruthy();
  expect((await request.post(api + "/auth/session", { headers: { Authorization: "Bearer " + token } })).status()).toBe(200);
}
test.beforeAll(async ({ request }) => {
  expect(f.api_state, "Run M22 real API acceptance before browser acceptance.").toBe("VERIFIED");
  const health = await request.get(api + "/health/live"); expect(health.status()).toBe(200);
  expect(health.headers()["x-gospaza-m22-run"], "Start the built backend with the same selected M22 manifest.").toBe(f.run);
});
test("customer frozen inbox marks read and trusted navigation preserves destination authorization", async ({ page }) => {
  await login(page.request, "customer");
  const id = f.notices.customer; expect(id).toBeTruthy();
  const preflight = await page.request.get(api + "/store/gospaza/notifications/" + id, { headers: key }); expect(preflight.status()).toBe(200);
  const before = await preflight.json() as ActorNotice; expect(before.read_at, "Customer mark-read fixture consumed; generate a fresh selection to rerun this journey.").toBeNull();
  expect(Object.keys(before).sort()).toEqual(noticeKeys);
  const response = page.waitForResponse(r => r.url().startsWith(api + "/store/gospaza/notifications?") && r.status() === 200);
  await page.goto(customer + "/notifications"); const loaded = await response;
  expect(loaded.headers()["x-gospaza-m22-run"]).toBe(f.run); const list = await loaded.json() as NoticePage;
  expect(list.notifications.every(row => row.id !== f.notices.foreignCustomer)).toBe(true);
  const article = page.getByRole("article", { name: f.browser_customer_title, exact: true });
  await expect(article.getByText("Unread", { exact: true })).toBeVisible(); await expect(article).toContainText(before.body);
  await expect(article.locator("img,script")).toHaveCount(0);
  const [saved] = await Promise.all([page.waitForResponse(r => r.url() === api + "/store/gospaza/notifications/" + id + "/read" && r.request().method() === "POST"),
    article.getByRole("button", { name: "Mark notification read: " + f.browser_customer_title, exact: true }).click()]);
  expect(saved.status()).toBe(200); expect((await saved.json() as ActorNotice).read_at).toBeTruthy();
  await expect(article.getByText("Read", { exact: true })).toBeVisible(); await page.reload(); await expect(article.getByText("Read", { exact: true })).toBeVisible();
  const foreign = await page.request.get(api + "/store/gospaza/notifications/" + f.notices.foreignCustomer, { headers: key }); expect(foreign.status()).toBe(404);
  const destination = page.waitForResponse(r => r.url() === api + "/store/gospaza/orders/" + f.target_order && r.status() === 404);
  await article.getByRole("link", { name: "Open notification destination: " + f.browser_customer_title, exact: true }).click(); await destination;
  await expect(page).toHaveURL(customer + "/orders/" + f.target_order);
  await expect(page.getByRole("alert").filter({ hasText: /^Order unavailable\.$/ })).toBeVisible();
  for (const text of ["private-recipient@example.test", "provider_key", "source_evidence", f.actors.foreignCustomer.email]) await expect(page.locator("body")).not.toContainText(text);
});
test("driver historical offer routes to live admission and survives operational suspension", async ({ page, request }) => {
  await login(page.request, "browserDriver"); await login(request, "operator");
  const profile = await page.request.get(api + "/driver/profile"); expect(profile.status()).toBe(200);
  const before = await profile.json() as DriverAccountDTO;
  expect(before.profile.status, "Browser driver suspension fixture consumed; generate a fresh selection to rerun this journey.").toBe("ACTIVE");
  const response = page.waitForResponse(r => r.url().startsWith(api + "/driver/notifications?") && r.status() === 200);
  await page.goto(driver + "/driver/notifications"); await response;
  const article = page.getByRole("article", { name: f.browser_driver_title, exact: true }); await expect(article).toBeVisible();
  await expect(article.getByRole("button", { name: "Accept offer", exact: true })).toHaveCount(0);
  const current = page.waitForResponse(r => r.url() === api + "/driver/dispatch/current" && r.status() === 200);
  await article.getByRole("link", { name: "Open notification destination: " + f.browser_driver_title, exact: true }).click();
  expect((await (await current).json()).commitment).toBeNull();
  await expect(page.getByText("No current delivery offer or assignment.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept offer", exact: true })).toHaveCount(0);
  const stale = await page.request.post(api + "/driver/offers/" + f.offers.browser + "/accept", { data: { expected_revision: 1 } }); expect(stale.status()).toBe(409);
  const freshProfile = await page.request.get(api + "/driver/profile"); const latest = await freshProfile.json() as DriverAccountDTO;
  const suspended = await request.post(api + "/admin/gospaza/drivers/" + latest.profile.id + "/suspend", { data: {
    expected_revision: latest.profile.revision, confirmed: true, reason: "M22 browser historical notice proof" } }); expect(suspended.status()).toBe(200);
  const history = page.waitForResponse(r => r.url().startsWith(api + "/driver/notifications?") && r.status() === 200);
  await page.goto(driver + "/driver/notifications"); await history; await expect(article).toBeVisible();
  const after = await page.request.get(api + "/driver/profile"); expect((await after.json() as DriverAccountDTO).profile.status).toBe("SUSPENDED");
  for (const text of ["beneficiary", "school_uniform", "provider_key", "private-recipient@example.test", "-29.12345"]) await expect(page.locator("body")).not.toContainText(text);
});
test("platform operations distinguishes uncertainty and suppression without private messages", async ({ page }) => {
  await login(page.request, "operator");
  const response = page.waitForResponse(r => r.url().startsWith(api + "/admin/gospaza/notification-operations?") && r.status() === 200);
  await page.goto(admin + "/admin/notifications"); const data = await (await response).json() as NotificationOperationPage;
  expect(data.operations.some(row => row.id === f.notices.ops_attention && row.state === "ATTENTION_REQUIRED")).toBe(true);
  const table = page.getByRole("table", { name: "Notification delivery operations", exact: true });
  await expect(table.getByRole("cell", { name: "Accepted by provider", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Delivery outcome requires attention", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Suppressed", exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Provider send outcome could not be confirmed", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Notification worker health", exact: true })).toContainText("Delivery worker: Disabled");
  await expect(page.getByRole("button", { name: /Resend now|Force send/ })).toHaveCount(0);
  for (const text of ["private-recipient@example.test", "m22_provider_" + f.run, "provider_key", "envelope", "source_evidence", "webhook_signature"])
    await expect(page.locator("body")).not.toContainText(text);
  expect((await page.request.delete(api + "/auth/session")).status()).toBe(200); await login(page.request, "ordinary");
  const denied = page.waitForResponse(r => r.url().startsWith(api + "/admin/gospaza/notification-operations?") && r.status() === 403);
  await page.goto(admin + "/admin/notifications"); await denied;
  await expect(page.getByRole("alert", { name: "Notification operations error", exact: true })).toBeVisible();
  await expect(table).toHaveCount(0);
});
