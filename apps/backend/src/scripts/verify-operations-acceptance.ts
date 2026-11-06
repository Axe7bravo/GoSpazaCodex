import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { setTimeout as readinessPoll } from "node:timers/promises";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IOrderModuleService, MedusaContainer } from "@medusajs/framework/types";
import type { DeliveryDiagnostic, DeliveryRescueResult, OperationsOverview, OperationsHealth } from "@gospaza/contracts";
import { spawnOperationsBackend } from "../../scripts/m23-acceptance-server";
import { requireM23PortFree } from "../../scripts/m23-port";
import { loadOperationsSelection, operationsActors, operationsSchema, type OperationsActor, type OperationsActorName, type OperationsCase } from "./fixtures/operations-acceptance";
import { operationsEvidenceTables } from "./fixtures/operations-schema";
import { assertOperationsProjection } from "./fixtures/operations-allowlists";
import { DispatchService } from "../lib/dispatch-service";

const api = "http://localhost:9000", path = "/admin/gospaza/operations";
export default async function verifyOperationsAcceptance({ container }: ExecArgs) {
  const selected = loadOperationsSelection(), f = selected.manifest; operationsSchema(f.schema);
  assert.equal(f.api_state, "READY", "API fixtures are single-use; generate a fresh selection after an interrupted acceptance.");
  await requireM23PortFree();
  const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [f.schema, "public"], pool: { min: 0, max: 8 } });
  const root = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), native = container.resolve<IOrderModuleService>(Modules.ORDER);
  const scope = container.createScope() as MedusaContainer; scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
  const dispatch = new DispatchService(scope), cookies = {} as Record<OperationsActorName, string>;
  let child: ChildProcess | undefined, scenario = "setup";
  async function stop() { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
  async function start(revoked = false) {
    child = spawnOperationsBackend(f, revoked); const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      assert.ok(child.pid && child.exitCode === null && child.signalCode === null, "Owned built backend exited.");
      let r: Response | undefined; try { r = await fetch(api + "/health/live", { signal: AbortSignal.timeout(2000) }); } catch { /* startup readiness only */ }
      if (r?.ok) { assert.equal(r.headers.get("x-gospaza-m23-run"), f.run); return; } await readinessPoll(200);
    } throw Error("Owned built backend did not become ready.");
  }
  async function login(a: OperationsActor) {
    const signed = await fetch(api + "/auth/" + a.type + "/emailpass", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email, password: selected.password(a.email) }), signal: AbortSignal.timeout(30000) });
    assert.equal(signed.status, 200, "Native fixture authentication failed; credentials omitted."); const token = (await signed.json() as { token: string }).token; assert.ok(token);
    const session = await fetch(api + "/auth/session", { method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000) });
    assert.equal(session.status, 200); const cookie = session.headers.getSetCookie().map(value => value.split(";")[0]).join("; "); assert.ok(cookie); return cookie;
  }
  async function request(role: OperationsActorName | { cookie: string }, url: string, status = 200, method = "GET", body?: unknown) {
    const cookie = typeof role === "string" ? cookies[role] : role.cookie;
    const r = await fetch(api + url, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, status, `${typeof role === "string" ? role : "driver"} ${method} ${url}; response omitted.`);
    if (url.startsWith(path) && status !== 401) {
      assert.equal(r.headers.get("x-gospaza-m23-run"), f.run); assert.match(r.headers.get("cache-control") ?? "", /no-store/);
      if (method === "GET") assert.equal(r.headers.get("x-gospaza-m23-forbidden-reads"), "0", "GET entered a mutating legacy helper.");
    }
    return { response: r, body: await r.json() as unknown, sources: (r.headers.get("x-gospaza-m23-sources") ?? "").split(",").filter(Boolean) };
  }
  async function fingerprint() {
    const result: Record<string, unknown> = {};
    for (const table of operationsEvidenceTables) {
      const { rows: [r] } = await db.raw("select md5(coalesce(jsonb_agg(to_jsonb(t) order by t.ctid)::text,'[]')) as digest from ??.?? t", [f.schema, table]); result[table] = r.digest;
    }
    for (const table of ["merchant_application", "merchant_application_document", "merchant_application_review"]) {
      result["public." + table] = await root(table).where(table === "merchant_application" ? { id: f.application } : { application_id: f.application }).orderBy("id");
    }
    result.native = await Promise.all(Object.values(f.cases).map(c => native.retrieveOrder(c.order, { select: ["id", "status", "updated_at"] })));
    return result;
  }
  async function pure(work: () => Promise<void>) { const before = await fingerprint(); await work(); assert.deepEqual(await fingerprint(), before, "Diagnostic GET changed authoritative evidence."); }
  const command = (c: OperationsCase, request_id = c.request_id) => ({ request_id, expected_revision: c.revision, expected_generation: c.generation, expected_status: "ATTENTION_REQUIRED", reason_code: "RETRY_DISPATCH_SEARCH", confirmed: true });
  const rescuePath = (c: OperationsCase) => path + "/deliveries/" + c.delivery + "/rescue";
  async function state(c: OperationsCase) {
    return { delivery: await db("delivery_operation").where({ id: c.delivery }).first(), receipts: await db("delivery_rescue_command").where({ delivery_id: c.delivery }).orderBy("id"),
      commitments: await db("dispatch_commitment").where({ delivery_id: c.delivery }).orderBy("id"), capacity: await db("driver_availability").where({ driver_profile_id: c.driver.profile }).first(),
      audits: await db("dispatch_event").where({ target_id: c.delivery }).orderBy("id") };
  }
  async function oneRescue(c: OperationsCase, role: OperationsActorName = "rescue") {
    const before = await state(c), r = await request(role, rescuePath(c), 200, "POST", command(c)); assertOperationsProjection("rescue", r.body);
    const after = await state(c), result = r.body as DeliveryRescueResult;
    assert.equal(result.generation, c.generation + 1); assert.equal(after.delivery.generation, c.generation + 1);
    assert.deepEqual(after.capacity, before.capacity, "Rescue changed driver capacity."); assert.deepEqual(after.commitments, before.commitments, "Rescue created/assigned a commitment.");
    assert.equal(after.receipts.length, 1); assert.equal(after.audits.filter(row => row.action === "SEARCH_REOPENED").length, 1); return result;
  }
  try {
    f.api_state = "RUNNING"; await writeFile(selected.file, JSON.stringify(f), { mode: 0o600 }); await start();
    for (const name of operationsActors) cookies[name] = await login(f.actors[name]);
    scenario = "capabilities/privacy/purity";
    await pure(async () => {
      const sources: [OperationsActorName, string[]][] = [["order", ["orders"]], ["delivery", ["deliveries"]], ["combined", ["orders", "deliveries"]], ["finance", ["recovery", "adjustments", "credit", "recognition"]], ["notifications", ["notifications"]]];
      for (const [role, allowed] of sources) {
        const r = await request(role, path); assertOperationsProjection("overview", r.body);
        const overview = r.body as OperationsOverview; assert.deepEqual(overview.sections.map(s => s.source).sort(), [...allowed].sort());
        assert.ok(overview.sections.every(s => s.availability === "AVAILABLE"), "Selected source failed instead of returning its bounded projection.");
        const forbidden = role === "order" || role === "delivery" || role === "combined" ? ["financial_", "refund_", "store_credit_", "merchant_period_", "driver_payment", "notification_", "merchant_application_document", "restricted_event"] : role === "finance" ? ["notification_", "dispatch_commitment", "merchant_application_document"] : ["financial_", "driver_payment", "dispatch_commitment", "merchant_application_document"];
        for (const table of r.sources) assert.ok(!forbidden.some(prefix => table.startsWith(prefix)), "Unauthorized source was queried: " + table);
      }
      assert.deepEqual((await request("ordinary", path, 403)).sources, []);
      const c = f.cases.read;
      const order = await request("order", path + "/orders/" + c.order); assertOperationsProjection("order", order.body);
      assert.equal((order.body as { handoff: string }).handoff, "VERIFIED");
      assert.ok(!order.sources.includes("delivery_operation") && !order.sources.includes("financial_adjustment"));
      const combined = await request("combined", path + "/orders/" + c.order); assertOperationsProjection("order", combined.body, ["delivery"]);
      const delivery = await request("delivery", path + "/deliveries/" + c.delivery); assertOperationsProjection("delivery", delivery.body); assert.equal((delivery.body as DeliveryDiagnostic).can_rescue, false);
      for (const role of ["finance", "notifications", "ordinary", "rescueOnly"] as const) {
        assert.deepEqual((await request(role, path + "/orders/" + c.order, 403)).sources, []);
        assert.deepEqual((await request(role, path + "/deliveries/" + c.delivery, 403)).sources, []);
      }
      await request("order", path + "/deliveries/" + c.delivery, 403); await request("delivery", path + "/orders/" + c.order, 403);
      for (const role of ["order", "delivery"] as const) {
        const attention = await request(role, path + "/attention/" + (role === "order" ? "orders" : "deliveries") + "?limit=1"); assertOperationsProjection("attention", attention.body);
        const denied = await request(role, path + "/attention/driver_payments", 403); assert.deepEqual(denied.sources, []);
        for (const [type, id] of [["DRIVER_PAYMENT", f.restricted_payment], ["NOTIFICATION", f.restricted_notification]]) { const lookup = await request(role, path + "/lookup?type=" + type + "&id=" + id, 403); assert.deepEqual(lookup.sources, []); }
        await request(role, path + "/lookup?type=DOCUMENT&id=" + f.document, 400);
      }
      const lookup = await request("order", path + "/lookup?type=ORDER&id=" + c.order); assertOperationsProjection("lookup", lookup.body);
      const timeline = await request("order", path + "/orders/" + c.order + "/timeline"); assertOperationsProjection("timeline", timeline.body);
      assert.deepEqual((timeline.body as { pages: { source: string }[] }).pages.map(p => p.source).sort(), ["decision", "picking"]);
      assert.ok(!timeline.sources.includes("financial_adjustment_event")); await request("order", path + "/orders/" + c.order + "/timeline?source=finance", 403);
      const deliveryTimeline = await request("delivery", path + "/deliveries/" + c.delivery + "/timeline"); assertOperationsProjection("timeline", deliveryTimeline.body);
      assert.deepEqual((deliveryTimeline.body as { pages: { source: string }[] }).pages.map(p => p.source), ["delivery"]);
      assert.ok(!deliveryTimeline.sources.includes("financial_adjustment_event") && !deliveryTimeline.sources.includes("restricted_event"));
      await request("delivery", path + "/deliveries/" + c.delivery + "/timeline?source=compliance", 403);
      const health = await request("combined", path + "/health"); assertOperationsProjection("health", health.body);
      const notices = await request("notifications", path + "/health"); assertOperationsProjection("health", notices.body);
      assert.ok((notices.body as OperationsHealth).notifications?.workers.some(w => w.last_success_at === f.health_at), "Persisted M22 heartbeat not represented.");
    });
    scenario = "legacy capability families";
    await pure(async () => {
      for (const url of ["/admin/gospaza/merchant-applications/" + f.application, "/admin/gospaza/drivers", "/admin/gospaza/service-zones", "/admin/gospaza/stores/" + f.store + "/dispatch-configuration"]) {
        await request("ordinary", url, 403); await request("legacy", url);
      }
      const document = "/admin/gospaza/merchant-applications/" + f.application + "/documents/" + f.document + "/access";
      await request("reviewOnly", document, 403); await request("order", document, 403);
      const authorized = await fetch(api + document, { headers: { Cookie: cookies.legacy }, signal: AbortSignal.timeout(30000) }); assert.equal(authorized.status, 200); assert.match(Buffer.from(await authorized.arrayBuffer()).toString(), /^%PDF-/);
      await request("ordinary", "/admin/gospaza/drivers/" + f.cases.read.driver.profile + "/suspend", 403, "POST", { confirmed: true, expected_revision: 1, reason: "Denied action" });
      await request("ordinary", "/admin/gospaza/stores/" + f.store + "/dispatch-configuration", 403, "PUT", {});
    });
    scenario = "wrong actor / rescue authority";
    for (const name of ["customer", "merchant"] as const) { await request(name, path, 401); await request(name, path + "/orders/" + f.cases.read.order, 401); await request(name, path + "/deliveries/" + f.cases.read.delivery, 401); }
    const c = f.cases.apiRescue, baseline = await state(c);
    for (const role of ["delivery", "rescueOnly", "ordinary", "finance", "notifications"] as const) await request(role, rescuePath(c), 403, "POST", command(c));
    for (const field of ["driver_id", "generation", "mode", "capacity_override", "status", "commitment_state"]) await request("rescue", rescuePath(c), 400, "POST", { ...command(c), [field]: "forged" });
    assert.deepEqual(await state(c), baseline, "Denied/injected rescue changed persisted effects.");
    scenario = "exact/changed replay and capacity";
    const result = await oneRescue(c); assert.deepEqual((await request("rescue", rescuePath(c), 200, "POST", command(c))).body, result);
    const changed = await request("rescue", rescuePath(c), 409, "POST", { ...command(c), expected_revision: c.revision + 1 }); assert.equal((changed.body as { code: string }).code, "RESCUE_STATE_CONFLICT");
    assert.equal((await state(c)).delivery.generation, c.generation + 1);
    scenario = "normal dispatch admission";
    const driverCookie = await login(c.driver); await request({ cookie: driverCookie }, path + "/deliveries/" + c.delivery, 401); await request({ cookie: driverCookie }, "/driver/offers/" + c.old_offer + "/accept", 409, "POST", { expected_revision: 1 });
    assert.ok(c.driver.profile); await assert.rejects(dispatch.offer(c.delivery, c.driver.profile), (e: unknown) => (e as { code?: string }).code === "DISPATCH_CANDIDATE_UNAVAILABLE");
    let availability = await dispatch.readAvailability(c.driver.identity); availability = await dispatch.intent(c.driver.identity, true, { expected_revision: availability.revision }); assert.ok(availability.generation);
    await dispatch.location(c.driver.identity, { generation: availability.generation, sequence: 1, latitude: 0, longitude: 0 });
    const normalOffer = await dispatch.offer(c.delivery, c.driver.profile); assert.equal(normalOffer.generation, c.generation + 1);
    await dispatch.decide(c.driver.identity, normalOffer.id, "DECLINE", { expected_revision: 1 }); availability = await dispatch.readAvailability(c.driver.identity); await dispatch.intent(c.driver.identity, false, { expected_revision: availability.revision });
    scenario = "concurrent distinct rescue commands";
    const race = f.cases.apiRace, raceBefore = await state(race);
    const outcomes = await Promise.allSettled([race.request_id, randomUUID()].map(async id => {
      const response = await fetch(api + rescuePath(race), { method: "POST", headers: { Cookie: cookies.rescue, "Content-Type": "application/json" }, body: JSON.stringify(command(race, id)), signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() as { code?: string } };
    }));
    const accepted: number[] = []; for (const outcome of outcomes) { assert.equal(outcome.status, "fulfilled"); accepted.push(outcome.value.status);
      if (outcome.value.status === 409) assert.equal(outcome.value.body.code, "RESCUE_STATE_CONFLICT"); else { assert.equal(outcome.value.status, 200); assertOperationsProjection("rescue", outcome.value.body); } }
    assert.deepEqual(accepted.sort(), [200, 409]); const raced = await state(race); assert.equal(raced.receipts.length, 1); assert.equal(raced.delivery.generation, race.generation + 1); assert.equal(raced.audits.filter(a => a.action === "SEARCH_REOPENED").length, 1);
    assert.deepEqual(raced.capacity, raceBefore.capacity); assert.deepEqual(raced.commitments, raceBefore.commitments);
    scenario = "stale authoritative state";
    const stale = f.cases.apiStale; await request("rescue", path + "/deliveries/" + stale.delivery); await oneRescue(stale);
    const rejected = await request("rescue", rescuePath(stale), 409, "POST", command(stale, randomUUID())); assert.equal((rejected.body as { code: string }).code, "RESCUE_STATE_CONFLICT"); assert.equal((await state(stale)).delivery.generation, stale.generation + 1);
    scenario = "same-session grant revocation";
    const revoke = f.cases.apiRevoked; await oneRescue(revoke, "revokedRescue");
    const checks: [OperationsActorName, string][] = [["revokedOrder", path + "/orders/" + f.cases.read.order], ["revokedDelivery", path + "/deliveries/" + f.cases.read.delivery], ["revokedLegacy", "/admin/gospaza/merchant-applications/" + f.application]];
    for (const [role, url] of checks) await request(role, url); await stop(); await start(true);
    // No login/session refresh occurs after restart: exactly the same cookies.
    for (const [role, url] of checks) await request(role, url, 403);
    await request("revokedRescue", rescuePath(revoke), 403, "POST", command(revoke));
    const revokedView = await request("revokedRescue", path + "/deliveries/" + revoke.delivery); assert.equal((revokedView.body as DeliveryDiagnostic).can_rescue, false); await request("combined", path);
    for (const name of ["browserRescue", "browserPrivacy", "read"] as const) { const untouched = await state(f.cases[name]); assert.equal(untouched.delivery.generation, f.cases[name].generation); assert.equal(untouched.receipts.length, 0); }
    f.api_state = "VERIFIED"; await writeFile(selected.file, JSON.stringify(f), { mode: 0o600 }); console.log("M23-D direct API acceptance passed: capability, privacy, purity, revocation, rescue and dispatch assertions; browser fixtures retained.");
  } catch (error) { console.error("M23-D acceptance failure:", JSON.stringify({ scenario, run: f.run, classification: error instanceof Error ? error.name : "unknown" })); throw error; }
  finally { await stop(); await db.destroy(); }
}
