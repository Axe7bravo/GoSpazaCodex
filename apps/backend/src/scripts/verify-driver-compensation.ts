import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { asValue } from "@medusajs/framework/awilix";
import type { ExecArgs, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import verifyDispatch from "./verify-dispatch";
import { driverCompensationSql } from "../modules/marketplace/driver-compensation-schema";
import { DriverCompensation } from "../lib/driver-compensation";
import { DispatchService } from "../lib/dispatch-service";
import { driverCompensationHandler } from "../lib/driver-compensation-http";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

const conflict = (error: unknown) => !!error && typeof error === "object" && "type" in error && error.type === "conflict";
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "MISSING_COMPENSATION_TERMS";
const decision = (revision: number) => ({ request_id: "m21_" + randomUUID(), expected_revision: revision, confirmed: true, reason: "Explicit synthetic M21 verifier decision" });

export default async function verifyDriverCompensation(args: ExecArgs) {
  if (process.env.APP_ENV !== "test" || !new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test"))
    throw new Error("Use test:isolated with the disposable _test database.");
  const base = args.container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  assert.ok(await base.schema.hasTable("driver_compensation_terms"), "Apply M21-B migration first.");
  assert.equal((await base("driver_compensation_activation")).length, 0,
    "Use a test database without public compensation activation; fixture terms/activation belong only to the private verifier schema.");
  // The verified M15 fixture supplies real native Orders, picking, Redis,
  // eligibility and offers. Only the new Finance records use a private schema.
  // No mock readiness, direct assignment fixture or production default rate.
  await verifyDispatch(args, false, false, async f => {
    const schema = "m21_verify_" + randomUUID().replaceAll("-", "");
    await base.raw("create schema ??", [schema]);
    const db = knex({ client: "pg", connection: process.env.DATABASE_URL, searchPath: [schema, "public"], pool: { min: 0, max: 8 } });
    const scope = args.container.createScope() as MedusaContainer;
    scope.register({ [ContainerRegistrationKeys.PG_CONNECTION]: asValue(db) });
    const service = new DriverCompensation(scope), dispatch = new DispatchService(scope);
    const grants = ["DRIVER_COMPENSATION_MANAGE_USER_IDS", "DRIVER_EARNINGS_VIEW_USER_IDS", "FINANCIAL_VIEW_USER_IDS", "COMMISSION_CONFIGURE_USER_IDS", "SETTLEMENT_APPROVE_USER_IDS"];
    const previous = grants.map(k => process.env[k]);
    try {
      for (const sql of driverCompensationSql) await db.raw(sql);
      delete process.env.DRIVER_COMPENSATION_MANAGE_USER_IDS;
      delete process.env.DRIVER_EARNINGS_VIEW_USER_IDS;
      for (const key of grants.slice(2)) process.env[key] = f.user;
      await assert.rejects(service.publish(f.user, { ...decision(0), amount_minor: 5000, currency: "zar" }), e => !!e && typeof e === "object" && "type" in e && e.type === "forbidden");
      process.env.DRIVER_EARNINGS_VIEW_USER_IDS = f.user;
      await assert.rejects(service.publish(f.user, { ...decision(0), amount_minor: 5000, currency: "zar" }), e => !!e && typeof e === "object" && "type" in e && e.type === "forbidden");
      process.env.DRIVER_COMPENSATION_MANAGE_USER_IDS = f.user;
      const invoke = async (body: unknown, actorType = "user") => {
        let status = 200;
        const res = { setHeader: () => undefined, status: (code: number) => { status = code; return res; }, json: () => undefined };
        await driverCompensationHandler("publish")({ scope, query: {}, body, auth_context: { actor_type: actorType, actor_id: f.user } } as unknown as MedusaRequest, res as unknown as MedusaResponse);
        return status;
      };
      for (const extra of [{ payer: "MERCHANT" }, { amount_minor: 0 }, { driver_profile_id: "foreign" }, { currency: "usd" }])
        assert.equal(await invoke({ ...decision(0), amount_minor: 5000, currency: "zar", ...extra }), 400);
      for (const actor of ["merchant", "driver", "customer"]) assert.equal(await invoke({ ...decision(0), amount_minor: 5000, currency: "zar" }, actor), 401);
      delete process.env.DRIVER_COMPENSATION_MANAGE_USER_IDS;
      assert.equal(await invoke({ ...decision(0), amount_minor: 5000, currency: "zar" }), 403);
      process.env.DRIVER_COMPENSATION_MANAGE_USER_IDS = f.user;
      const historical = await f.completed("m21-historical"), missingOrder = await f.completed("m21-missing"), merchant = await f.completed("m21-merchant"),
        next = await f.completed("m21-next"), racing = await f.completed("m21-publication-race"), rollback = await f.completed("m21-rollback");
      const store = f.orders.fixture.first.store.id;
      const config = await dispatch.configuration(f.user, store);
      if (config.mode !== "HYBRID") await dispatch.configure(f.user, store, { expected_revision: config.revision, mode: "HYBRID", reason: "M21 isolated offer fixtures" });
      async function offer(order: { orderId: string }, name: string, merchantDriver = false) {
        const driver = await f.driver("m21-" + name, merchantDriver ? store : undefined);
        const delivery = await dispatch.ensure(order.orderId);
        await dispatch.start(delivery.id);
        if (!merchantDriver) await dispatch.advance(delivery.id, true);
        await f.online(driver);
        const commitment = await dispatch.offer(delivery.id, driver.id);
        return { driver, delivery, commitment };
      }
      const accept = (o: Awaited<ReturnType<typeof offer>>) => dispatch.decide(o.driver.identity, o.commitment.id, "ACCEPT", { expected_revision: 1 });
      const old = await offer(historical, "historical"); await accept(old);
      assert.equal((await service.resolution(f.user, old.commitment.id)).state, "HISTORICAL_PREACTIVATION");
      assert.equal((await db("driver_compensation_snapshot")).length, 0);
      const activationInput = decision(0), activation = await service.activate(f.user, activationInput);
      assert.deepEqual(await service.activate(f.user, activationInput), activation);
      await assert.rejects(service.activate(f.user, { ...activationInput, reason: "Changed replay" }), conflict);
      await assert.rejects(service.activate(f.user, decision(1)), conflict);
      const { rows: [activationBoundary] } = await db.raw(`select
        (select count(*)::int from gospaza_driver_comp_selection(effective_at-interval '1 microsecond')) as before,
        (select count(*)::int from gospaza_driver_comp_selection(effective_at)) as exact
        from driver_compensation_activation`);
      assert.deepEqual(activationBoundary, { before: 0, exact: 1 });
      const m = await offer(merchant, "merchant", true); await accept(m);
      const merchantSnapshot = (await service.resolution(f.user, m.commitment.id)).snapshot;
      assert.ok(merchantSnapshot); assert.equal(merchantSnapshot.state, "RESOLVED_NON_GOSPAZA_PAYABLE");
      assert.equal(merchantSnapshot.amount_minor, null); assert.equal(merchantSnapshot.terms_id, null);
      const a = await offer(missingOrder, "missing");
      await assert.rejects(accept(a), missing); await assert.rejects(accept(a), missing);
      assert.equal((await db("dispatch_commitment").where({ id: a.commitment.id }).first()).status, "OFFERED");
      assert.equal((await db("delivery_operation").where({ id: a.delivery.id }).first()).status, "OFFERED");
      assert.equal((await db("driver_compensation_exception").where({ commitment_id: a.commitment.id, reason: "MISSING_COMPENSATION_TERMS" })).length, 1);
      assert.equal((await db("driver_compensation_snapshot").where({ commitment_id: a.commitment.id })).length, 0);
      assert.equal((await service.resolution(f.user, a.commitment.id)).state, "MISSING_COMPENSATION_TERMS");
      assert.equal(await invoke({ ...decision(0), amount_minor: 5000, currency: "zar", effective_at: "2000-01-01T00:00:00Z" }), 409);
      const rateAInput = { ...decision(0), amount_minor: 5000, currency: "zar" }, rateA = await service.publish(f.user, rateAInput);
      assert.deepEqual(await service.publish(f.user, rateAInput), rateA);
      await assert.rejects(service.publish(f.user, { ...rateAInput, amount_minor: 6000 }), conflict);
      const duplicate = await Promise.all([accept(a), accept(a)]); assert.deepEqual(duplicate[0], duplicate[1]);
      const snapshotA = (await service.resolution(f.user, a.commitment.id)).snapshot; assert.ok(snapshotA);
      assert.equal(snapshotA.amount_minor, "5000"); assert.equal(snapshotA.terms_id, rateA.id);
      const rateB = await service.publish(f.user, { ...decision(1), amount_minor: 6000, currency: "zar" });
      await accept(a); assert.deepEqual((await service.resolution(f.user, a.commitment.id)).snapshot, snapshotA);
      const b = await offer(next, "rate-b"); await accept(b);
      assert.equal((await service.resolution(f.user, b.commitment.id)).snapshot?.terms_id, rateB.id);
      assert.equal((await db("driver_compensation_snapshot").where({ commitment_id: a.commitment.id })).length, 1);
      const race = await offer(racing, "race");
      const publicationRace = await Promise.allSettled([
        service.publish(f.user, { ...decision(2), amount_minor: 7000, currency: "zar" }),
        service.publish(f.user, { ...decision(2), amount_minor: 8000, currency: "zar" }), accept(race),
      ]);
      assert.equal(publicationRace.slice(0, 2).filter(v => v.status === "fulfilled").length, 1);
      const loser = publicationRace.slice(0, 2).find(v => v.status === "rejected"); assert.ok(loser && loser.status === "rejected"); assert.ok(conflict(loser.reason));
      assert.equal(publicationRace[2]?.status, "fulfilled");
      const { rows: [raceSnapshot] } = await db.raw(`select s.terms_id,(select t.id from driver_compensation_terms t where t.effective_at<=s.assigned_at
        order by t.effective_at desc,t.revision desc limit 1) as expected from driver_compensation_snapshot s where commitment_id=?`, [race.commitment.id]);
      assert.equal(raceSnapshot.terms_id, raceSnapshot.expected);
      const revision = (await service.history(f.user, {})).revision;
      const future = await service.publish(f.user, { ...decision(revision), amount_minor: 9000, currency: "zar", effective_at: "2099-01-01T00:00:00Z" });
      const { rows: [termsBoundary] } = await db.raw(`select
        (select terms_id from gospaza_driver_comp_selection(t.effective_at-interval '1 microsecond')) as before,
        (select terms_id from gospaza_driver_comp_selection(t.effective_at)) as exact from driver_compensation_terms t where t.id=?`, [future.id]);
      assert.notEqual(termsBoundary.before, future.id); assert.equal(termsBoundary.exact, future.id);
      const failed = await offer(rollback, "rollback");
      await db.raw(`create function m21_test_audit_failure() returns trigger as $test$
        begin if NEW.kind='SNAPSHOT' then raise exception 'Injected M21 snapshot audit failure'; end if; return NEW; end;
        $test$ language plpgsql`);
      await db.raw("create trigger m21_test_audit_failure before insert on driver_compensation_audit for each row execute function m21_test_audit_failure()");
      try { await assert.rejects(accept(failed), /Injected M21 snapshot audit failure/); }
      finally { await db.raw("drop trigger m21_test_audit_failure on driver_compensation_audit"); await db.raw("drop function m21_test_audit_failure()"); }
      assert.equal((await db("dispatch_commitment").where({ id: failed.commitment.id }).first()).status, "OFFERED");
      assert.equal((await db("delivery_operation").where({ id: failed.delivery.id }).first()).status, "OFFERED");
      assert.equal((await db("driver_compensation_snapshot").where({ commitment_id: failed.commitment.id })).length, 0);
      assert.equal((await db("dispatch_event").where({ target_id: failed.delivery.id, action: "ASSIGNED" })).length, 0);
      // Skip only this private fixture insert to exercise the installed deferred
      // assignment/snapshot constraint through a real successful ACCEPT body.
      await db.raw(`create function m21_test_skip_snapshot() returns trigger as $test$ begin return null; end; $test$ language plpgsql`);
      await db.raw("create trigger m21_test_skip_snapshot before insert on driver_compensation_snapshot for each row execute function m21_test_skip_snapshot()");
      try { await assert.rejects(accept(failed), /Assigned commitment requires compensation snapshot/); }
      finally { await db.raw("drop trigger m21_test_skip_snapshot on driver_compensation_snapshot"); await db.raw("drop function m21_test_skip_snapshot()"); }
      assert.equal((await db("dispatch_commitment").where({ id: failed.commitment.id }).first()).status, "OFFERED");
      await accept(failed);
      for (const table of ["driver_compensation_snapshot", "driver_compensation_terms", "driver_compensation_activation", "driver_compensation_exception", "driver_compensation_audit"])
        await assert.rejects(async () => { await db(table).whereRaw("true").update({ id: "forged" }); }, /Immutable driver compensation history/);
      await assert.rejects(async () => { await db("driver_compensation_snapshot").where({ commitment_id: a.commitment.id }).delete(); }, /Immutable driver compensation history/);
      // A source insert without its audit reaches deferred COMMIT, then rolls back.
      await assert.rejects(db.transaction(trx => trx("driver_compensation_terms").insert({ id: "missing_audit", scope: "PLATFORM_FLAT", payer: "GOSPAZA",
        affiliation_kind: "PLATFORM", currency: "zar", amount_minor: 1, revision: revision + 2, actor_id: f.user, reason: "Deferred audit negative control",
        request_id: randomUUID(), request_fingerprint: "test", policy_version: "M21_B_V1" })), /Driver compensation audit required/);
      assert.equal((await db("driver_compensation_terms").where({ id: "missing_audit" })).length, 0);
      // Repair scans all authoritative assignments, including retained M15 and
      // earlier test history. The first global page need not contain this UUID.
      // Use its actual predecessor as the exclusive cursor, then replay the
      // same one-row page to prove deduplication without widening repair bounds.
      const predecessor = await db("dispatch_commitment").whereNotNull("assigned_at")
        .where("id", "<", old.commitment.id).orderBy("id", "desc").first("id");
      const historicalPage = { ...(predecessor ? { after: String(predecessor.id) } : {}), limit: 1 };
      const repair = await service.repair(f.user, historicalPage);
      assert.equal(repair.examined, 1); assert.equal(repair.next_after, old.commitment.id);
      const replayRepair = await service.repair(f.user, historicalPage);
      assert.equal(replayRepair.examined, 1); assert.equal(replayRepair.next_after, old.commitment.id);
      assert.equal((await service.resolution(f.user, old.commitment.id)).snapshot, null);
      assert.equal((await db("driver_compensation_exception").where({ commitment_id: old.commitment.id, reason: "HISTORICAL_PREACTIVATION" })).length, 1);
      assert.equal((await service.resolution(f.user, a.commitment.id)).snapshot?.amount_minor, "5000");
    } finally {
      grants.forEach((key, index) => { const prior = previous[index]; if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
      await db.destroy(); await base.raw("drop schema ?? cascade", [schema]);
    }
  });
  console.log("M21-B passed: prospective terms/activation, real ACCEPT snapshots, missing-term holds, replay/races, immutability and rollback. No earnings or payments created.");
}
