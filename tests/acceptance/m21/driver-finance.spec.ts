import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import type { DriverEarningsPage, PlatformEarningsPage } from "@gospaza/contracts";
import type { DriverFinanceManifest } from "../../../apps/backend/src/scripts/fixtures/driver-finance-acceptance";
const f = JSON.parse(readFileSync(process.env.M21_BROWSER_MANIFEST ?? "", "utf8")) as DriverFinanceManifest;
if (!f.api_verified) throw new Error("M21 direct API acceptance must pass first.");
const api = "http://localhost:9000", driver = "http://localhost:3002", admin = "http://localhost:3003";
const password = (email: string) => createHmac("sha256", process.env.M21_VERIFY_SECRET ?? "").update(email).digest("hex");
async function login(page: Page, app: string, email: string) {
  await page.goto(app + "/login"); await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password(email));
  await Promise.all([page.waitForURL(url => url.origin === app && url.pathname !== "/login"), page.getByRole("button", { name: "Sign in", exact: true }).click()]);
}
test("suspended driver retains own earning history and safe payment states after refresh", async ({ page }) => {
  await login(page, driver, f.actors.driver.email);
  const profile = await page.request.get(api + "/driver/profile"); expect(profile.status()).toBe(200);
  expect((await profile.json()).profile.status).toBe("SUSPENDED");
  const response = page.waitForResponse(r => r.url().startsWith(api + "/driver/earnings?") && r.status() === 200);
  await page.goto(driver + "/driver/earnings"); const data = await (await response).json() as DriverEarningsPage;
  expect(data.items.every(row => f.earnings.readonly.includes(row.id))).toBe(true);
  await expect(page.getByRole("heading", { name: "Earnings and payments" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Earning totals" })).toContainText(/Unpaid and available:.*50/);
  await expect(page.getByText("Payment under review", { exact: true })).toBeVisible();
  await expect(page.getByText("Payment recorded", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/No payable amount has been established/)).toBeVisible();
  const id = f.earnings.readonly[0]; expect(id).toBeTruthy();
  await page.getByRole("link", { name: "View earning " + id + "_delivery", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Earning detail" })).toBeVisible();
  await page.reload(); await expect(page.getByRole("region", { name: "Payment summary" })).toContainText("Payment recorded");
  for (const privateText of ["m21_private_beneficiary", "m21_private_origin", "m21_private_evidence", "source_fingerprint", "OTP", "GPS"])
    await expect(page.locator("body")).not.toContainText(privateText);
});
test("platform records an already performed external transfer and separately reconciles it", async ({ page }) => {
  await login(page, admin, f.actors.operator.email);
  const preflight = await page.request.get(api + "/admin/gospaza/driver-finance/earnings?driver=" + f.actors.foreign.profile);
  expect(preflight.status()).toBe(200); const initial = await preflight.json() as PlatformEarningsPage;
  for (const id of f.earnings.browser) expect(initial.items.find(row => row.id === id)?.payment_state,
    "Mutable browser fixture consumed: create a fresh manifest after any successful payment write.").toBe("UNPAID");
  await page.goto(admin + "/admin/driver-finance");
  await page.getByLabel("Driver reference (empty for all)").fill(f.actors.foreign.profile ?? "");
  const filtered = page.waitForResponse(r => r.url().includes("/driver-finance/earnings?") && r.url().includes("driver=") && r.status() === 200);
  await page.getByRole("button", { name: "View driver finance", exact: true }).click(); await filtered;
  const form = page.getByRole("region", { name: "Record external payment" });
  for (const id of f.earnings.browser) await form.getByRole("checkbox", { name: new RegExp(id + "_delivery") }).check();
  await form.getByLabel("Observed amount in cents", { exact: true }).fill("10000");
  await form.getByLabel("Verified beneficiary reference").fill("browser_verified_beneficiary");
  await form.getByLabel("Origin channel reference").fill("browser_private_origin");
  await form.getByLabel("External transfer ID", { exact: true }).fill("browser_bank_" + randomUUID());
  // The production datetime-local control uses its native default 60-second
  // step. Nonzero seconds cause stepMismatch and prevent onSubmit entirely.
  const local = await page.evaluate(() => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
  await form.getByLabel("Actual local transfer time").fill(local);
  await form.getByLabel("Evidence reference").fill("browser_private_evidence"); await form.getByLabel("Reason", { exact: true }).fill("Reviewed external driver transfer");
  const invalidFields = await form.getByRole("group", { name: "Whole unpaid earnings", exact: true }).evaluate(group =>
    Array.from(group.querySelectorAll("input")).filter(input => !input.validity.valid).map(input => ({
      name: input.name || input.type, stepMismatch: input.validity.stepMismatch, badInput: input.validity.badInput,
      valueMissing: input.validity.valueMissing, rangeUnderflow: input.validity.rangeUnderflow,
    })));
  expect(invalidFields, "Native form validation must permit review; field values are deliberately omitted.").toEqual([]);
  await form.getByRole("button", { name: "Review external transfer", exact: true }).click();
  await expect(form.getByRole("heading", { name: "Review external transfer", exact: true })).toBeVisible();
  const confirmPayment = form.getByRole("button", { name: "Confirm record payment", exact: true });
  await expect(confirmPayment).toBeEnabled();
  const [recorded] = await Promise.all([
    page.waitForResponse(r => r.url() === api + "/admin/gospaza/driver-payments/record" && r.request().method() === "POST"),
    confirmPayment.click(),
  ]);
  expect(recorded.status()).toBe(200);
  await expect(page.getByRole("region", { name: "Platform payment detail" })).toContainText("Payment recorded");
  const evidence = page.getByRole("region", { name: "Restricted payment evidence" });
  // Match the select's accessible name. getByLabel exact matching can include
  // option text from the wrapping label, despite the combobox being named Action.
  const action = evidence.getByRole("combobox", { name: "Action", exact: true });
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  await action.selectOption("RECONCILE");
  await expect(action).toHaveValue("RECONCILE");
  await evidence.getByLabel("Review reference").fill("browser_verified_review"); await evidence.getByLabel("Reason", { exact: true }).fill("Matched transfer and whole earnings");
  await evidence.getByRole("checkbox", { name: /I reviewed the displayed evidence/ }).check();
  await evidence.getByRole("button", { name: "Review evidence action", exact: true }).click();
  await expect(evidence.getByRole("heading", { name: "Confirm evidence review", exact: true })).toBeVisible();
  const confirmReconciliation = evidence.getByRole("button", { name: "Confirm reviewed evidence", exact: true });
  await expect(confirmReconciliation).toBeEnabled();
  const [reconciled] = await Promise.all([
    page.waitForResponse(r => /\/driver-payments\/[^/]+\/reconcile$/.test(r.url()) && r.request().method() === "POST"),
    confirmReconciliation.click(),
  ]);
  expect(reconciled.status()).toBe(200);
  await expect(page.getByRole("region", { name: "Platform payment detail" })).toContainText("Reconciled");
  await page.reload(); await expect(page.getByRole("table", { name: "External payment records" })).toContainText("Reconciled");
});
test("ordinary finance viewer and driver foreign navigation preserve privacy; merchant is denied", async ({ page }) => {
  await login(page, admin, f.actors.viewer.email); await page.goto(admin + "/admin/driver-finance");
  await expect(page.getByRole("table", { name: "External payment records" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Record external payment" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Inspect payment / }).first().click();
  await expect(page.getByRole("region", { name: "Platform payment detail" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Restricted payment evidence" })).toHaveCount(0);
  for (const text of ["m21_private_beneficiary", "m21_private_origin", "browser_private_origin", "evidence_reference", "request_id", "source_fingerprint"])
    await expect(page.locator("body")).not.toContainText(text);
  await page.request.delete(api + "/auth/session"); await login(page, driver, f.actors.driver.email);
  const denied = page.waitForResponse(r => r.url() === api + "/driver/earnings/" + f.earnings.foreign[0] && r.status() === 404);
  await page.goto(driver + "/driver/earnings/" + f.earnings.foreign[0]); await denied;
  await expect(page.getByRole("alert").filter({ hasText: /^Driver information or action is unavailable\.$/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(f.actors.foreign.profile ?? "not-a-profile");
  await page.request.delete(api + "/auth/session");
  const signedIn = await page.request.post(api + "/auth/merchant/emailpass", { data: { email: f.actors.merchant.email, password: password(f.actors.merchant.email) } });
  expect(signedIn.status()).toBe(200); const { token } = await signedIn.json();
  expect((await page.request.post(api + "/auth/session", { headers: { Authorization: "Bearer " + token } })).status()).toBe(200);
  expect((await page.request.get(api + "/admin/gospaza/driver-finance/earnings")).status()).toBe(401);
});
