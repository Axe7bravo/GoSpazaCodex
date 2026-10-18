import { expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { CustomerOrder, PickingOrder, OrderShortages, MerchantMemberRole, MerchantCapability } from "@gospaza/contracts";

export const customerBase = "http://localhost:3000";
export const merchantBase = "http://localhost:3001";
export const customerPath = "/store/gospaza/orders/order_fixture";
export const merchantPath = "/merchant/picking/order_fixture";
const timestamp = "2026-10-17T10:00:00Z";
export function fixtureState(role: MerchantMemberRole = "PICKER") {
  const order: CustomerOrder = {
    id: "order_fixture", display_id: 42, created_at: timestamp, operational_status: "ACCEPTED", currency_code: "zar",
    items: [{ id: "line_fixture", title: "Fixture tomatoes", variant_title: "1 kg", sku: "TOM-1", quantity: 5, unit_price_minor: 2500, total_minor: 12500 }],
    totals: { total_minor: 13500, subtotal_minor: 12500, shipping_total_minor: 1000, tax_total_minor: 0, discount_total_minor: 0 },
    delivery: { starts_at: timestamp, ends_at: "2026-10-17T11:00:00Z", shipping_name: "Scheduled delivery" }, store: { name: "Fixture Shop" },
  };
  const picking: PickingOrder = {
    id: order.id, display_id: 42, created_at: timestamp, status: "IN_PROGRESS", revision: 1,
    assigned_member_id: "member_fixture", started_at: timestamp, completed_at: null,
    lines: [{ id: "line_fixture", title: "Fixture tomatoes", variant_title: "1 kg", sku: "TOM-1", ordered_quantity: 5,
      picked_quantity: 2, omitted_quantity: 0, unresolved_quantity: 3, shortage_recorded: true }],
  };
  const shortages: OrderShortages = { preference: { preference: "CONTACT_ME", revision: 0, chosen_at: null, frozen_at: null }, shortages: [] };
  return { order, picking, shortages, role, active: true, outage: false,
    writes: [] as { path: string; body: Record<string, unknown> }[], reads: [] as string[],
    beforeWrite: undefined as (() => Promise<void>) | undefined, conflict: undefined as (() => void) | undefined };
}
export type Fixture = ReturnType<typeof fixtureState>;
export function pending(state: Fixture, picked = 2, generation = "case_1") {
  state.shortages.preference = { ...state.shortages.preference, frozen_at: timestamp, revision: 2 };
  state.shortages.shortages = [{ id: generation, line_id: "line_fixture", revision: 1, status: "CUSTOMER_DECISION_REQUIRED",
    ordered_quantity: 5, picked_quantity: picked, omitted_quantity: 0, unresolved_quantity: 5 - picked,
    preference: state.shortages.preference.preference, financial_review_required: false, resolved_at: null }];
  const line = state.picking.lines.find((item) => item.id === "line_fixture");
  if (!line) throw new Error("Fixture needs its original line");
  Object.assign(line, { picked_quantity: picked, omitted_quantity: 0, unresolved_quantity: 5 - picked, shortage_recorded: true });
}
export function resolved(state: Fixture) {
  const item = state.shortages.shortages[0];
  if (!item) throw new Error("Fixture needs a shortage generation");
  item.status = "RESOLVED_OMITTED"; item.revision++; item.omitted_quantity = item.unresolved_quantity;
  item.unresolved_quantity = 0; item.financial_review_required = true; item.resolved_at = timestamp;
  const line = state.picking.lines.find((candidate) => candidate.id === item.line_id);
  if (!line) throw new Error("Fixture needs its original line");
  Object.assign(line, { omitted_quantity: item.omitted_quantity, unresolved_quantity: 0 });
}
export async function install(context: BrowserContext, state: Fixture) {
  await context.route("http://localhost:9000/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    const headers = { "access-control-allow-origin": request.headers().origin ?? customerBase,
      "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,x-publishable-api-key",
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "cache-control": "no-store" };
    const reply = (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(value) });
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (method === "GET") state.reads.push(path);
    if (path === "/store/gospaza/me") { await reply({ actor: { type: "customer", id: "cus_fixture" } }); return; }
    if (path === "/store/customers/me") { await reply({ customer: { id: "cus_fixture", email: "customer@example.test" } }); return; }
    if (path === "/merchant/applicant/me") { await reply({ applicant: true }); return; }
    if (path === "/merchant/applications/me") { await reply({ application: null, documents: [], review_history: [], tenant: null }); return; }
    if (path.startsWith("/merchant/") && !state.active) { await reply({}, 401); return; }
    if (path === "/merchant/me") {
      const capabilities: MerchantCapability[] = ["MERCHANT_PORTAL_ACCESS", "MERCHANT_CONTEXT_VIEW", "MERCHANT_PICKING_VIEW", "MERCHANT_PICKING_PERFORM"];
      if (state.role !== "PICKER") capabilities.push("MERCHANT_PICKING_REASSIGN", "MERCHANT_TEAM_VIEW", "MERCHANT_ORDER_VIEW", "MERCHANT_ORDER_DECIDE");
      await reply({ merchant: { id: "mer_fixture", legal_name: "Fixture Shop", trading_name: "Fixture Shop" }, store: { id: "store_fixture", name: "Fixture Shop" },
        membership: { id: "member_fixture", member_type: state.role, capabilities } }); return;
    }
    if (path === customerPath && method === "GET") { await reply({ order: state.order }); return; }
    if (state.outage) { await reply({ message: "private diagnostic" }, 503); return; }
    if ([customerPath + "/shortages", merchantPath + "/shortages"].includes(path) && method === "GET") { await reply(state.shortages); return; }
    if (path === merchantPath + "/complete" && method === "POST") {
      const body: Record<string, unknown> = request.postDataJSON();
      state.writes.push({ path, body });
      expect(body).toEqual({ expected_revision: state.picking.revision, confirmed: true });
      expect(state.picking.lines.every((line) => line.picked_quantity + (line.omitted_quantity ?? 0) === line.ordered_quantity && line.unresolved_quantity === 0)).toBe(true);
      state.picking.status = "COMPLETED"; state.picking.completed_at = timestamp; state.picking.revision++;
      await reply({ picking: state.picking, applied_revision: state.picking.revision }); return;
    }
    if (path === merchantPath && method === "GET") { await reply({ picking: state.picking }); return; }
    if (path === customerPath + "/substitution-preference" && method === "GET") { await reply({ preference: state.shortages.preference }); return; }
    if (path.startsWith(customerPath + "/") && ["POST", "PUT"].includes(method)) {
      const body: Record<string, unknown> = request.postDataJSON();
      state.writes.push({ path, body }); await state.beforeWrite?.();
      if (state.conflict) { state.conflict(); await reply({ code: "SHORTAGE_CONFLICT" }, 409); return; }
      if (path.endsWith("/substitution-preference")) {
        expect(Object.keys(body).sort()).toEqual(["expected_revision", "preference"]);
        expect(body.expected_revision).toBe(state.shortages.preference.revision);
        if (body.preference !== "CONTACT_ME" && body.preference !== "NO_SUBSTITUTION") throw new Error("Invalid fixture preference");
        if (state.shortages.preference.frozen_at) { await reply({}, 409); return; }
        if (!state.shortages.preference.chosen_at || state.shortages.preference.preference !== body.preference) {
          state.shortages.preference = { preference: body.preference, chosen_at: timestamp, frozen_at: null, revision: state.shortages.preference.revision + 1 };
        }
        await reply({ preference: state.shortages.preference }); return;
      }
      const item = state.shortages.shortages[0];
      if (!item || path !== customerPath + "/shortages/" + item.id + "/omit") { await reply({}, 409); return; }
      expect(body).toEqual({ confirmed: true, expected_revision: item.revision });
      resolved(state); await reply({ shortage: item }); return;
    }
    await reply({}, 404);
  });
}
export async function openCustomer(page: Page) {
  await page.goto(customerBase + "/orders/order_fixture");
  await expect(page.getByRole("heading", { name: "Your order preference", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh shortages", exact: true })).toBeEnabled();
}
export async function openMerchant(page: Page) {
  await page.goto(merchantBase + merchantPath);
  await expect(page.getByRole("heading", { name: "Pick order #42", exact: true })).toBeVisible();
}
