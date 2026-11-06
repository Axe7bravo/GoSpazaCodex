import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as startupWait } from "node:timers/promises";
import { resolve } from "node:path";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, IAuthModuleService, IUserModuleService, IOrderModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { OrderDiagnostic, DeliveryDiagnostic, AttentionPage, OperationsOverview, OperationsTimeline, OperationsHealth } from "@gospaza/contracts";
import { OperationsService } from "../lib/operations-service";
import { platformCapabilities } from "../modules/marketplace/platform-capabilities";

const tables = ["merchant", "merchant_store", "merchant_application", "driver_profile", "driver_affiliation", "driver_event", "checkout_completion", "checkout_attempt",
  "delivery_reservation", "cart_marketplace_context", "order_operation", "pick_session", "pick_event", "order_decision_event", "delivery_operation", "dispatch_commitment", "dispatch_event",
  "pickup_operation", "delivery_completion", "restricted_return", "handoff_generation", "recipient_compliance", "driver_compensation_snapshot", "financial_adjustment", "refund_operation",
  "store_credit_operation", "returned_inventory_disposition", "order_finance_snapshot", "order_finance_exception", "merchant_period_statement", "payable_settlement",
  "merchant_settlement_discrepancy", "settlement_exclusion", "driver_payment", "driver_payment_resolution", "driver_payment_reconciliation", "driver_payment_discrepancy",
  "driver_earning_exception", "driver_compensation_exception", "notification_intent", "notification_delivery", "restricted_registration", "financial_adjustment_event", "restricted_event",
  "order_operation_repair_cursor", "dispatch_work", "pickup_work", "provider_operation", "omission_reservation_release", "notification_worker_health", "notification_attempt",
  "notification_attempt_started", "notification_attempt_result", "notification_webhook_receipt", "notification_runtime_observation"] as const;
