import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as readinessDelay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { knex } from "@medusajs/framework/mikro-orm/knex";
import type { ExecArgs, IAuthModuleService, IOrderModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import type { ActorNotice, NoticePage, NotificationOperationPage, NotificationHealth, DriverAccountDTO } from "@gospaza/contracts";
import { loadNotificationSelection, notificationAcceptanceSchema, type NotificationActorName } from "./fixtures/notification-acceptance";
import { spawnNotificationBackend } from "../../scripts/m22-acceptance-server";

const noticeKeys = ["id", "kind", "title", "body", "deep_link", "created_at", "read_at"];
const operationKeys = ["id", "kind", "channel", "state", "attempts", "created_at", "accepted_at", "last_code", "transport_disposition"];
const exact = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const base = "http://localhost:9000";
async function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}
async function ready(child: ChildProcess, run: string) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!child.pid) throw Error("M22 built backend could not start. Build it first.");
    if (child.exitCode !== null || child.signalCode !== null) throw Error("M22 built backend exited before readiness.");
    let response: Response | undefined;
    try { response = await fetch(base + "/health/live", { signal: AbortSignal.timeout(2000) }); } catch { /* startup readiness only */ }
    if (response?.ok) { assert.equal(response.headers.get("x-gospaza-m22-run"), run, "M22 backend selection mismatch."); return; }
    await readinessDelay(200);
  }
  throw Error("Selected M22 built backend did not become ready.");
}
export default async function verifyNotificationSurfaces({ container }: ExecArgs) {
  const { manifest: f, file, password } = loadNotificationSelection(); notificationAcceptanceSchema(f.schema);
  assert.equal(f.api_state, "READY", "API fixture already used. Generate a fresh M22 selection.");
  assert.equal(new URL(process.env.DATABASE_URL ?? "").pathname, "/" + f.database);
  let existing = false; try { await fetch(base + "/health/live", { signal: AbortSignal.timeout(1500) }); existing = true; } catch { /* no existing listener */ }
  if (existing) throw Error("Stop the existing backend first. M22 API acceptance owns and restarts only its own built backend.");
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [f.schema, "public"], pool: { min: 0, max: 4 } });
  const cookies = new Map<NotificationActorName, string>(); let child: ChildProcess | undefined;
  async function request<T>(actor: NotificationActorName, path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000), headers: { Cookie: cookies.get(actor) ?? "",
      ...(path.startsWith("/store/") ? { "x-publishable-api-key": f.publishable_key } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, actor + " " + method + " " + path + "; private body omitted.");
    if (path.includes("/notifications") || path.includes("/notification-operations")) {
      if (status === 200 || response.headers.has("x-gospaza-m22-run")) assert.equal(response.headers.get("x-gospaza-m22-run"), f.run, "Backend/manifest selection mismatch.");
      if (status !== 401) assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    return response.json() as Promise<T>;
  }
  async function login(actor: NotificationActorName) {
    const a = f.actors[actor], response = await fetch(base + "/auth/" + a.type + "/emailpass", { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email, password: password(a.email) }) });
    assert.equal(response.status, 200); const { token } = await response.json() as { token: string }; assert.ok(token);
    const session = await fetch(base + "/auth/session", { method: "POST", signal: AbortSignal.timeout(30000), headers: { Authorization: "Bearer " + token } });
    assert.equal(session.status, 200); const cookie = session.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.ok(cookie); cookies.set(actor, cookie);
  }
  async function revokedIdentity(actor: NotificationActorName, path: string) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(30000), headers: { Cookie: cookies.get(actor) ?? "", "x-publishable-api-key": f.publishable_key } });
    // Native authentication may deny before the resource handler, or the
    // handler may fail closed on the now-absent native identity. Never a 5xx.
    assert.ok([401, 404].includes(response.status), "Revoked identity must lose same-session access.");
    const body = await response.json(); assert.equal(JSON.stringify(body).includes("deep_link"), false); assert.equal(JSON.stringify(body).includes("Order confirmed"), false);
  }
  try {
    assert.ok(await db("m22_acceptance_marker").where({ run: f.run, version: 1 }).first());
    for (const key of ["apiCustomer", "merchant", "picker", "revokedMerchant", "driver", "revokedDriver", "revokedCustomer"]) {
      const id = f.notices[key]; assert.ok(id); assert.equal((await db("notification_notice").where({ intent_id: id }).first())?.read_at, null, "API notice fixture was consumed.");
    }
    child = spawnNotificationBackend(f); await ready(child, f.run);
    for (const actor of ["apiCustomer", "foreignCustomer", "revokedCustomer", "merchant", "foreignMerchant", "picker", "revokedMerchant", "driver", "foreignDriver", "revokedDriver", "apiOperator", "ordinary", "financeOnly"] as const) await login(actor);
    // Persist consumption only once the selected server and untouched records
    // have been proven. Browser actors/notices are separate and remain pristine.
    f.api_state = "RUNNING"; await writeFile(file, JSON.stringify(f));
    for (const [own, noticeName, foreignName, prefix] of [
      ["apiCustomer", "apiCustomer", "foreignCustomer", "/store/gospaza"],
      ["merchant", "merchant", "foreignMerchant", "/merchant"],
      ["driver", "driver", "foreignDriver", "/driver"],
    ] as const) {
      const id = f.notices[noticeName], foreignId = f.notices[foreignName]; assert.ok(id && foreignId);
      const page = await request<NoticePage>(own, prefix + "/notifications"); exact(page, ["notifications", "next_cursor"]); page.notifications.forEach(row => exact(row, noticeKeys));
      assert.ok(page.notifications.some(row => row.id === id)); assert.equal(page.notifications.some(row => row.id === foreignId), false);
      exact(await request<ActorNotice>(own, prefix + "/notifications/" + id), noticeKeys);
      const denied = await request(own, prefix + "/notifications/" + foreignId, "GET", undefined, 404);
      assert.deepEqual(denied, await request(own, prefix + "/notifications/not_a_notice", "GET", undefined, 404));
      await request(own, prefix + "/notifications/" + foreignId + "/read", "POST", {}, 404);
      assert.equal((await db("notification_notice").where({ intent_id: foreignId }).first())?.read_at, null);
      const saved = await request<ActorNotice>(own, prefix + "/notifications/" + id + "/read", "POST", {}); assert.ok(saved.read_at); exact(saved, noticeKeys);
      assert.deepEqual(await request(own, prefix + "/notifications/" + id + "/read", "POST", {}), saved);
    }
    const pickerPage = await request<NoticePage>("picker", "/merchant/notifications"); assert.ok(pickerPage.notifications.some(row => row.id === f.notices.picker));
    const target = await container.resolve<IOrderModuleService>(Modules.ORDER).retrieveOrder(f.target_order, { select: ["id", "customer_id"] });
    assert.equal(target.customer_id, f.actors.foreignCustomer.id);
    await request("apiCustomer", "/store/gospaza/orders/" + f.target_order, "GET", undefined, 404);
    assert.equal(pickerPage.notifications.some(row => /SETTLEMENT/.test(row.kind)), false);
    await request("picker", "/merchant/notifications/" + f.notices.merchant_finance, "GET", undefined, 404);
    const revokedMember = f.actors.revokedMerchant.member; assert.ok(revokedMember);
    await request("revokedMerchant", "/merchant/notifications/" + f.notices.revokedMerchant);
    await request("merchant", "/merchant/team/members/" + revokedMember, "PATCH", { status: "INACTIVE" });
    await request("revokedMerchant", "/merchant/notifications", "GET", undefined, 401);
    // The same frozen notice link cannot restore revoked destination authority.
    await request("revokedMerchant", "/merchant/orders/" + f.target_order, "GET", undefined, 401);
    const before = await request<DriverAccountDTO>("driver", "/driver/profile"); assert.equal(before.profile.status, "ACTIVE");
    await request("driver", "/driver/offers/" + f.offers.api + "/accept", "POST", { expected_revision: 1 }, 409);
    assert.equal((await db("dispatch_commitment").where({ id: f.offers.api }).first())?.status, "EXPIRED");
    await request("apiOperator", "/admin/gospaza/drivers/" + before.profile.id + "/suspend", "POST", { expected_revision: before.profile.revision, confirmed: true, reason: "M22 historical notification access" });
    assert.ok((await request<NoticePage>("driver", "/driver/notifications")).notifications.length);
    const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
    await request("revokedDriver", "/driver/notifications"); await auth.deleteAuthIdentities([f.actors.revokedDriver.identity]); await revokedIdentity("revokedDriver", "/driver/notifications");
    await request("revokedCustomer", "/store/gospaza/notifications"); await auth.deleteAuthIdentities([f.actors.revokedCustomer.identity]); await revokedIdentity("revokedCustomer", "/store/gospaza/notifications");
    const ops = await request<NotificationOperationPage>("apiOperator", "/admin/gospaza/notification-operations"); exact(ops, ["operations", "next_cursor"]); ops.operations.forEach(row => exact(row, operationKeys));
    for (const actor of ["ordinary", "financeOnly"] as const) await request(actor, "/admin/gospaza/notification-operations", "GET", undefined, 403);
    const health = await request<NotificationHealth>("apiOperator", "/admin/gospaza/notification-operations/health");
    exact(health, ["window_start", "sampled", "truncated", "states", "in_app", "email_attempts", "dispatched_attempts", "ambiguous", "stale_suppressions", "webhook_evidence", "retrieval_mismatches", "repair_discoveries", "oldest_pending_age_seconds", "workers"]);
    health.workers.forEach(row => { exact(row, ["name", "enabled", "last_success_at", "last_error"]); assert.equal(row.enabled, false); });
    assert.ok(ops.operations.some(row => row.state === "ATTENTION_REQUIRED")); assert.ok(ops.operations.some(row => row.state === "SUPPRESSED")); assert.ok(ops.operations.some(row => row.channel === "EMAIL" && row.state === "ACCEPTED"));
    const existingCookie = cookies.get("apiOperator"); assert.ok(existingCookie);
    await stop(child); child = spawnNotificationBackend(f, true); await ready(child, f.run);
    assert.equal(cookies.get("apiOperator"), existingCookie);
    const me = await request<{ actor: { id: string } }>("apiOperator", "/admin/gospaza/me"); assert.equal(me.actor.id, f.actors.apiOperator.id);
    await request("apiOperator", "/admin/gospaza/notification-operations", "GET", undefined, 403);
    const browserNotice = f.notices.customer; assert.ok(browserNotice);
    assert.equal((await db("notification_notice").where({ intent_id: browserNotice }).first())?.read_at, null);
    assert.equal((await db("driver_profile").where({ id: f.actors.browserDriver.profile }).first())?.status, "ACTIVE");
    f.api_state = "VERIFIED"; await writeFile(file, JSON.stringify(f));
    console.log("M22-E real HTTP/session, privacy, revocation, stale-offer and authorization acceptance passed. Browser fixtures remain pristine.");
  } finally {
    if (child?.exitCode === null) for (const cookie of cookies.values()) await fetch(base + "/auth/session", { method: "DELETE", headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    await stop(child); await db.destroy();
  }
}
