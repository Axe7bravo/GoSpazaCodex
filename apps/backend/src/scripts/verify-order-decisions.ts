import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, IInventoryService, IOrderModuleService, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import verifyOrderOperations from "./verify-order-operations";
import { OrderOperationsService } from "../lib/order-operations-service";
import { SchedulingService } from "../lib/scheduling-service";
import type { OrderOperationRow } from "../modules/marketplace/order-operation-repository";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { databaseTime, lockSlots, occupied } from "../modules/marketplace/delivery-reservation-repository";
import type { Hold, DeliveryWindow } from "../modules/marketplace/delivery-reservation-repository";

const input = { expected_revision: 0, confirmed: true };
const decision = z.object({ decision: z.object({
  id: z.string(), operational_status: z.enum(["ACCEPTED", "REJECTED"]), revision: z.literal(1),
  accepted_at: z.string().nullable(), rejected_at: z.string().nullable(), rejection_reason: z.string().nullable(),
}) });

export default async function verifyOrderDecisions(args: ExecArgs) {
  await verifyOrderOperations(args, async (f) => {
    const { fixture, ownerA, ownerB, manager, managerPeer, picker, applicant, platform, a, b, http, expect, complete } = f;
    const { container, first, second, location } = fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const native = container.resolve<IOrderModuleService>(Modules.ORDER);
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
    const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const service = new OrderOperationsService(container);
    const scheduling = new SchedulingService(container);
    const call = (cookie: string, id: string, action: string, body: unknown = input) =>
      http(cookie, "POST", "/merchant/orders/" + id + "/" + action, body);
    const op = async (orderId: string) => {
      const row = await db<OrderOperationRow>("order_operation").where({ medusa_order_id: orderId }).first();
      assert.ok(row); return row;
    };
    const hold = async (orderId: string) => {
      const row = await db<Hold>("delivery_reservation").where({ medusa_order_id: orderId }).first();
      assert.ok(row); return row;
    };
    const audit = async (orderId: string) => db("order_decision_event").where({ order_operation_id: (await op(orderId)).id });
    async function nativeEvidence(orderId: string) {
      const handoff = await readOrderHandoff(db, orderId); assert.ok(handoff);
      const receipt = z.object({ payment_id: z.string() }).parse(handoff.terminal_receipt);
      const order = await native.retrieveOrder(orderId, { relations: ["items"] });
      const reservations = await inventory.listReservationItems({ line_item_id: (order.items ?? []).map((line) => line.id) }, { take: null });
      const payment = await payments.retrievePayment(receipt.payment_id, { relations: ["captures", "refunds"] });
      return JSON.stringify({ order, reservations: reservations.sort((x, y) => x.id.localeCompare(y.id)), payment });
    }
    async function assertTerminal(orderId: string, status: "ACCEPTED" | "REJECTED") {
      const operation = await op(orderId), reservation = await hold(orderId), events = await audit(orderId);
      assert.equal(operation.status, status);
      assert.equal(operation.revision, 1);
      assert.equal(events.length, 1);
      assert.equal(events[0].to_status, status);
      assert.equal(events[0].decided_by_member_id, operation.decided_by_member_id);
      assert.equal(events[0].merchant_id, operation.merchant_id);
      assert.equal(events[0].merchant_store_id, operation.merchant_store_id);
      assert.equal(events[0].reason, operation.rejection_reason);
      assert.equal(new Date(events[0].decided_at).getTime(), new Date(operation.accepted_at ?? operation.rejected_at ?? NaN).getTime());
      assert.equal(reservation.status, status === "ACCEPTED" ? "COMMITTED" : "RELEASED");
      if (status === "REJECTED") {
        assert.equal(reservation.release_reason, "ORDER_REJECTED");
        assert.equal(new Date(reservation.released_at ?? NaN).getTime(), new Date(operation.rejected_at ?? NaN).getTime());
      }
      assert.equal(reservation.medusa_order_id, orderId);
    }

    // Real HTTP authority/mass-assignment attacks precede any valid transition.
    const untouched = await nativeEvidence(a.orderId);
    for (const action of ["accept", "reject"]) {
      expect(await call(picker.cookie, a.orderId, action), 403);
      for (const cookie of ["", applicant.cookie, platform.cookie, a.person.cookie]) {
        expect(await call(cookie, a.orderId, action), 401);
      }
      const foreign = await call(ownerB.cookie, a.orderId, action);
      const unknown = await call(ownerB.cookie, "order_missing", action);
      expect(foreign, 404); expect(unknown, 404); assert.deepEqual(foreign.body, unknown.body);
      expect(await call(ownerA.cookie, (await op(a.orderId)).id, action), 404);
      expect(await call(ownerA.cookie, "bad!id", action), 400);
      for (const field of ["status", "merchant_id", "store_id", "merchant_store_id", "order_id",
        "decided_by", "decided_by_member_id", "accepted_at", "rejected_at", "revision", "capacity_state"]) {
        expect(await call(ownerA.cookie, a.orderId, action, { ...input, [field]: second.merchantId }), 400);
      }
      expect(await call(ownerA.cookie, a.orderId, action, { ...input, confirmed: false }), 400);
      expect(await call(ownerA.cookie, a.orderId, action, { ...input, expected_revision: 1 }), 409);
    }
    expect(await call(ownerA.cookie, a.orderId, "accept?merchant_id=" + second.merchantId), 400);
    expect(await call(ownerA.cookie, a.orderId, "accept", { ...input, reason: "forged" }), 400);
    expect(await call(ownerA.cookie, a.orderId, "reject", { ...input, reason: "x".repeat(501) }), 400);
    expect(await call(ownerA.cookie, a.orderId, "reject", { ...input, reason: { value: "object" } }), 400);
    await db("merchant_member").where({ id: manager.id }).update({ status: "INACTIVE" });
    expect(await call(manager.cookie, a.orderId, "accept"), 401);
    await db("merchant_member").where({ id: manager.id }).update({ status: "ACTIVE", deleted_at: new Date() });
    expect(await call(manager.cookie, a.orderId, "reject"), 401);
    await db("merchant_member").where({ id: manager.id }).update({ deleted_at: null });
    assert.equal(await nativeEvidence(a.orderId), untouched);
    assert.equal((await op(a.orderId)).status, "PENDING_ACCEPTANCE");

    // Simultaneous same-action HTTP calls by two real authorized employees.
    const accepted = await Promise.all([call(ownerA.cookie, a.orderId, "accept"), call(manager.cookie, a.orderId, "accept")]);
    for (const response of accepted) decision.parse(expect(response));
    assert.deepEqual(accepted[0]?.body, accepted[1]?.body);
    await assertTerminal(a.orderId, "ACCEPTED");
    const customerAccepted = z.object({ order: z.object({ operational_status: z.literal("ACCEPTED") }) })
      .parse(expect(await http(a.person.cookie, "GET", "/store/gospaza/orders/" + a.orderId)));
    assert.equal(customerAccepted.order.operational_status, "ACCEPTED");
    const originalA = await op(a.orderId);
    assert.ok([ownerA.id, manager.id].includes(originalA.decided_by_member_id ?? ""));
    const aEvents = await audit(a.orderId);
    const opposite = await call(ownerA.cookie, a.orderId, "reject");
    expect(opposite, 409);
    assert.equal(z.object({ code: z.string() }).parse(opposite.body).code, "ORDER_DECISION_CONFLICT");
    const replay = await call(manager.cookie, a.orderId, "accept");
    expect(replay); assert.deepEqual(replay.body, accepted[0]?.body);
    assert.deepEqual(await op(a.orderId), originalA);
    assert.deepEqual(await audit(a.orderId), aEvents);
    assert.equal(await nativeEvidence(a.orderId), untouched, "acceptance does not mutate native commerce");

    // Fill the existing fixture slot exactly, then prove one rejection releases
    // one place usable by a real eligible customer. No manual capacity counters.
    const reserved = await hold(b.orderId);
    const slot = await db<DeliveryWindow>("delivery_slot").where({ id: reserved.delivery_slot_id }).first(); assert.ok(slot);
    const slotData = { start_at: new Date(slot.start_at).toISOString(), end_at: new Date(slot.end_at).toISOString(),
      booking_cutoff_at: new Date(slot.booking_cutoff_at).toISOString(), enabled: slot.enabled };
    const occupancy = await db.transaction(async (trx) => {
      await lockSlots(trx, [slot.id]); return occupied(trx, slot.id, await databaseTime(trx));
    });
    assert.ok(occupancy > 0);
    const shopper = await fixture.createCustomer("m11c-capacity-" + randomUUID());
    const cart = z.object({ cart_id: z.string() }).parse(expect(await http(shopper.cookie, "POST", "/store/gospaza/cart/items",
      { variant_id: second.variantId, quantity: 1, location })));
    const readAvailability = () => http(shopper.cookie, "POST", "/store/gospaza/cart/delivery-options", { cart_id: cart.cart_id, location });
    const available = z.object({ revision: z.number(), options: z.array(z.object({ id: z.string(), mode: z.string(), revision: z.number() })) })
      .parse(expect(await readAvailability()));
    const option = available.options.find((row) => row.mode === "SCHEDULED"); assert.ok(option);
    const select = () => http(shopper.cookie, "PUT", "/store/gospaza/cart/delivery-selection", {
      cart_id: cart.cart_id, location, option_id: option.id, slot_id: slot.id,
      expected_revision: available.revision, expected_option_revision: option.revision,
    });
    const beforeB = await nativeEvidence(b.orderId);
    try {
      await scheduling.saveSlot(second.store.id, { ...slotData, capacity: occupancy }, f.prefix, "M11-C exact capacity fixture", slot.id);
      expect(await select(), 409);
      const body = { ...input, reason: "  Unable to fulfil  " };
      const rejected = await Promise.all([call(ownerB.cookie, b.orderId, "reject", body), call(ownerB.cookie, b.orderId, "reject", body)]);
      for (const response of rejected) {
        const result = decision.parse(expect(response)); assert.equal(result.decision.rejection_reason, "Unable to fulfil");
      }
      assert.deepEqual(rejected[0]?.body, rejected[1]?.body);
      await assertTerminal(b.orderId, "REJECTED");
      assert.equal((await op(b.orderId)).decided_by_member_id, ownerB.id);
      const released = await hold(b.orderId);
      assert.equal(released.selection_revision, reserved.selection_revision + 1);
      assert.equal(await db.transaction(async (trx) => occupied(trx, slot.id, await databaseTime(trx))), occupancy - 1);
      expect(await select());
      assert.equal(await db.transaction(async (trx) => occupied(trx, slot.id, await databaseTime(trx))), occupancy);
      expect(await call(ownerB.cookie, b.orderId, "reject", { ...input, reason: "Unable to fulfil" }));
      assert.deepEqual(await hold(b.orderId), released);
      assert.equal(await db.transaction(async (trx) => occupied(trx, slot.id, await databaseTime(trx))), occupancy);
      expect(await call(ownerB.cookie, b.orderId, "accept"), 409);
      expect(await call(ownerB.cookie, b.orderId, "reject", { ...input, reason: "different" }), 409);
      expect(await call(ownerB.cookie, b.orderId, "reject", { ...body, expected_revision: 1 }), 409);
      const detail = z.object({ order: z.object({ operational_status: z.literal("REJECTED") }) })
        .parse(expect(await http(ownerB.cookie, "GET", "/merchant/orders/" + b.orderId)));
      assert.equal(detail.order.operational_status, "REJECTED");
      const merchantReason = z.object({ order: z.object({ rejection_reason: z.literal("Unable to fulfil") }) })
        .parse(expect(await http(ownerB.cookie, "GET", "/merchant/orders/" + b.orderId)));
      assert.equal(merchantReason.order.rejection_reason, "Unable to fulfil");
      const customerRejected = expect(await http(b.person.cookie, "GET", "/store/gospaza/orders/" + b.orderId));
      assert.equal(z.object({ order: z.object({ operational_status: z.string() }) }).parse(customerRejected).order.operational_status, "REJECTED");
      assert.equal(JSON.stringify(customerRejected).includes("Unable to fulfil"), false);
      expect(await http(a.person.cookie, "GET", "/store/gospaza/orders/" + b.orderId), 404);
      const list = z.object({ orders: z.array(z.object({ id: z.string() })) })
        .parse(expect(await http(ownerB.cookie, "GET", "/merchant/orders?status=REJECTED")));
      assert.ok(list.orders.some((order) => order.id === b.orderId));
      assert.equal((await service.ensure(b.orderId))?.status, "REJECTED", "historical ensure never recreates/reopens a rejection");
      assert.equal(await nativeEvidence(b.orderId), beforeB, "rejection retains native inventory, Order, Payment/Capture and no refund");
    } finally {
      await scheduling.saveSlot(second.store.id, { ...slotData, capacity: slot.capacity }, f.prefix, "M11-C restore own fixture capacity", slot.id);
    }

    const c = await complete("m11c-manager-accept");
    expect(await call(manager.cookie, c.orderId, "accept"));
    await assertTerminal(c.orderId, "ACCEPTED");
    assert.equal((await op(c.orderId)).decided_by_member_id, manager.id);
    const managerDecision = await op(c.orderId);
    expect(await call(ownerA.cookie, c.orderId, "accept"));
    assert.deepEqual(await op(c.orderId), managerDecision);
    const d = await complete("m11c-manager-reject");
    expect(await call(manager.cookie, d.orderId, "reject"));
    await assertTerminal(d.orderId, "REJECTED");
    assert.equal((await op(d.orderId)).decided_by_member_id, manager.id);

    const race = await complete("m11c-opposite-race");
    const raced = await Promise.all([call(ownerA.cookie, race.orderId, "accept"), call(manager.cookie, race.orderId, "reject")]);
    assert.deepEqual(raced.map((row) => row.status).sort(), [200, 409], JSON.stringify(raced));
    const winner = await op(race.orderId);
    assert.ok(winner.status === "ACCEPTED" || winner.status === "REJECTED");
    await assertTerminal(race.orderId, winner.status);
    assert.equal(winner.decided_by_member_id, winner.status === "ACCEPTED" ? ownerA.id : manager.id);

    // Two distinct MANAGER sessions compete through the actual HTTP workflow.
    const managers = await complete("m11e-two-managers");
    const managersBefore = await nativeEvidence(managers.orderId);
    const managerRace = await Promise.all([
      call(manager.cookie, managers.orderId, "accept"),
      call(managerPeer.cookie, managers.orderId, "reject"),
    ]);
    assert.deepEqual(managerRace.map((row) => row.status).sort(), [200, 409], JSON.stringify(managerRace));
    const managerWinner = await op(managers.orderId);
    assert.ok(managerWinner.status === "ACCEPTED" || managerWinner.status === "REJECTED");
    await assertTerminal(managers.orderId, managerWinner.status);
    assert.equal(managerWinner.decided_by_member_id,
      managerWinner.status === "ACCEPTED" ? manager.id : managerPeer.id);
    assert.equal(await nativeEvidence(managers.orderId), managersBefore);

    // Actual DB wait, signaled by Knex dispatching the blocked lock query.
    // No timer or mocked lock. A stale pre-lock membership cannot authorize.
    const revoked = await complete("m11c-revocation-race");
    await service.ensure(revoked.orderId);
    await assert.rejects(() => db.transaction(async (trx) => {
      await trx("order_operation").where({ medusa_order_id: revoked.orderId }).update({
        status: "ACCEPTED", revision: 1, accepted_at: new Date(), decided_by_member_id: ownerA.id,
      });
    }), /Terminal decision requires its audit/);
    await assert.rejects(() => db("order_operation").where({ medusa_order_id: revoked.orderId }).update({
      status: "ACCEPTED", revision: 1, accepted_at: new Date(), decided_by_member_id: ownerB.id,
    }), /Active deciding member required/);
    async function permissionChangeWhileWaiting(
      update: { status?: "INACTIVE"; member_type?: "PICKER" }, expectedType: string,
    ) {
      let waiting: Promise<{ error: unknown }> | undefined;
      let outcome: { error: unknown } | undefined;
      try {
        await db.transaction(async (trx) => {
          await trx("merchant").where({ id: first.merchantId }).forUpdate().first();
          let observe: (() => void) | undefined;
          const blocked = new Promise<void>((resolve) => { observe = resolve; });
          const onQuery = (query: { sql: string; bindings?: readonly unknown[] }) => {
            if (query.sql.includes('from "merchant"') && query.sql.includes("for update")
              && query.bindings?.includes(first.merchantId)) observe?.();
          };
          db.on("query", onQuery);
          try {
            waiting = service.decide(manager.identity, revoked.orderId, "accept", input).then(
              () => ({ error: null }), (error: unknown) => ({ error }),
            );
            await Promise.race([blocked, waiting.then(() => {
              throw new Error("Decision ended before acquiring the tested lock");
            })]);
            await trx("merchant_member").where({ id: manager.id }).update(update);
          } finally { db.off("query", onQuery); }
        });
      } finally {
        if (waiting) outcome = await waiting;
      }
      assert.ok(outcome?.error instanceof MedusaError, "stale permissions cannot decide");
      assert.equal(outcome.error.type, expectedType);
      assert.equal((await op(revoked.orderId)).status, "PENDING_ACCEPTANCE");
      assert.equal((await audit(revoked.orderId)).length, 0);
    }
    await permissionChangeWhileWaiting({ status: "INACTIVE" }, MedusaError.Types.UNAUTHORIZED);
    expect(await call(manager.cookie, c.orderId, "accept"), 401);
    await db("merchant_member").where({ id: manager.id }).update({ status: "ACTIVE" });
    await permissionChangeWhileWaiting({ member_type: "PICKER" }, MedusaError.Types.FORBIDDEN);
    expect(await call(manager.cookie, revoked.orderId, "reject"), 403);
    await db("merchant_member").where({ id: manager.id }).update({ member_type: "MANAGER" });

    // Force the release write to fail after decision/audit writes. Their
    // transaction must roll back, leaving the original committed place intact.
    const fault = "m11c_release_" + randomUUID().replaceAll("-", "");
    const target = await hold(revoked.orderId);
    await db.raw(`create function ??() returns trigger language plpgsql as $$ begin
      if old.id = '${target.id.replaceAll("'", "''")}' and new.status = 'RELEASED' then raise exception 'M11 fixture release fault'; end if;
      return new; end; $$`, [fault]);
    try {
      await db.raw("create trigger ?? before update on delivery_reservation for each row execute function ??()", [fault, fault]);
      await assert.rejects(() => service.decide(ownerA.identity, revoked.orderId, "reject", input), /M11 fixture release fault/);
      assert.equal((await op(revoked.orderId)).status, "PENDING_ACCEPTANCE");
      assert.equal((await audit(revoked.orderId)).length, 0);
      assert.deepEqual(await hold(revoked.orderId), target);
    } finally {
      await db.raw("drop trigger if exists ?? on delivery_reservation", [fault]);
      await db.raw("drop function ??()", [fault]);
    }
    // Fail at commit after the release UPDATE; all three writes must roll back.
    const commitFault = "m11e_commit_" + randomUUID().replaceAll("-", "");
    await db.raw(`create function ??() returns trigger language plpgsql as $$ begin
      if old.id = '${target.id.replaceAll("'", "''")}' and new.status = 'RELEASED' then
        raise exception 'M11 fixture commit fault';
      end if;
      return null; end; $$`, [commitFault]);
    try {
      await db.raw("create constraint trigger ?? after update on delivery_reservation deferrable initially deferred for each row execute function ??()", [commitFault, commitFault]);
      await assert.rejects(() => service.decide(ownerA.identity, revoked.orderId, "reject", input), /M11 fixture commit fault/);
      assert.equal((await op(revoked.orderId)).status, "PENDING_ACCEPTANCE");
      assert.equal((await audit(revoked.orderId)).length, 0);
      assert.deepEqual(await hold(revoked.orderId), target);
    } finally {
      await db.raw("drop trigger if exists ?? on delivery_reservation", [commitFault]);
      await db.raw("drop function ??()", [commitFault]);
    }
    expect(await call(ownerA.cookie, revoked.orderId, "reject"));
    await assertTerminal(revoked.orderId, "REJECTED");

    // Database enforcement is not just a route convention.
    await assert.rejects(() => db("order_operation").where({ medusa_order_id: a.orderId }).update({ status: "REJECTED" }));
    await assert.rejects(() => db("order_operation").where({ medusa_order_id: b.orderId }).update({ status: "ACCEPTED" }));
    await assert.rejects(() => db("order_decision_event").where({ order_operation_id: originalA.id }).update({ decided_by_member_id: ownerB.id }));
    await assert.rejects(() => db("delivery_reservation").where({ medusa_order_id: a.orderId })
      .update({ status: "RELEASED", release_reason: "ORDER_REJECTED", released_at: new Date() }));
    await assert.rejects(() => db("delivery_reservation").where({ medusa_order_id: b.orderId }).update({ status: "COMMITTED" }));
    expect(await http(ownerA.cookie, "POST", "/admin/orders/" + a.orderId + "/cancel", {}), 401);
    expect(await http(a.person.cookie, "POST", "/admin/orders/" + a.orderId + "/cancel", {}), 401);
    // This deliberately absent route uses the server's HTML 404 fallback, not a JSON API.
    const absentPath = "/merchant/orders/" + a.orderId;
    const absent = await fixture.request(absentPath, ownerA.cookie, "POST", { status: "REJECTED" });
    const absentBody = await absent.text();
    assert.equal(absent.status, 404, JSON.stringify({
      method: "POST", path: absentPath, response_url: absent.url, redirected: absent.redirected,
      status: absent.status, content_type: absent.headers.get("content-type"),
      raw_body: absentBody.slice(0, 2048), body_truncated: absentBody.length > 2048,
    }));
  });
  console.log("M11-C passed: authorized terminal decisions, replay/conflicts, real races, audit, transactional capacity release/reuse and native commerce preservation.");
}
