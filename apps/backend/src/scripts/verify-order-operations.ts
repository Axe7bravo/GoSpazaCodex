import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import type { ExecArgs, IAuthModuleService, IOrderModuleService, IUserModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ReconciledOrderFixture } from "./verify-payment-reconciliation";
import verifyPaymentReconciliation from "./verify-payment-reconciliation";
import { OrderOperationsService } from "../lib/order-operations-service";
import orderPlaced from "../subscribers/order-placed";
import { checkoutMoney } from "../lib/checkout-native";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";

const safeOrder = z.object({
  id: z.string(), display_id: z.number(), operational_status: z.literal("PENDING_ACCEPTANCE"), revision: z.literal(0),
  items: z.array(z.object({ title: z.string(), quantity: z.number().int().positive(), unit_price_minor: z.number().int(), total_minor: z.number().int() })),
  totals: z.object({ total_minor: z.number().int(), subtotal_minor: z.number().int(), shipping_total_minor: z.number().int() }),
});
const list = z.object({ orders: z.array(safeOrder), count: z.number().int(), limit: z.number(), offset: z.number() });

export interface OrderOperationsVerificationFixture extends ReconciledOrderFixture {
  ownerA: { identity: string; cookie: string; id: string };
  ownerB: { identity: string; cookie: string; id: string };
  manager: { identity: string; cookie: string; id: string };
  picker: { identity: string; cookie: string; id: string };
  managerPeer: { identity: string; cookie: string; id: string };
  applicant: { identity: string; cookie: string };
  platform: { identity: string; cookie: string };
  a: Awaited<ReturnType<ReconciledOrderFixture["complete"]>>;
  b: Awaited<ReturnType<ReconciledOrderFixture["complete"]>>;
}

