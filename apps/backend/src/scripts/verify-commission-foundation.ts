import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IAuthModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CommissionService, resolveCommission } from "../lib/commission-service";
import { readFinancialOrder } from "../lib/financial-native";
import verifyOrderOperations from "./verify-order-operations";

// Uses real M10/M11 Orders and PostgreSQL savepoints. Published finance is
// rolled back as a fixture, never removed by weakening append-only triggers.
export default async function verifyCommissionFoundation(args: ExecArgs) {
  if (process.env.APP_ENV !== "test") throw new Error("Use the isolated test environment.");
  await verifyOrderOperations(args, async fixture => {
    const { container } = fixture.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const identity = await container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(fixture.platform.identity);
    const user = String(identity.app_metadata?.user_id ?? ""); assert.ok(user);
    const grants = ["COMMISSION_CONFIGURE_USER_IDS", "FINANCIAL_VIEW_USER_IDS"];
    const original = grants.map(key => process.env[key]);
    const rollback = new Error("M19 fixture rollback");
    try {
      // The external backend is deliberately ungranted. Its actor middleware
      // must reject customer and merchant cookies even with known Order IDs.
      const path = "/admin/gospaza/orders/" + fixture.a.orderId + "/finance-snapshot";
      fixture.expect(await fixture.http(fixture.a.person.cookie, "GET", path), 401);
      fixture.expect(await fixture.http(fixture.ownerB.cookie, "GET", path), 401);
      delete process.env.COMMISSION_CONFIGURE_USER_IDS;
      delete process.env.FINANCIAL_VIEW_USER_IDS;
      await assert.rejects(new CommissionService(container).history(user, {}));
      process.env.FINANCIAL_VIEW_USER_IDS = user;
      const request = { scope: "PLATFORM", decision: "SET", basis_points: 800,
        expected_revision: 0, request_id: "m19_" + randomUUID(), reason: "Isolated verification", confirmed: true };
      await assert.rejects(new CommissionService(container).publish(user, request));
      process.env.COMMISSION_CONFIGURE_USER_IDS = user;
      const authorized = new CommissionService(container);
      await authorized.history(user,{});
      delete process.env.COMMISSION_CONFIGURE_USER_IDS;
      await assert.rejects(authorized.publish(user,request),error=>!!error && typeof error==="object" && "type" in error && error.type==="forbidden");
      process.env.COMMISSION_CONFIGURE_USER_IDS = user;
      await assert.rejects(db.transaction(async trx => {
        const service = new CommissionService(container, trx);
        const latest = await trx("commission_rule").where({ scope_key: "PLATFORM" }).orderBy("revision", "desc").first();
        const first = await service.publish(user, { ...request, expected_revision: latest?.revision ?? 0 });
        assert.equal(first.basis_points, 800);
        const published = await trx("commission_rule").where({ id: first.id }).first();
        const after = new Date(first.recorded_at.getTime() + 1000);
        assert.equal((await resolveCommission(trx, fixture.fixture.first.merchantId, after)).rule?.basis_points, 800);
        const future = new Date(Date.now() + 86400000);
        const second = await service.publish(user, { ...request, request_id: "m19_" + randomUUID(),
          expected_revision: first.revision, basis_points: 1200, effective_at: future.toISOString() });
        assert.equal((await resolveCommission(trx, fixture.fixture.first.merchantId, new Date(future.getTime() - 1))).rule?.id, first.id);
        assert.equal((await resolveCommission(trx, fixture.fixture.first.merchantId, future)).rule?.id, second.id);
        await assert.rejects(service.publish(user, { ...request, request_id: "m19_" + randomUUID(),
          expected_revision: second.revision, effective_at: "2000-01-01T00:00:00Z" }));
        const merchant = (await trx("order_operation").where({ medusa_order_id: fixture.a.orderId }).first()).merchant_id;
        const override = await service.publish(user, { ...request, scope: "MERCHANT", merchant_id: merchant,
          expected_revision: 0, request_id: "m19_" + randomUUID(), basis_points: 0 });
        const overrideAfter = new Date(override.recorded_at.getTime() + 1000);
        assert.equal((await resolveCommission(trx, merchant, overrideAfter)).rule?.basis_points, 0);
        const clear = await service.publish(user, { scope: "MERCHANT", merchant_id: merchant, decision: "CLEAR",
          expected_revision: override.revision, request_id: "m19_" + randomUUID(), reason: "Clear fixture override", confirmed: true });
        assert.equal((await resolveCommission(trx, merchant, new Date(clear.recorded_at.getTime() + 1000))).rule?.id, first.id);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("commission_rule").where({ id: first.id }).update({ basis_points: 900 });
        }), /Immutable M19 finance history/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("commission_rule_audit").where({ rule_id: first.id }).delete();
        }), /Immutable M19 finance history/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("commission_rule").insert({ ...published, id: "crule_" + randomUUID(),
            recorded_at: null, effective_at: future, revision: second.revision + 1, request_id: randomUUID() });
        }), /duplicate key/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("commission_rule").insert({ ...published, id: "crule_" + randomUUID(),
            recorded_at: null, effective_at: null, revision: second.revision + 1, request_id: randomUUID() });
          await invalid.raw("set constraints commission_audit_consistency immediate");
        }), /matching audit/);
        // Historical existing Orders predate fixture publication and may not be
        // assigned the new current rate. No timestamp or commercial row edits.
        const snapshot = await service.ensure(fixture.a.orderId);
        assert.equal((await resolveCommission(trx, merchant, new Date(0))).rule, null);
        assert.notEqual(snapshot.rule_id, first.id);
        assert.notEqual(snapshot.rule_id, second.id);
        if (!snapshot.rule_id) {
          assert.equal(snapshot.state, "UNRESOLVED");
          assert.ok(snapshot.exceptions.some(row => row.reason === "MISSING_COMMISSION_TERMS"));
        }
        assert.deepEqual(await service.ensure(fixture.a.orderId), snapshot);
        // Inject a changed observation only at the native readback seam. Keep
        // the original commercial Order and its persisted snapshot untouched.
        const changed = new CommissionService(container, trx, async (...args) => {
          const observation = await readFinancialOrder(...args);
          return { ...observation, economics: { ...observation.economics, fingerprint: "conflicting-observation" } };
        });
        for (const result of [await changed.ensure(fixture.a.orderId), await changed.ensure(fixture.a.orderId)]) {
          assert.equal(result.state,"UNRESOLVED");
          assert.deepEqual(result.evidence,snapshot.evidence);
          assert.equal(result.exceptions.filter(row=>row.reason==="ECONOMIC_EVIDENCE_MISMATCH").length,1);
        }
        const discounted = new CommissionService(container, trx, async (...args) => {
          const observation = await readFinancialOrder(...args);
          return { ...observation, order: { ...observation.order, discount_total: 1 } };
        });
        const unknown = await discounted.ensure(fixture.b.orderId);
        assert.ok(unknown.exceptions.some(row=>row.reason==="UNKNOWN_PROMOTION_SPONSORSHIP"));
        assert.equal(Number((await trx("order_finance_snapshot").where({ order_id: fixture.a.orderId }).count("* as count").first())?.count), 1);
        const saved = await trx("order_finance_snapshot").where({ order_id: fixture.a.orderId }).first();
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("order_finance_snapshot").where({ id: saved.id }).update({ basis_points: 0 });
        }), /Immutable M19 finance history/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("order_finance_exception").where({ snapshot_id: saved.id }).delete();
        }), /Immutable M19 finance history/);
        await assert.rejects(db.transaction(async competitor => {
          await competitor("order_operation").where({ medusa_order_id: fixture.a.orderId }).forUpdate().noWait().first();
        }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "55P03");
        await trx.raw("set constraints all immediate");
        throw rollback;
      }), error => error === rollback);
      console.log("M19-B commission foundation verification passed.");
    } finally {
      grants.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
    }
  });
}
