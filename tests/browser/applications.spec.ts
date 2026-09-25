import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const draft = { id: "mapp_fixture", legal_name: "Fixture Business", trading_name: "Fixture Shop", contact_name: "Applicant", contact_email: "applicant@example.test", contact_phone: "0123456789", address_line_1: "1 Test Street", address_line_2: "", city: "Test city", province: "Test province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "", status: "DRAFT", submitted_at: null, created_at: "2026-09-25T10:00:00Z", updated_at: "2026-09-25T10:00:00Z" };
async function mock(page: Page, state: "none" | "DRAFT" | "SUBMITTED" | "APPROVED", admin = false) {
  let application: Record<string, unknown> | null = state === "none" ? null : { ...draft, status: state, submitted_at: state === "DRAFT" ? null : "2026-09-25T10:00:00Z" };
  let documents: Array<Record<string, unknown>> = [];
  const mutations: string[] = [];
  await page.route("http://localhost:9000/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    const headers = { "access-control-allow-origin": request.headers().origin ?? "http://localhost:3001", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
    const reply = (body: unknown, status = 200) => route.fulfill({ headers, status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") { await route.fulfill({ headers, status: 204 }); return; }
    if (path === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (path === "/admin/gospaza/me") { await reply({ actor: { type: admin ? "user" : "merchant", id: "fixture_identity" } }); return; }
    if (method !== "GET") mutations.push(method + " " + path);
    if (path === "/admin/gospaza/merchant-applications") { await reply({ applications: application ? [application] : [], count: application ? 1 : 0, limit: 20, offset: 0 }); return; }
    if (path.endsWith("/access")) { await route.fulfill({ headers, contentType: "application/pdf", body: "%PDF-1.4\nfixture\n%%EOF" }); return; }
    if (method === "POST" && path === "/merchant/applications") application = { ...draft };
    if (method === "PATCH") application = { ...application, ...request.postDataJSON() };
    if (method === "POST" && path.endsWith("/submit")) application = { ...application, status: "SUBMITTED", submitted_at: "2026-09-25T10:00:00Z" };
    if (method === "POST" && path.endsWith("/documents")) documents = [{ id: "madoc_fixture", display_name: "fixture.pdf", document_type: "OTHER", mime_type: "application/pdf", size_bytes: 100, removal_pending: false }];
    if (method === "DELETE") documents = [];
    await reply({ application, documents });
  });
  return { mutations };
}
// Compile these Next.js development routes before timing the browser journeys.
// HTTP reads do not run client effects or create application fixtures.
test.beforeAll(async ({ request, browser }) => {
  await Promise.all([
    "http://localhost:3001/application",
    "http://localhost:3003/admin/merchant-applications",
    "http://localhost:3003/admin/merchant-applications/mapp_fixture",
  ].map(async (url) => {
    const response = await request.get(url);
    expect(response.ok(), "Application route must be ready: " + url).toBe(true);
    await response.dispose();
  }));
  // The first Chromium page can be slow to initialize on Windows. Keep that
  // startup cost in setup; every journey still gets a fresh, isolated page.
  const startupContext = await browser.newContext();
  try { await startupContext.newPage(); }
  finally { await startupContext.close(); }
});

test("applicant starts, edits, uploads, removes and submits a draft", async ({ page }) => {
  const state = await mock(page, "none"); await page.goto("http://localhost:3001/application");
  await page.getByRole("button", { name: "Start application", exact: true }).click();
  await page.getByLabel("Trading name", { exact: true }).fill("Changed fixture shop");
  // A focus refresh must preserve unsaved form edits.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Trading name", { exact: true })).toHaveValue("Changed fixture shop");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: "fixture.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture\n%%EOF") });
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download fixture.pdf", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove fixture.pdf", exact: true }).click();
  await expect(page.getByText("No documents uploaded.", { exact: true })).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Submit application", exact: true }).click();
  await expect(page.getByText("Status: SUBMITTED", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Legal name", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  expect(state.mutations.some((m) => m.endsWith("/submit"))).toBe(true);
});
for (const status of ["SUBMITTED", "APPROVED"] as const) test(status + " applications stay read-only", async ({ page }) => {
  const state = await mock(page, status); await page.goto("http://localhost:3001/application");
  await expect(page.getByLabel("Legal name", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Submit application", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload document", exact: true })).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
test("admin can list and inspect submitted applications without mutation controls", async ({ page }) => {
  const state = await mock(page, "SUBMITTED", true); await page.goto("http://localhost:3003/admin/merchant-applications");
  await page.getByLabel("Search legal or trading name").fill("Fixture");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: "Fixture Shop", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Shop", exact: true })).toBeVisible();
  await expect(page.getByText("Read-only review. No approval or provisioning action is available.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /approve|reject|save/i })).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