// Real M10 completion, PostgreSQL concurrency, native reads and HTTP auth.
// Only external Yoco transport is substituted by the existing M10 fixture.
export default async function verifyOrderOperations(args: ExecArgs, extension?: (fixture: OrderOperationsVerificationFixture) => Promise<void>) {
  await verifyPaymentReconciliation(args, async (orderFixture) => {
    const { fixture, complete, recovery, http, expect } = orderFixture;
    const { container, first, second, request } = fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
    const users = container.resolve<IUserModuleService>(Modules.USER);
    const native = container.resolve<IOrderModuleService>(Modules.ORDER);
    const service = new OrderOperationsService(container);
    const prefix = "m11b-" + randomUUID();
    const identities: string[] = [], members: string[] = [], cookies: string[] = [], userIds: string[] = [];
    const restoredOwners: { memberId: string; applicationId: string; identity: string }[] = [];
    const failures: unknown[] = [];
    async function session(suffix: string, actor = "merchant") {
      const email = prefix + suffix + "@example.test", password = randomBytes(24).toString("hex");
      const registered = await auth.register("emailpass", { body: { email, password } });
      assert.ok(registered.authIdentity);
      const identity = registered.authIdentity.id;
      identities.push(identity);
      if (actor === "user") {
        const user = await users.createUsers({ email }); userIds.push(user.id);
        await auth.updateAuthIdentities({ id: identity, app_metadata: { user_id: user.id } });
      }
      const login = z.object({ token: z.string() }).parse(expect(await http("", "POST", "/auth/" + actor + "/emailpass", { email, password })));
      const exchange = await fetch(new URL("/auth/session", process.env.BACKEND_URL), {
        method: "POST", headers: { Authorization: "Bearer " + login.token }, signal: AbortSignal.timeout(30000),
      });
      assert.equal(exchange.status, 200);
      const cookie = exchange.headers.getSetCookie().map((part) => part.split(";")[0]).join("; ");
      assert.ok(cookie); cookies.push(cookie);
      return { identity, cookie };
    }
    async function owner(merchantId: string, suffix: string) {
      const who = await session(suffix);
      const row = await db<{ member_id: string; application_id: string; identity: string }>("merchant_member as m")
        .join("merchant as merchant", "merchant.id", "m.merchant_id")
        .where({ "m.merchant_id": merchantId, "m.member_type": "OWNER" })
        .select("m.id as member_id", "merchant.source_application_id as application_id", "m.auth_identity_id as identity").first();
      assert.ok(row);
      restoredOwners.push({ memberId: row.member_id, applicationId: row.application_id, identity: row.identity });
      // Only this invocation's synthetic M8 owner is replaced with a real session.
      await db.transaction(async (trx) => {
        await trx("merchant_member").where({ id: row.member_id }).update({ auth_identity_id: who.identity });
        await trx("merchant_application").where({ id: row.application_id }).update({ applicant_identity_id: who.identity });
      });
      return { ...who, id: row.member_id };
    }
    async function member(role: "MANAGER" | "PICKER", suffix: string = role) {
      const who = await session(suffix);
      const id = "mmem_" + randomUUID(); members.push(id);
      await db("merchant_member").insert({ id, merchant_id: first.merchantId, auth_identity_id: who.identity, member_type: role });
      return { ...who, id };
    }
    const event = (id: string) => orderPlaced({ container, event: { name: "order.placed", data: { id } }, pluginOptions: {} });
    try {
      const a = await complete("order-operations-a"), b = await complete("order-operations-b", second.variantId);
      const ownerA = await owner(first.merchantId, "owner-a"), ownerB = await owner(second.merchantId, "owner-b");
      const manager = await member("MANAGER"), picker = await member("PICKER");
      const managerPeer = await member("MANAGER", "manager-peer");
      const applicant = await session("applicant"), platform = await session("platform", "user");

      await db("order_operation").where({ medusa_order_id: a.orderId }).delete();
      // Hostile merchant reads must not use repair to materialize a foreign Order.
      const foreignMissing = await http(ownerB.cookie, "GET", "/merchant/orders/" + a.orderId);
      const unknownMissing = await http(ownerB.cookie, "GET", "/merchant/orders/order_missing");
      expect(foreignMissing, 404); expect(unknownMissing, 404);
      assert.deepEqual(foreignMissing.body, unknownMissing.body);
      const foreignPage = list.parse(expect(await http(ownerB.cookie, "GET", "/merchant/orders?limit=1&offset=0")));
      assert.ok(foreignPage.orders.every((order) => order.id !== a.orderId));
      assert.equal((await db("order_operation").where({ medusa_order_id: a.orderId })).length, 0,
        "foreign detail/list cannot provision the missing operation");
      // A second repair worker skips an already-owned durable cursor. This
      // exercises real PostgreSQL locking without scanning unrelated local Orders.
      await db.transaction(async (trx) => {
        assert.ok(await trx("order_operation_repair_cursor").where({ id: "completed-orders" }).forUpdate().first());
        const skipped = await Promise.all([service.repairBatch(), new OrderOperationsService(container).repairBatch()]);
        assert.deepEqual(skipped, [{ examined: 0, deferred: 0 }, { examined: 0, deferred: 0 }]);
      });
      const results = await Promise.all([service.ensure(a.orderId), new OrderOperationsService(container).ensure(a.orderId), service.ensure(a.orderId)]);
      assert.ok(results[0]);
      assert.ok(results.every((row) => row?.id === results[0]?.id));
      await Promise.all([event(a.orderId), event(a.orderId)]);
      assert.equal((await db("order_operation").where({ medusa_order_id: a.orderId })).length, 1);
      assert.equal((await new OrderOperationsService(container).ensure(a.orderId))?.id, results[0].id);
      const handoff = await readOrderHandoff(db, a.orderId); assert.ok(handoff);
      const foreignRead = await http(ownerB.cookie, "GET", "/merchant/orders/" + a.orderId);
      expect(foreignRead, 404);
      await assert.rejects(() => db("order_operation").insert({ id: "oop_" + randomUUID(), medusa_order_id: a.orderId,
        checkout_completion_id: handoff.completion_id, merchant_id: first.merchantId, merchant_store_id: first.store.id }));
      await assert.rejects(() => db("order_operation").where({ medusa_order_id: a.orderId }).update({ merchant_id: second.merchantId, merchant_store_id: second.store.id }));
      await assert.rejects(() => db("order_operation").where({ medusa_order_id: a.orderId }).update({ status: "ACCEPTED", revision: 1 }));

      // Native existence, metadata and an early event confer no authority.
      const partial = await native.createOrders({ customer_id: recovery.customerId, currency_code: "zar",
        metadata: { merchant_id: first.merchantId, merchant_store_id: first.store.id } });
      assert.equal(await service.ensure(partial.id), null);
      await event(partial.id);
      await db("checkout_completion").where({ id: recovery.completionId }).update({ order_id: partial.id });
      assert.equal(await service.ensure(partial.id), null, "RECOVERY_REQUIRED cannot provision even with an Order reference");
      await event(partial.id);
      assert.equal((await db("order_operation").where({ medusa_order_id: partial.id })).length, 0);
      await assert.rejects(() => db("order_operation").insert({ id: "oop_" + randomUUID(), medusa_order_id: partial.id,
        checkout_completion_id: recovery.completionId, merchant_id: first.merchantId, merchant_store_id: first.store.id }));
      expect(await http(ownerA.cookie, "GET", "/merchant/orders/" + partial.id), 404);

      for (const who of [ownerA, manager]) {
        const detail = z.object({ order: safeOrder }).parse(expect(await http(who.cookie, "GET", "/merchant/orders/" + a.orderId)));
        assert.equal(detail.order.id, a.orderId);
        const page = list.parse(expect(await http(who.cookie, "GET", "/merchant/orders?limit=1&offset=0&status=PENDING_ACCEPTANCE")));
        assert.equal(page.orders.length, 1);
        assert.ok(page.count >= 1);
        assert.ok(!page.orders.some((order) => order.id === b.orderId));
      }
      const foreign = await http(ownerA.cookie, "GET", "/merchant/orders/" + b.orderId);
      const unknown = await http(ownerA.cookie, "GET", "/merchant/orders/order_unknown");
      expect(foreign, 404); expect(unknown, 404); assert.deepEqual(foreign.body, unknown.body);
      expect(await http(ownerB.cookie, "GET", "/merchant/orders/" + a.orderId), 404);
      expect(await http(ownerA.cookie, "GET", "/merchant/orders/" + results[0].id), 404);
      for (const query of ["merchant_id=" + second.merchantId, "store_id=" + second.store.id, "customer_id=" + b.person.id,
        "sales_channel_id=" + second.channelId, "fields=*", "limit=101", "offset=-1", "status=COMPLETED", "status=PENDING_ACCEPTANCE&merchant_id=" + second.merchantId]) {
        expect(await http(ownerA.cookie, "GET", "/merchant/orders?" + query), 400);
      }
      for (const path of ["/merchant/orders", "/merchant/orders/" + a.orderId]) {
        expect(await http(picker.cookie, "GET", path), 403);
        for (const cookie of ["", applicant.cookie, platform.cookie, a.person.cookie]) expect(await http(cookie, "GET", path), 401);
      }
      await db("merchant_member").where({ id: manager.id }).update({ status: "INACTIVE" });
      expect(await http(manager.cookie, "GET", "/merchant/orders/" + a.orderId), 401);

      // Remove only the disposable operation. The real M10 receipt/Order stays.
      await db("order_operation").where({ medusa_order_id: a.orderId }).delete();
      const reads = await Promise.all([
        http(ownerA.cookie, "GET", "/merchant/orders/" + a.orderId),
        http(ownerA.cookie, "GET", "/merchant/orders?limit=100"),
      ]);
      assert.ok(reads[0] && reads[1]);
      const projected = z.object({ order: safeOrder }).parse(expect(reads[0]));
      const owned = list.parse(expect(reads[1]));
      assert.ok(owned.orders.some((order) => order.id === a.orderId));
      assert.equal(owned.count, owned.orders.length, "count includes only the small owned fixture set");
      const otherTenant = list.parse(expect(await http(ownerB.cookie, "GET", "/merchant/orders?limit=100")));
      assert.equal(otherTenant.count, 1);
      assert.deepEqual(otherTenant.orders.map((order) => order.id), [b.orderId]);
      assert.ok(owned.orders.every((order) => order.id !== b.orderId && order.id !== partial.id));
      assert.equal((await db("order_operation").where({ medusa_order_id: a.orderId })).length, 1);
      const later = list.parse(expect(await http(ownerA.cookie, "GET", "/merchant/orders?limit=1&offset=1")));
      assert.equal(later.count, owned.count);
      assert.ok(later.orders.every((order) => order.id !== b.orderId));
      const empty = list.parse(expect(await http(ownerA.cookie, "GET", "/merchant/orders?status=REJECTED")));
      assert.equal(empty.count, 0); assert.deepEqual(empty.orders, []);
      const response = await request("/merchant/orders/" + a.orderId, ownerA.cookie);
      assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/);
      expect(await http(ownerA.cookie, "GET", "/merchant/orders/" + encodeURIComponent("order_forbidden!")), 400);
      const nativeOrder = await native.retrieveOrder(a.orderId, { select: ["id", "total", "subtotal", "shipping_total"],
        relations: ["items", "items.tax_lines", "items.adjustments", "shipping_methods", "shipping_methods.tax_lines", "shipping_methods.adjustments"] });
      assert.equal(projected.order.totals.total_minor, checkoutMoney(nativeOrder.total));
      assert.deepEqual(projected.order.items.map((item) => [item.title, item.quantity, item.unit_price_minor]),
        nativeOrder.items?.map((item) => [item.title, Number(item.quantity), checkoutMoney(item.unit_price)]));
      const text = JSON.stringify(reads[0].body);
      for (const key of ["checkout_completion_id", "terminal_receipt", "snapshot", "payment_id", "capture_id", "operation_id",
        "transaction_id", "run_id", "billing_address", "metadata", "thumbnail", "storage_key", "customer_id"]) {
        assert.equal(text.includes('"' + key + '"'), false, "projection excludes " + key);
      }
      const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
      const linked = await query.graph({ entity: "order_operation", fields: ["id", "order.id"], filters: { medusa_order_id: a.orderId } });
      const link = z.array(z.object({ order: z.object({ id: z.string() }) })).parse(linked.data);
      assert.equal(link.length, 1); assert.equal(link[0]?.order.id, a.orderId);
      // Contradictory native identity fails closed; never project the other
      // customer's data or silently repair Medusa-owned records.
      await native.updateOrders(a.orderId, { customer_id: b.person.id });
      try {
        expect(await http(ownerA.cookie, "GET", "/merchant/orders/" + a.orderId), 409);
        // Neither the old owner nor a new native identity may bypass M10's binding.
        expect(await http(a.person.cookie, "GET", "/store/gospaza/orders/" + a.orderId), 404);
        expect(await http(b.person.cookie, "GET", "/store/gospaza/orders/" + a.orderId), 404);
      }
      finally { await native.updateOrders(a.orderId, { customer_id: a.person.id }); }
      expect(await http(ownerA.cookie, "POST", "/admin/orders/" + a.orderId + "/cancel", {}), 401);
      expect(await http(a.person.cookie, "GET", "/store/orders/" + a.orderId), 404);
      // M11-D customer projection: real native ownership, never current-cart hints.
      const customerPath = "/store/gospaza/orders/" + a.orderId;
      const customerRead = await http(a.person.cookie, "GET", customerPath);
      const customerOrder = z.object({ order: safeOrder.omit({ revision: true }) }).parse(expect(customerRead));
      assert.equal(customerOrder.order.id, a.orderId);
      assert.equal(customerOrder.order.totals.total_minor, projected.order.totals.total_minor);
      const customerForeign = await http(b.person.cookie, "GET", customerPath);
      const customerUnknown = await http(b.person.cookie, "GET", "/store/gospaza/orders/order_missing");
      expect(customerForeign, 404); expect(customerUnknown, 404);
      assert.deepEqual(customerForeign.body, customerUnknown.body);
      expect(await http(a.person.cookie, "GET", "/store/gospaza/orders/" + results[0].id), 404);
      expect(await http(a.person.cookie, "GET", "/store/gospaza/orders/" + partial.id), 404);
      for (const cookie of ["", ownerA.cookie, platform.cookie]) expect(await http(cookie, "GET", customerPath), 401);
      for (const field of ["merchant_id", "store_id", "customer_id", "status", "payment_state"]) {
        expect(await http(a.person.cookie, "GET", customerPath + "?" + field + "=forged"), 400);
      }
      const customerText = JSON.stringify(customerRead.body);
      for (const field of ["rejection_reason", "decided_by_member_id", "revision", "customer_id", "merchant_id",
        "payment_id", "snapshot", "terminal_receipt", "transaction_id", "pickup", "customer"]) {
        assert.equal(customerText.includes('"' + field + '"'), false, "customer excludes " + field);
      }
      // Read-time ensure remains bounded and customer-owned when the event is delayed.
      await db("order_operation").where({ medusa_order_id: a.orderId }).delete();
      expect(await http(b.person.cookie, "GET", customerPath), 404);
      assert.equal((await db("order_operation").where({ medusa_order_id: a.orderId })).length, 0);
      expect(await http(a.person.cookie, "GET", customerPath));
      assert.equal((await db("order_operation").where({ medusa_order_id: a.orderId })).length, 1);
      if (extension) {
        await db("merchant_member").where({ id: manager.id }).update({ status: "ACTIVE" });
        await extension({ ...orderFixture, ownerA, ownerB, manager, managerPeer, picker, applicant, platform, a, b });
      }
    } catch (error) { failures.push(error); }
    for (const cookie of cookies) {
      try { expect(await http(cookie, "DELETE", "/auth/session")); } catch (error) { failures.push(error); }
    }
    try {
      await db.transaction(async (trx) => {
        await trx("merchant").whereIn("id", [first.merchantId, second.merchantId]).orderBy("id").forUpdate().select("id");
        const decided = trx("order_operation").select("id").whereIn("merchant_id", [first.merchantId, second.merchantId])
          .whereIn("decided_by_member_id", [...members, ...restoredOwners.map((owner) => owner.memberId)]);
        await trx("order_decision_event").whereIn("order_operation_id", decided).delete();
        await trx("order_operation").whereIn("id", decided).delete();
        await trx("merchant_member").whereIn("id", members).delete();
        for (const owner of restoredOwners) {
          await trx("merchant_member").where({ id: owner.memberId }).update({ auth_identity_id: owner.identity });
          await trx("merchant_application").where({ id: owner.applicationId }).update({ applicant_identity_id: owner.identity });
        }
      });
      if (userIds.length) await users.deleteUsers(userIds);
      if (identities.length) await auth.deleteAuthIdentities(identities);
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "M11-B order operations verification failed.");
  });
  console.log("M11-B passed: authoritative provisioning, duplicate/concurrent ensures, event/read repair, native projection, tenant and role isolation. Prerequisite assertions preserved.");
}
