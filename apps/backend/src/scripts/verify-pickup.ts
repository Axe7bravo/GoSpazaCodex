import assert from "node:assert/strict";
import { z } from "@medusajs/framework/zod";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IFulfillmentModuleService, IInventoryService, IOrderModuleService } from "@medusajs/framework/types";
import type { Link } from "@medusajs/framework/modules-sdk";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import verifyDispatch from "./verify-dispatch";
import type { DispatchVerificationFixture } from "./verify-dispatch";
import { PickupService } from "../lib/pickup-service";
import { NativePickup } from "../lib/pickup-native";
import type { PickupOperation } from "../modules/marketplace/pickup-policy";
import { DriverService } from "../modules/marketplace/driver-service";

const state = z.object({ pickup: z.object({ delivery_id: z.string(), revision: z.number(), state: z.string(),
  restricted_content_present: z.boolean(), picked_up_at: z.string().nullable() }).strict() }).strict();

export interface PickupVerificationFixture {
  f: DispatchVerificationFixture;
  assigned: (label: string, quantity?: number, physical?: number, merchant?: boolean) => Promise<{
    order: Awaited<ReturnType<DispatchVerificationFixture["completed"]>>;
    who: Awaited<ReturnType<DispatchVerificationFixture["driver"]>>;
    delivery: Awaited<ReturnType<DispatchVerificationFixture["dispatch"]["ensure"]>>;
    offer: Awaited<ReturnType<DispatchVerificationFixture["dispatch"]["offer"]>>;
  }>;
}
export default async function verifyPickup(args: ExecArgs, extension?: (fixture: PickupVerificationFixture) => Promise<void>) {
  await verifyDispatch(args, false, false, async f => {
    const { container, first } = f.orders.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const nativeOrders = container.resolve<IOrderModuleService>(Modules.ORDER);
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
    const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
    const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
    const service = new PickupService(container);
    const drivers = new DriverService(container), orderIds: string[] = [], failures: unknown[] = [];
    async function assigned(label: string, quantity = 1, physical = quantity, merchant = false) {
      const order = await f.completed("m16-" + label, physical === 0, quantity, physical); orderIds.push(order.orderId);
      const who = await f.driver("m16-" + label, merchant ? first.store.id : undefined); await f.online(who);
      const delivery = await f.dispatch.ensure(order.orderId); await f.dispatch.start(delivery.id);
      const offer = await f.dispatch.offer(delivery.id, who.id);
      await f.dispatch.decide(who.identity, offer.id, "ACCEPT", { expected_revision: offer.revision });
      return { order, who, delivery, offer };
    }
    async function read(cookie: string) { return state.parse(await f.http(cookie, "GET", "/driver/deliveries/current")).pickup; }
    async function nativeLinks(order: string) {
      return z.array(z.object({ order_id: z.string(), fulfillment_id: z.string() })).parse(
        (await query.graph({ entity: "order_fulfillment", fields: ["order_id","fulfillment_id"], filters: { order_id: order } })).data);
    }
    async function occupied(id: string) {
      assert.equal((await db("dispatch_commitment").where({ delivery_id: id, status: "ASSIGNED" })).length, 1);
    }
    try {
      // M15's prerequisite verifier deliberately finishes with mode DISABLED.
      // Establish this extension's fixture configuration before discovery/assignment.
      const config = await f.dispatch.configuration(f.user, first.store.id);
      await f.http(f.orders.platform.cookie, "PUT", "/admin/gospaza/stores/" + first.store.id + "/dispatch-configuration",
        { expected_revision: config.revision, mode: "PLATFORM_ONLY", reason: "M16 isolated fixture" });
      const a = await assigned("partial", 5, 3), foreign = await f.driver("m16-foreign");
      const order = await nativeOrders.retrieveOrder(a.order.orderId, { relations: ["items"] });
      const lines = (order.items ?? []).map(i => i.id);
      const reservations = await inventory.listReservationItems({ line_item_id: lines }, { take: null });
      assert.equal(reservations.length, 1); const reservation = reservations[0]; assert.ok(reservation);
      const level = await inventory.retrieveInventoryLevelByItemAndLocation(reservation.inventory_item_id, reservation.location_id);
      await Promise.all([service.prepare(a.delivery.id), service.prepare(a.delivery.id)]);
      let current = await read(a.who.cookie);
      assert.equal(current.state, "PICKUP_READY"); assert.equal(current.picked_up_at, null);
      assert.equal(current.restricted_content_present, true);
      const prepared = await db<PickupOperation>("pickup_operation").where({ delivery_id: a.delivery.id, action: "PREPARE" }).first();
      assert.ok(prepared); assert.equal(prepared.state, "SUCCEEDED");
      assert.equal(prepared.input.financial_review_required, true);
      assert.equal(prepared.input.items[0]?.quantity, 3);
      await assert.rejects(new NativePickup(container).validate({ ...prepared,
        input: { ...prepared.input, order_id: f.orders.a.orderId } }, prepared.id), "foreign Order cannot supply fulfillment evidence");
      const commitmentBefore = await db("dispatch_commitment").where({ id: a.offer.id }).first();
      assert.ok(commitmentBefore); assert.equal(commitmentBefore.driver_profile_id, a.who.id);
      assert.equal(commitmentBefore.status, "ASSIGNED");
      // This driver-only write leaves revision unchanged. M15's revision guard
      // runs before its affiliation and immutable-commitment checks.
      await assert.rejects(() => db.transaction(trx => trx("dispatch_commitment").where({ id: a.offer.id })
        .update({ driver_profile_id: foreign.id })), { code: "P0001", message: /(?:^| - )Dispatch identity\/revision$/ });
      assert.deepEqual(await db("dispatch_commitment").where({ id: a.offer.id }).first(), commitmentBefore,
        "rejected driver reassignment leaves the assigned commitment unchanged");
      const links = await nativeLinks(a.order.orderId); assert.equal(links.length, 1);
      const fulfillmentId = links[0]?.fulfillment_id; assert.ok(fulfillmentId);
      const packed = await fulfillment.retrieveFulfillment(fulfillmentId, { relations: ["items"] });
      assert.ok(packed.packed_at); assert.equal(packed.shipped_at, null);
      assert.equal(Number(packed.items[0]?.quantity), 3);
      const after = await inventory.retrieveInventoryLevelByItemAndLocation(reservation.inventory_item_id, reservation.location_id);
      assert.equal(Number(after.stocked_quantity), Number(level.stocked_quantity) - 3);
      assert.equal(Number((await inventory.retrieveReservationItem(reservation.id)).quantity), 2, "omitted quantities remain natively reserved");
      const endpoint = "/driver/deliveries/" + a.delivery.id + "/pickup", body = { expected_revision: current.revision };
      await f.http(a.who.cookie, "GET", "/driver/deliveries/current?driver_id=" + foreign.id, undefined, 400);
      for (const cookie of ["", a.order.person.cookie, f.orders.ownerA.cookie]) await f.http(cookie, "POST", endpoint, body, 401);
      await f.http(foreign.cookie, "POST", endpoint, body, 404);
      await f.http(a.who.cookie, "POST", "/driver/deliveries/del_unknown/pickup", body, 404);
      for (const key of ["driver_id","merchant_id","store_id","order_id","fulfillment_id","items","quantity","picked_up_at","status"])
        await f.http(a.who.cookie, "POST", endpoint, { ...body, [key]: "forged" }, 400);
      await f.http(a.who.cookie, "POST", endpoint, { expected_revision: current.revision - 1 }, 409);
      for (const path of ["/admin/fulfillments", "/admin/orders/" + a.order.orderId + "/fulfillments", "/admin/orders/" + a.order.orderId + "/fulfillments/" + fulfillmentId + "/shipments",
        "/admin/orders/" + a.order.orderId + "/fulfillments/" + fulfillmentId + "/mark-as-delivered",
        "/admin/fulfillments/" + fulfillmentId + "/shipment", "/admin/fulfillments/" + fulfillmentId + "/cancel"])
        await f.http(f.orders.platform.cookie, "POST", path, {}, 404);
      await Promise.all([f.http(a.who.cookie, "POST", endpoint, body), f.http(a.who.cookie, "POST", endpoint, body)]);
      current = await read(a.who.cookie); assert.equal(current.state, "IN_TRANSIT"); assert.ok(current.picked_up_at);
      const replay = state.parse(await f.http(a.who.cookie, "POST", endpoint, body)).pickup;
      assert.equal(replay.picked_up_at, current.picked_up_at);
      assert.equal((await db("pickup_operation").where({ delivery_id: a.delivery.id, action: "SHIP" })).length, 1);
      assert.equal((await db("dispatch_event").where({ target_id: a.delivery.id, action: "PICKED_UP" })).length, 1);
      assert.equal((await nativeLinks(a.order.orderId)).length, 1);
      assert.ok((await fulfillment.retrieveFulfillment(fulfillmentId)).shipped_at);
      assert.equal(Number((await inventory.retrieveInventoryLevelByItemAndLocation(reservation.inventory_item_id, reservation.location_id)).stocked_quantity), Number(after.stocked_quantity));
      assert.equal(Number((await inventory.retrieveReservationItem(reservation.id)).quantity), 2);
      await occupied(a.delivery.id);
      const available = z.object({ revision: z.number() }).parse(await f.http(a.who.cookie, "GET", "/driver/availability"));
      await f.http(a.who.cookie, "POST", "/driver/availability/offline", { expected_revision: available.revision });
      assert.equal((await read(a.who.cookie)).state, "IN_TRANSIT"); await occupied(a.delivery.id);

      const omitted = await assigned("all-omitted", 2, 0);
      await service.prepare(omitted.delivery.id);
      assert.equal((await read(omitted.who.cookie)).state, "ATTENTION_REQUIRED");
      assert.equal((await db("delivery_operation").where({ id: omitted.delivery.id }).first()).reason, "NO_PHYSICAL_ITEMS_TO_DELIVER");
      assert.equal((await nativeLinks(omitted.order.orderId)).length, 0);
      assert.equal((await db("pickup_operation").where({ delivery_id: omitted.delivery.id })).length, 0); await occupied(omitted.delivery.id);

      // Real native completion, failed readback, then a new service instance:
      // persisted native 'done' plus authoritative readback recovers, never replay.
      const recoverable = await assigned("readback-loss");
      let runs = 0;
      class ReadbackLoss extends NativePickup {
        override async run(op: PickupOperation) { runs++; return super.run(op); }
        override async validate(): Promise<never> { throw new Error("Injected readback outage"); }
      }
      await new PickupService(container, new ReadbackLoss(container)).prepare(recoverable.delivery.id);
      assert.equal(runs, 1);
      assert.equal((await db("pickup_operation").where({ delivery_id: recoverable.delivery.id }).first()).state, "RECOVERY_REQUIRED");
      await new PickupService(container).prepare(recoverable.delivery.id);
      assert.equal((await read(recoverable.who.cookie)).state, "PICKUP_READY");
      assert.equal((await nativeLinks(recoverable.order.orderId)).length, 1);
      class ShipmentReadbackLoss extends NativePickup {
        override async validate(op: PickupOperation, prepareId: string) {
          if (op.action === "SHIP") throw new Error("Injected shipment readback outage");
          return super.validate(op, prepareId);
        }
      }
      const readyToShip = await read(recoverable.who.cookie);
      const delayed = await new PickupService(container, new ShipmentReadbackLoss(container)).pickup(recoverable.who.identity,
        recoverable.delivery.id, { expected_revision: readyToShip.revision });
      assert.equal(delayed.pickup?.state, "ATTENTION_REQUIRED"); assert.equal(delayed.pickup?.picked_up_at, null);
      assert.equal((await new PickupService(container).read(recoverable.who.identity)).pickup?.state, "IN_TRANSIT");
      assert.equal((await db("pickup_operation").where({ delivery_id: recoverable.delivery.id, action: "SHIP" })).length, 1);
      assert.equal((await db("dispatch_event").where({ target_id: recoverable.delivery.id, action: "PICKED_UP" })).length, 1);

      const ambiguous = await assigned("ambiguous-shipment"); await service.prepare(ambiguous.delivery.id);
      const beforeUnknown = await read(ambiguous.who.cookie); let shipments = 0;
      class LostShipmentResponse extends NativePickup {
        override async run(op: PickupOperation): Promise<never> { shipments++; await super.run(op); throw new Error("Injected lost native response"); }
        override async observe() { return null; }
      }
      const uncertain = new PickupService(container, new LostShipmentResponse(container));
      const unknownBody = { expected_revision: beforeUnknown.revision };
      const unknown = await uncertain.pickup(ambiguous.who.identity, ambiguous.delivery.id, unknownBody);
      assert.equal(unknown.pickup?.state, "ATTENTION_REQUIRED"); assert.equal(unknown.pickup?.picked_up_at, null);
      await uncertain.pickup(ambiguous.who.identity, ambiguous.delivery.id, unknownBody);
      await uncertain.prepare(ambiguous.delivery.id); assert.equal(shipments, 1); await occupied(ambiguous.delivery.id);
      assert.ok((await db<PickupOperation>("pickup_operation").where({ delivery_id: ambiguous.delivery.id, action: "SHIP" }).first())?.transaction_id);
      assert.equal((await db("dispatch_event").where({ target_id: ambiguous.delivery.id, action: "PICKED_UP" })).length, 0);

      const suspended = await assigned("suspended"); await service.prepare(suspended.delivery.id);
      const beforeSuspension = await read(suspended.who.cookie);
      const eligibility = await drivers.eligibility(suspended.who.id, first.store.id);
      await drivers.mutate({ type: "user", id: f.user }, "SUSPEND", { expected_revision: eligibility.profile_revision, confirmed: true, reason: "M16 isolated verification" }, suspended.who.id);
      await f.http(suspended.who.cookie, "POST", "/driver/deliveries/" + suspended.delivery.id + "/pickup", { expected_revision: beforeSuspension.revision }, 409);
      assert.equal((await db("pickup_operation").where({ delivery_id: suspended.delivery.id, action: "SHIP" })).length, 0); await occupied(suspended.delivery.id);
      assert.equal((await read(suspended.who.cookie)).state, "ATTENTION_REQUIRED");

      const beforePrepare = await assigned("suspended-before-prepare");
      const initialEligibility = await drivers.eligibility(beforePrepare.who.id, first.store.id);
      await drivers.mutate({ type: "user", id: f.user }, "SUSPEND", { expected_revision: initialEligibility.profile_revision,
        confirmed: true, reason: "M16 preparation gate" }, beforePrepare.who.id);
      await service.prepare(beforePrepare.delivery.id);
      assert.equal((await nativeLinks(beforePrepare.order.orderId)).length, 0);
      assert.equal((await db("pickup_operation").where({ delivery_id: beforePrepare.delivery.id })).length, 0);
      await occupied(beforePrepare.delivery.id);

      const during = await assigned("invalidation-during-shipment"); await service.prepare(during.delivery.id);
      const beforeRace = await read(during.who.cookie);
      class InvalidateAfterNative extends NativePickup {
        override async run(op: PickupOperation) {
          const result = await super.run(op);
          const e = await drivers.eligibility(during.who.id, first.store.id);
          await drivers.mutate({ type: "user", id: f.user }, "SUSPEND", { expected_revision: e.profile_revision,
            confirmed: true, reason: "M16 native-response boundary race" }, during.who.id);
          return result;
        }
      }
      const invalidated = await new PickupService(container, new InvalidateAfterNative(container)).pickup(during.who.identity,
        during.delivery.id, { expected_revision: beforeRace.revision });
      assert.equal(invalidated.pickup?.state, "ATTENTION_REQUIRED"); assert.equal(invalidated.pickup?.picked_up_at, null);
      assert.equal((await db("dispatch_event").where({ target_id: during.delivery.id, action: "PICKED_UP" })).length, 0);
      await occupied(during.delivery.id);

      // A lost preparation response is also never permission to create another
      // native fulfillment, even when workflow history cannot be retrieved.
      const lost = await assigned("lost-preparation"); let preparations = 0;
      class LostPreparation extends NativePickup {
        override async run(op: PickupOperation): Promise<never> { preparations++; await super.run(op); throw new Error("Injected preparation response loss"); }
        override async observe() { return null; }
      }
      const lostService = new PickupService(container, new LostPreparation(container));
      await lostService.prepare(lost.delivery.id); await lostService.prepare(lost.delivery.id);
      assert.equal(preparations, 1); assert.equal((await nativeLinks(lost.order.orderId)).length, 1);
      const lostState = (await lostService.read(lost.who.identity)).pickup; assert.ok(lostState);
      await assert.rejects(lostService.pickup(lost.who.identity, lost.delivery.id, { expected_revision: lostState.revision }));
      assert.equal(lostState.state, "ATTENTION_REQUIRED"); await occupied(lost.delivery.id);

      // Merchant affiliation is re-read, not leased from offer acceptance.
      const prior = await f.dispatch.configuration(f.user, first.store.id);
      await f.http(f.orders.platform.cookie, "PUT", "/admin/gospaza/stores/" + first.store.id + "/dispatch-configuration",
        { expected_revision: prior.revision, mode: "MERCHANT_ONLY", reason: "M16 merchant affiliation fixture" });
      const revoked = await assigned("revoked", 1, 1, true); await service.prepare(revoked.delivery.id);
      const preRevoke = await read(revoked.who.cookie), e = await drivers.eligibility(revoked.who.id, first.store.id);
      assert.ok(e.affiliation_id);
      await drivers.mutate({ type: "merchant", identity: f.orders.ownerA.identity }, "REVOKE",
        { expected_revision: e.profile_revision, confirmed: true, reason: "M16 affiliation gate" }, undefined, e.affiliation_id);
      await f.http(revoked.who.cookie, "POST", "/driver/deliveries/" + revoked.delivery.id + "/pickup", { expected_revision: preRevoke.revision }, 409);
      await occupied(revoked.delivery.id);
      assert.equal((await db("pickup_operation").where({ delivery_id: revoked.delivery.id, action: "SHIP" })).length, 0);
      if (extension) await extension({ f, assigned });
    } catch (error) { failures.push(error); }
    // Only this callback's isolated native fixtures. Public native APIs, never
    // SQL against Medusa tables. Undo shipped_at only for teardown so the pinned
    // cancel-before-delete API can remove the synthetic fulfillment and children.
    for (const orderId of orderIds) {
      try {
        for (const link of await nativeLinks(orderId)) {
          const value = await fulfillment.retrieveFulfillment(link.fulfillment_id);
          const marker = z.object({ gospaza_pickup_operation: z.string() }).parse(value.metadata);
          const op = await db<PickupOperation>("pickup_operation").where({ id: marker.gospaza_pickup_operation, action: "PREPARE" }).first();
          assert.equal(op?.input.order_id, orderId);
          if (value.shipped_at || value.delivered_at) await fulfillment.updateFulfillment(value.id, { shipped_at: null, delivered_at: null });
          await fulfillment.cancelFulfillment(value.id);
          await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({ [Modules.ORDER]: { order_id: orderId }, [Modules.FULFILLMENT]: { fulfillment_id: value.id } });
          await fulfillment.deleteFulfillment(value.id);
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "M16-B pickup verification failed.");
  });
  console.log("M16-B passed: native physical quantities, concurrent pickup, actor isolation, recovery, inventory and occupied assignment.");
}
