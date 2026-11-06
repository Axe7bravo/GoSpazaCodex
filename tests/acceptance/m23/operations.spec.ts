import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { loadOperationsSelection, type OperationsActor } from "../../../apps/backend/src/scripts/fixtures/operations-acceptance";
import type { DeliveryDiagnostic, DeliveryRescueResult, OperationsOverview } from "@gospaza/contracts";
import { assertOperationsProjection } from "../../../apps/backend/src/scripts/fixtures/operations-allowlists";
const { manifest: f, password } = loadOperationsSelection(), api = "http://localhost:9000", admin = "http://localhost:3003", base = "/admin/gospaza/operations";
async function login(request: APIRequestContext, a: OperationsActor) {
  const signed = await request.post(api + "/auth/" + a.type + "/emailpass", { data: { email: a.email, password: password(a.email) } });
  expect(signed.status()).toBe(200); const { token } = await signed.json() as { token: string }; expect(token).toBeTruthy();
  expect((await request.post(api + "/auth/session", { headers: { Authorization: "Bearer " + token } })).status()).toBe(200);
}
async function privateValuesAbsent(page: Page) {
  for (const text of ["private_sentinel", "school_uniform", "-29.12345", f.actors.customer.email, "bank_account", "provider_refund_id", "otp_hash"]) await expect(page.locator("body")).not.toContainText(text);
}
test.beforeAll(async ({ request }) => {
  expect(f.api_state).toBe("VERIFIED"); const health = await request.get(api + "/health/live"); expect(health.status()).toBe(200); expect(health.headers()["x-gospaza-m23-run"]).toBe(f.run);
});
test("order operator discovers bounded attention and navigates exact diagnostics without financial authority", async ({ page }) => {
  await login(page.request, f.actors.order);
  const response = page.waitForResponse(r => r.url() === api + base && r.status() === 200);
  await page.goto(admin + "/admin/operations"); const data = await (await response).json() as OperationsOverview; assertOperationsProjection("overview", data);
  expect(data.sections.map(s => s.source)).toEqual(["orders"]);
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "orders attention", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Existing domain tools", exact: true }).getByRole("link", { name: "Financial adjustments", exact: true })).toHaveCount(0);
  const lookup = page.getByRole("region", { name: "Exact-ID lookup", exact: true });
  await lookup.getByLabel("Record type", { exact: true }).selectOption("ORDER"); await lookup.getByLabel("Exact record ID", { exact: true }).fill(f.cases.read.order);
  const found = page.waitForResponse(r => r.url() === api + base + "/lookup?type=ORDER&id=" + f.cases.read.order && r.status() === 200);
  await lookup.getByRole("button", { name: "Find authorized record", exact: true }).click(); assertOperationsProjection("lookup", await (await found).json());
  const order = page.waitForResponse(r => r.url() === api + base + "/orders/" + f.cases.read.order && r.status() === 200);
  await lookup.getByRole("link", { name: "Open context", exact: true }).click(); assertOperationsProjection("order", await (await order).json());
  await expect(page).toHaveURL(admin + "/admin/orders/" + f.cases.read.order);
  await expect(page.getByRole("region", { name: "Order diagnostics", exact: true })).toContainText("Handoff VERIFIED");
  await expect(page.getByRole("region", { name: "Authorized financial context", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Delivery diagnostics", exact: true })).toHaveCount(0); await privateValuesAbsent(page);
  await page.getByRole("navigation", { name: "Operations navigation", exact: true }).getByRole("link", { name: "Operations overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
});
test("rescue operator reviews one generation transition and old offers cannot bypass normal dispatch", async ({ page, request }) => {
  const c = f.cases.browserRescue; await login(page.request, f.actors.rescue);
  const preflight = await page.request.get(api + base + "/deliveries/" + c.delivery); expect(preflight.status()).toBe(200);
  const before = await preflight.json() as DeliveryDiagnostic; assertOperationsProjection("delivery", before);
  expect(before.generation, "Single-use browser fixture consumed; generate a fresh selection.").toBe(c.generation); expect(before.revision).toBe(c.revision);
  expect(before.status).toBe("ATTENTION_REQUIRED"); expect(before.reason_code).toBe(c.reason); expect(before.commitment?.status).toBe("DECLINED"); expect(before.commitment?.assigned_at).toBeNull(); expect(before.rescue.eligible).toBe(true);
  const loaded = page.waitForResponse(r => r.url() === api + base + "/deliveries/" + c.delivery && r.status() === 200);
  await page.goto(admin + "/admin/dispatch/" + c.delivery); await loaded;
  const rescue = page.getByRole("region", { name: "Controlled dispatch rescue", exact: true });
  await rescue.getByRole("button", { name: "Review search reopening", exact: true }).click();
  const review = page.getByRole("region", { name: "Review dispatch rescue", exact: true });
  await expect(review).toContainText("generation 1 to generation 2"); await expect(review).toContainText("re-enter normal dispatch"); await expect(review).toContainText("No driver is selected");
  await expect(rescue.getByRole("combobox")).toHaveCount(0); await expect(rescue.getByRole("textbox")).toHaveCount(0);
  const saved = page.waitForResponse(r => r.url() === api + base + "/deliveries/" + c.delivery + "/rescue" && r.request().method() === "POST");
  await rescue.getByRole("button", { name: "Confirm search reopening", exact: true }).click(); const response = await saved; expect(response.status()).toBe(200);
  const result = await response.json() as DeliveryRescueResult; assertOperationsProjection("rescue", result); expect(result.generation).toBe(c.generation + 1);
  const diagnostic = page.getByRole("region", { name: "Delivery diagnostics", exact: true }); await expect(diagnostic).toContainText("generation 2");
  await page.reload(); await expect(diagnostic).toContainText("generation 2"); await expect(rescue.getByRole("button", { name: "Review search reopening", exact: true })).toHaveCount(0);
  await login(request, c.driver); const stale = await request.post(api + "/driver/offers/" + c.old_offer + "/accept", { data: { expected_revision: 1 } }); expect(stale.status()).toBe(409);
  await privateValuesAbsent(page);
});
test("delivery viewer has no rescue authority and an ordinary user cannot inspect operations", async ({ page }) => {
  const c = f.cases.browserPrivacy; await login(page.request, f.actors.delivery);
  const loaded = page.waitForResponse(r => r.url() === api + base + "/deliveries/" + c.delivery && r.status() === 200);
  await page.goto(admin + "/admin/dispatch/" + c.delivery); const data = await (await loaded).json() as DeliveryDiagnostic; assertOperationsProjection("delivery", data); expect(data.can_rescue).toBe(false);
  await expect(page.getByRole("region", { name: "Delivery diagnostics", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review search reopening", exact: true })).toHaveCount(0); await privateValuesAbsent(page);
  const denied = await page.request.post(api + base + "/deliveries/" + c.delivery + "/rescue", { data: { request_id: c.request_id, expected_revision: c.revision, expected_generation: c.generation, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true } }); expect(denied.status()).toBe(403);
  await page.request.delete(api + "/auth/session"); await login(page.request, f.actors.ordinary);
  const forbidden = page.waitForResponse(r => r.url() === api + base && r.status() === 403); await page.goto(admin + "/admin/operations"); await forbidden;
  await expect(page.getByText("Operational information is unavailable or access is not permitted.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "orders attention", exact: true })).toHaveCount(0); await privateValuesAbsent(page);
});