const roleNames = ["order", "delivery", "review", "driverReview", "configuration", "ordinary", "finance", "notifications", "combined"] as const;
type Role = typeof roleNames[number];
const exact = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
async function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
export default async function verifyOperations({ container }: ExecArgs) {
  assert.equal(process.env.APP_ENV, "test"); assert.equal(process.env.NODE_ENV, "test");
  assert.equal(new URL(process.env.DATABASE_URL ?? "").pathname, "/gospaza_m18_c2b_test"); assert.equal(new URL(process.env.REDIS_URL ?? "").pathname, "/1");
  const base = "http://localhost:9000";
  let listening = false; try { await fetch(base + "/health/live", { signal: AbortSignal.timeout(1500) }); listening = true; } catch { /* no listener */ }
  if (listening) throw Error("Stop the existing backend on port 9000; this verifier owns only its own built backend.");
  const run = randomUUID().replaceAll("-", ""), schema = "m23_b_" + run;
  const original = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 4 } });
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH), users = container.resolve<IUserModuleService>(Modules.USER), native = container.resolve<IOrderModuleService>(Modules.ORDER);
  const actors = {} as Record<Role, { id: string; identity: string; email: string; password: string; cookie: string }>;
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string) => { if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]); process.env[key] = value; };
  let child: ChildProcess | undefined;
  const orderIds: string[] = [];
  const envForServer = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, M23_VERIFICATION_SCHEMA: schema, M23_VERIFICATION_RUN: run, MEDUSA_WORKER_MODE: "server", PORT: "9000",
      REFUND_RECOVERY_WORKER_ENABLED: "false", PAYMENT_RECONCILIATION_WORKER_ENABLED: "false", NOTIFICATION_EMAIL_ENABLED: "false",
      NOTIFICATION_WEBHOOK_ENABLED: "false", NOTIFICATION_DELIVERY_WORKER_ENABLED: "false", NOTIFICATION_REPAIR_WORKER_ENABLED: "false" };
    delete env.M22_ACCEPTANCE_SCHEMA; delete env.M21_ACCEPTANCE_SCHEMA; delete env.M20_ACCEPTANCE_SCHEMA; return env;
  };
  async function start() {
    child = spawn(process.execPath, [require.resolve("@medusajs/cli/cli.js"), "start"], { cwd: resolve(__dirname, "../../.medusa/server"), env: envForServer(), stdio: "inherit", windowsHide: true });
    child.on("error", () => undefined);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw Error("Built operations backend could not start. Build first.");
      let health: Response | undefined;
      try { health = await fetch(base + "/health/live", { signal: AbortSignal.timeout(2000) }); } catch { /* infrastructure readiness only */ }
      if (health?.ok) { assert.equal(health.headers.get("x-gospaza-m23-run"), run); return; }
      await startupWait(200);
    }
    throw Error("Built operations backend did not become ready.");
  }
  async function request<T>(role: Role, path: string, status = 200, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000), headers: { Cookie: actors[role].cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, role + " " + method + " " + path + "; private response omitted.");
    if (path.includes("/operations") && status === 200) { assert.equal(response.headers.get("x-gospaza-m23-run"), run); assert.match(response.headers.get("cache-control") ?? "", /no-store/); }
    return response.json() as Promise<T>;
  }
  async function fingerprint() {
    const result: Record<string, string> = {};
    for (const table of tables) {
      const { rows: [row] } = await db.raw("select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.ctid)::text,'[]')) as digest from ??.?? t", [schema, table]); result[table] = String(row.digest);
    }
    return result;
  }
  async function pure<T>(read: () => Promise<T>): Promise<T> {
    const before = await fingerprint();
    const nativeBefore = await Promise.all(orderIds.map(id => native.retrieveOrder(id, { select: ["id", "status", "updated_at"] })));
    const result = await read();
    assert.deepEqual(await fingerprint(), before, "Diagnostic request changed domain/evidence/work state.");
    assert.deepEqual(await Promise.all(orderIds.map(id => native.retrieveOrder(id, { select: ["id", "status", "updated_at"] }))), nativeBefore, "Diagnostic changed native Order state.");
    return result;
  }
  try {
    for (const role of roleNames) {
      const email = `m23-${role}-${run}@example.test`, password = randomBytes(24).toString("hex"), registered = await auth.register("emailpass", { body: { email, password } });
      assert.ok(registered.authIdentity); const user = await users.createUsers({ email });
      await auth.updateAuthIdentities({ id: registered.authIdentity.id, app_metadata: { user_id: user.id } });
      actors[role] = { id: user.id, identity: registered.authIdentity.id, email, password, cookie: "" };
    }
    for (const capability of platformCapabilities) setEnv(capability + "_USER_IDS", "");
    const grant = (capability: string, roles: Role[]) => setEnv(capability + "_USER_IDS", [...roles, "combined" as const].map(role => actors[role].id).join(","));
    grant("ORDER_OPERATIONS_VIEW", ["order"]); grant("DELIVERY_OPERATIONS_VIEW", ["delivery"]);
    grant("MERCHANT_REVIEW_VIEW", ["review"]); grant("DRIVER_REVIEW_VIEW", ["driverReview"]); grant("SERVICE_CONFIGURATION_VIEW", ["configuration"]);
    grant("FINANCIAL_VIEW", ["finance"]); grant("DRIVER_EARNINGS_VIEW", []); grant("SETTLEMENT_VIEW", []); grant("NOTIFICATION_OPERATIONS_VIEW", ["notifications"]);
    grant("FINANCIAL_VIEW_DISPOSITION", []); grant("DRIVER_COMPENSATION_MANAGE", []); setEnv("RESTRICTED_COMMERCE_REVIEWER_IDS", actors.combined.id);
    await original.raw("create schema ??", [schema]);
    await db.raw("create table m23_verification_marker(run text primary key)"); await db("m23_verification_marker").insert({ run });
    // Private source-input fixtures only. Copy column shapes, not public rows,
    // triggers or authority. Missing/incomplete native handoffs are deliberate.
    // No public generation, commitment, financial or custody row is modified.
    for (const table of tables) {
      await db.raw("create table ??.?? (like public.?? including defaults)", [schema, table, table]);
      const columns = await original("information_schema.columns").where({ table_schema: "public", table_name: table, is_nullable: "NO" }).select("column_name");
      for (const column of columns) await db.raw("alter table ??.?? alter column ?? drop not null", [schema, table, column.column_name]);
    }
    const order = await native.createOrders({ currency_code: "zar" }); orderIds.push(order.id);
    const delivery = "delivery_" + run, now = new Date();
    await db("merchant").insert({ id: "merchant_" + run, status: "ACTIVE", legal_name: "Synthetic", trading_name: "Synthetic" });
    await db("merchant_store").insert({ id: "store_" + run, merchant_id: "merchant_" + run, name: "Synthetic operational store" });
    await db("order_operation").insert({ id: "operation_" + run, medusa_order_id: order.id, status: "ACCEPTED", revision: 1,
      merchant_id: "merchant_" + run, merchant_store_id: "store_" + run, checkout_completion_id: "unproven_completion" });
    await db("pick_session").insert({ id: "pick_" + run, order_operation_id: "operation_" + run, status: "COMPLETED", revision: 1, completed_at: now });
    await db("delivery_reservation").insert({ id: "reservation_" + run, medusa_order_id: order.id, merchant_store_id: "store_" + run, status: "COMMITTED" });
    await db("delivery_operation").insert({ id: delivery, medusa_order_id: order.id, merchant_id: "merchant_" + run, merchant_store_id: "store_" + run,
      order_operation_id: "operation_" + run, pick_session_id: "pick_" + run, reservation_id: "reservation_" + run,
      status: "ATTENTION_REQUIRED", generation: 1, revision: 5, mode: "PLATFORM_ONLY", path: "PLATFORM", reason: "POOL_EXHAUSTED",
      pickup_managed: false, handoff_failures: 0, started_at: now, deadline: new Date(now.getTime() + 60000) });
    await db("dispatch_event").insert({ id: "event_" + run, target_id: delivery, target_type: "DELIVERY", revision: 5, action: "ATTENTION_REQUIRED", occurred_at: now, evidence: { otp: "private_sentinel", gps: "-29.12345" } });
    await db("order_decision_event").insert({ id: "decision_" + run, order_operation_id: "operation_" + run, decided_at: now });
    await db("financial_adjustment").insert({ id: "adjustment_" + run, medusa_order_id: order.id, status: "REVIEW_REQUIRED", amount_minor: 6342, currency: "zar", reason: "GOODWILL", default_method: "STORE_CREDIT" });
    await db("financial_adjustment_event").insert({ id: "finance_event_" + run, adjustment_id: "adjustment_" + run, occurred_at: now, evidence: { bank: "private_sentinel" } });
    await db("notification_worker_health").insert({ name: "delivery", last_success_at: now, last_error: null });
    await start();
    for (const role of roleNames) {
      const actor = actors[role], response = await fetch(base + "/auth/user/emailpass", { method: "POST", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: actor.email, password: actor.password }) });
      assert.equal(response.status, 200); const { token } = await response.json() as { token: string }; assert.ok(token);
      const session = await fetch(base + "/auth/session", { method: "POST", signal: AbortSignal.timeout(30000), headers: { Authorization: "Bearer " + token } });
      assert.equal(session.status, 200); actor.cookie = session.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.ok(actor.cookie);
    }
    const path = "/admin/gospaza/operations";
    const overview = await pure(() => request<OperationsOverview>("order", path)); assert.deepEqual(overview.sections.map(s => s.source), ["orders"]);
    const detail = await pure(() => request<OrderDiagnostic>("order", path + "/orders/" + order.id));
    exact(detail, ["order", "handoff", "operation", "store", "picking", "unavailable_sections"]); assert.equal(detail.handoff, "UNPROVEN");
    assert.equal(detail.finance, undefined); assert.equal(detail.delivery, undefined);
    const d = await pure(() => request<DeliveryDiagnostic>("delivery", path + "/deliveries/" + delivery));
    assert.equal(d.generation, 1); assert.equal(d.rescue.eligible, true); assert.equal(d.rescue.scope, "PERSISTED_PRECHECK");
    exact(d, ["id", "order_id", "merchant_id", "store_id", "status", "revision", "generation", "mode", "path", "reason_code", "timing", "commitment", "pickup", "completion_state", "return_state", "rescue", "can_rescue"]);
    for (const [role, target] of [["order", path + "/deliveries/" + delivery], ["delivery", path + "/orders/" + order.id], ["finance", path + "/orders/" + order.id],
      ["ordinary", path], ["delivery", "/admin/gospaza/merchant-applications/known/documents/known/access"], ["order", path + "/lookup?type=DRIVER_PAYMENT&id=known_payment"]] as const)
      await pure(() => request(role, target, 403));
    await pure(() => request("order", path + "/lookup?type=ORDER&id=" + order.id)); await request("order", path + "/lookup?type=ORDER&id=order_missing", 404);
    await request("order", path + "/lookup?type=EMAIL&id=known", 400);
    const timeline = await pure(() => request<OperationsTimeline>("order", path + "/orders/" + order.id + "/timeline"));
    assert.deepEqual(timeline.pages.map(p => p.source), ["decision", "picking"]); assert.equal(timeline.pages[0]?.items.length, 1);
    await request("order", path + "/orders/" + order.id + "/timeline?source=finance", 403);
    const attention = await pure(() => request<AttentionPage>("delivery", path + "/attention/deliveries?limit=1")); assert.equal(attention.items.filter(item => item.record_id === delivery).length, 1);
    exact(attention.items[0] ?? {}, ["domain", "record_type", "record_id", "reference", "category", "status", "reason_code", "created_at", "economic_at", "summary", "link"]);
    // Distinct synthetic source rows prove sentinel/keyset pagination, not a
    // global total or a second authoritative Delivery for this native Order.
    const sourceRow = await db("delivery_operation").where({ id: delivery }).first(); assert.ok(sourceRow);
    const secondDelivery = delivery + "_second";
    await db("delivery_operation").insert({ ...sourceRow, id: secondDelivery });
    const firstPage = await pure(() => request<AttentionPage>("delivery", path + "/attention/deliveries?limit=1"));
    assert.equal(firstPage.items.length, 1); assert.equal(firstPage.has_more, true);
    const nextCursor = firstPage.next_cursor; assert.ok(nextCursor);
    const secondPage = await pure(() => request<AttentionPage>("delivery", path + "/attention/deliveries?limit=1&cursor=" + encodeURIComponent(nextCursor)));
    assert.equal(secondPage.items.length, 1); assert.equal(secondPage.has_more, false);
    assert.notEqual(firstPage.items[0]?.record_id, secondPage.items[0]?.record_id);
    await request("delivery", path + "/attention/deliveries?limit=26", 400);
    await db("delivery_operation").where({ id: secondDelivery }).delete();
    await db("delivery_operation").where({ id: delivery }).update({ status: "SEARCHING", reason: null });
    assert.equal((await pure(() => request<AttentionPage>("delivery", path + "/attention/deliveries"))).items.length, 0);
    await db("delivery_operation").where({ id: delivery }).update({ status: "ATTENTION_REQUIRED", reason: "POOL_EXHAUSTED" });
    await db("dispatch_commitment").insert({ id: "commitment_" + run, delivery_id: delivery, status: "ASSIGNED", assigned_at: now, driver_profile_id: "driver_" + run, generation: 1, revision: 2 });
    assert.equal((await pure(() => request<DeliveryDiagnostic>("delivery", path + "/deliveries/" + delivery))).rescue.eligible, false);
    await db("dispatch_commitment").delete();
    const health = await pure(() => request<OperationsHealth>("combined", path + "/health")); assert.ok(health.workers.every(worker => worker.execution_health === "NOT_INSTRUMENTED"));
    assert.equal(health.notifications?.workers.find(worker => worker.name === "delivery")?.last_success_at, now.toISOString());
    const all = await pure(() => request<OperationsOverview>("combined", path));
    assert.ok(all.sections.every(section => section.availability === "AVAILABLE"), "Healthy fixture source adapters must not silently fail.");
    // Direct owner composition with the same native identities demonstrates
    // authorization occurs before any private source table query.
    container.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    const queried: string[] = [], observe = (query: { sql: string }) => queried.push(query.sql); db.on("query", observe);
    try {
      await new OperationsService(container).overview(actors.order.id);
      assert.equal(queried.some(sql => /financial_adjustment|notification_intent|dispatch_commitment|driver_payment/.test(sql)), false);
      queried.length = 0;
      await assert.rejects(new OperationsService(container).attention(actors.order.id, "driver_payments", {})); assert.equal(queried.length, 0);
    } finally { db.removeListener("query", observe); container.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(original) }); }
    await request("ordinary", "/admin/gospaza/merchant-applications", 403); await request("review", "/admin/gospaza/merchant-applications");
    await request("ordinary", "/admin/gospaza/drivers", 403); await request("driverReview", "/admin/gospaza/drivers");
    await request("ordinary", "/admin/gospaza/service-zones", 403); await request("configuration", "/admin/gospaza/service-zones");
    for (const endpoint of ["/admin/gospaza/drivers/known/suspend", "/admin/gospaza/merchant-applications/mapp_known/approve"])
      await request("ordinary", endpoint, 403, "POST", { confirmed: true });
    const text = JSON.stringify([overview, detail, d, timeline, attention, health]);
    for (const privateValue of ["private_sentinel", "-29.12345", "provider_key", "storage_key", '"email":', "beneficiary_reference", '"otp":']) assert.equal(text.includes(privateValue), false);
    const cookies = [actors.order.cookie, actors.delivery.cookie, actors.review.cookie];
    setEnv("ORDER_OPERATIONS_VIEW_USER_IDS", actors.combined.id); setEnv("DELIVERY_OPERATIONS_VIEW_USER_IDS", actors.combined.id); setEnv("MERCHANT_REVIEW_VIEW_USER_IDS", actors.combined.id);
    await stop(child); await start();
    assert.deepEqual([actors.order.cookie, actors.delivery.cookie, actors.review.cookie], cookies);
    await request("order", path + "/orders/" + order.id, 403); await request("delivery", path + "/deliveries/" + delivery, 403); await request("review", "/admin/gospaza/merchant-applications", 403);
    await request("combined", path + "/orders/" + order.id);
    assert.equal((await db("delivery_operation").where({ id: delivery }).first())?.generation, 1);
    console.log("M23-B PostgreSQL purity, real session authorization/revocation, bounded diagnostics and legacy read regression passed. No rescue mutation.");
  } finally {
    if (child?.exitCode === null) for (const actor of Object.values(actors)) {
      if (actor.cookie) await fetch(base + "/auth/session", { method: "DELETE", headers: { Cookie: actor.cookie }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
    await stop(child); container.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(original) });
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Only generated private inputs and the native synthetic identities/order
    // created by this verifier are removed. No pre-existing domain data changes.
    await original.raw("drop schema if exists ?? cascade", [schema]); await db.destroy();
    if (orderIds.length) await native.deleteOrders(orderIds);
    const made = Object.values(actors); if (made.length) { await auth.deleteAuthIdentities(made.map(a => a.identity)); await users.deleteUsers(made.map(a => a.id)); }
  }
}
