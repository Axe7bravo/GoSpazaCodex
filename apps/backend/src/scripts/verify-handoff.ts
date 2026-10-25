import assert from "node:assert/strict";
import type { ExecArgs, IOrderModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import verifyPickup from "./verify-pickup";
import { PickupService } from "../lib/pickup-service";
import { HandoffService } from "../lib/handoff-service";
import { NativeHandoff } from "../lib/handoff-native";
import { DeliveryTracking } from "../lib/delivery-tracking";
import { RedisDispatchLocations } from "../lib/dispatch-location";
import { dispatchPolicy } from "../modules/marketplace/dispatch-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { handoffSecret, type DeliveryCompletion } from "../modules/marketplace/handoff-policy";
import type { PickupOperation } from "../modules/marketplace/pickup-policy";

export default async function verifyHandoff(args: ExecArgs) {
  handoffSecret();
  if (process.env.HANDOFF_WORKER_ENABLED === "true") throw new Error("Disable HANDOFF_WORKER_ENABLED in backend and verifier for isolated verification.");
  await verifyPickup(args, async ({ f, assigned }) => {
    const { container, first } = f.orders.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), pickup = new PickupService(container);
    const nativeOrders = container.resolve<IOrderModuleService>(Modules.ORDER);
    const config = await f.dispatch.configuration(f.user, first.store.id);
    await f.dispatch.configure(f.user, first.store.id, { expected_revision: config.revision, mode: "PLATFORM_ONLY", reason: "M16-C isolated fixture" });
    // Only this verifier's existing catalogue fixture, restored before outer cleanup.
    const sample = await nativeOrders.retrieveOrder(f.orders.a.orderId, { relations: ["items"] });
    const products = (sample.items ?? []).flatMap(i => i.product_id ? [i.product_id] : []);
    assert.ok(products.length);
    const profiles = await db("product_marketplace_profile").where({ merchant_id: first.merchantId }).whereIn("medusa_product_id", products);
    const handoff = new HandoffService(container), tracking = new DeliveryTracking(container);
    async function trip(label: string) {
      const a = await assigned("handoff-" + label);
      const assignedState = await handoff.read(a.who.identity, a.delivery.id);
      await assert.rejects(handoff.arrive(a.who.identity, a.delivery.id, { expected_revision: assignedState.revision }));
      await pickup.prepare(a.delivery.id);
      const ready = await pickup.read(a.who.identity); assert.ok(ready.pickup);
      await pickup.pickup(a.who.identity, a.delivery.id, { expected_revision: ready.pickup.revision });
      return a;
    }
    async function occupied(id: string, count = 1) { assert.equal((await db("dispatch_commitment").where({ delivery_id: id, status: "ASSIGNED" })).length, count); }
    try {
      const restricted = await trip("restricted");
      let r = await handoff.read(restricted.who.identity, restricted.delivery.id);
      await handoff.arrive(restricted.who.identity, restricted.delivery.id, { expected_revision: r.revision });
      const restrictedCode = await handoff.customerCode(restricted.order.person.id, restricted.order.orderId); assert.ok(restrictedCode.code);
      await assert.rejects(handoff.verify(restricted.who.identity, restricted.delivery.id, { expected_revision: restrictedCode.revision, code: restrictedCode.code }),
        (e: unknown) => e instanceof Error && "code" in e && e.code === "HANDOFF_COMPLIANCE_REQUIRED");
      assert.equal((await db("delivery_operation").where({ id: restricted.delivery.id }).first()).handoff_failures, 0);
      await occupied(restricted.delivery.id);
      await db("product_marketplace_profile").where({ merchant_id: first.merchantId }).whereIn("medusa_product_id", products).update({ requires_age_verification: false });
      const a = await trip("success"), foreign = await f.driver("handoff-foreign");
      const ownLatest = z.object({ handoff: z.object({ delivery_id: z.string(), state: z.string() }) }).parse(
        await f.http(a.who.cookie, "GET", "/driver/deliveries/latest"));
      assert.equal(ownLatest.handoff.delivery_id, a.delivery.id);
      assert.equal(ownLatest.handoff.state, "IN_TRANSIT");
      assert.deepEqual(await f.http(foreign.cookie, "GET", "/driver/deliveries/latest"), { handoff: null });
      await f.http(a.who.cookie, "GET", "/driver/deliveries/latest?driver_id=" + foreign.id, undefined, 400);
      for (const cookie of ["", a.order.person.cookie, f.orders.ownerA.cookie])
        await f.http(cookie, "GET", "/driver/deliveries/latest", undefined, 401);
      assert.equal((await handoff.customerCode(a.order.person.id, a.order.orderId)).code, null);
      const before = await handoff.read(a.who.identity, a.delivery.id);
      await f.http(foreign.cookie, "POST", "/driver/deliveries/" + a.delivery.id + "/arrive", { expected_revision: before.revision }, 404);
      await f.http(restricted.order.person.cookie, "GET", "/store/gospaza/orders/" + a.order.orderId + "/handoff-code", undefined, 404);
      await f.http(restricted.order.person.cookie, "GET", "/store/gospaza/orders/" + a.order.orderId + "/tracking", undefined, 404);
      const start = await tracking.begin(a.who.identity, a.delivery.id, { expected_revision: before.revision });
      const point = z.object({ latitude: z.number(), longitude: z.number() }).parse(f.orders.fixture.location);
      await tracking.update(a.who.identity, { purpose: "DELIVERY", generation: start.generation, sequence: 1, ...point });
      const liveTracking = (await tracking.customer(a.order.person.id, a.order.orderId)).tracking;
      assert.ok(liveTracking?.expires_at);
      assert.equal(Date.parse(liveTracking.expires_at) - Date.parse(liveTracking.recorded_at), dispatchPolicy().freshnessMs);
      await assert.rejects(tracking.update(a.who.identity, { purpose: "DELIVERY", generation: start.generation, sequence: 1, ...point }));
      await assert.rejects(tracking.update(a.who.identity, { purpose: "DELIVERY", generation: "superseded", sequence: 2, ...point }));
      const samples = new RedisDispatchLocations(dispatchPolicy(), "tracking");
      const dbNow = await db.transaction(databaseTime);
      await samples.put(a.offer.id, { generation: start.generation, sequence: 2, ...point }, new Date(dbNow.getTime() - dispatchPolicy().freshnessMs - 1));
      assert.equal((await tracking.customer(a.order.person.id, a.order.orderId)).tracking, null);
      await tracking.update(a.who.identity, { purpose: "DELIVERY", generation: start.generation, sequence: 3, ...point });
      const arrival = await handoff.read(a.who.identity, a.delivery.id);
      await Promise.all([handoff.arrive(a.who.identity, a.delivery.id, { expected_revision: arrival.revision }), handoff.arrive(a.who.identity, a.delivery.id, { expected_revision: arrival.revision })]);
      assert.equal((await db("handoff_generation").where({ delivery_id: a.delivery.id })).length, 1);
      const revealed = await handoff.customerCode(a.order.person.id, a.order.orderId); assert.ok(revealed.code);
      assert.equal(revealed.can_regenerate, false);
      assert.equal(revealed.compliance_required, false);
      assert.ok(revealed.regenerate_at);
      const merchantProjection = await f.http(f.orders.ownerA.cookie, "GET", "/merchant/orders/" + a.order.orderId + "/delivery");
      for (const privateField of ["latitude", "longitude", "nonce", "code", "key_id"]) assert.equal(JSON.stringify(merchantProjection).includes('"' + privateField + '"'), false);
      const stored = await db("handoff_generation").where({ delivery_id: a.delivery.id }).first();
      assert.equal("code" in stored, false);
      assert.deepEqual(await handoff.customerCode(a.order.person.id, a.order.orderId), revealed);
      assert.deepEqual(await db("handoff_generation").where({ delivery_id: a.delivery.id }).first(), stored);
      await assert.rejects(handoff.customerCode(a.order.person.id, a.order.orderId, { expected_revision: revealed.revision }));
      for (const key of ["driver_id", "customer_id", "fulfillment_id", "delivered", "compliance_satisfied", "generation", "failed_attempts"])
        await f.http(a.who.cookie, "POST", "/driver/deliveries/" + a.delivery.id + "/handoff/verify", { expected_revision: revealed.revision, code: revealed.code, [key]: true }, 400);
      await f.http(foreign.cookie, "POST", "/driver/deliveries/" + a.delivery.id + "/handoff/verify", { expected_revision: revealed.revision, code: revealed.code }, 404);
      const input = { expected_revision: revealed.revision, code: revealed.code };
      for (const cookie of ["", a.order.person.cookie, f.orders.ownerA.cookie])
        await f.http(cookie, "POST", "/driver/deliveries/" + a.delivery.id + "/handoff/verify", input, 401);
      await assert.rejects(handoff.verify(a.who.identity, a.delivery.id, { ...input, expected_revision: revealed.revision + 1 }));
      assert.equal((await db("handoff_rate").where({ delivery_id: a.delivery.id, scope: "driver-verify" }).first()).count, 1);
      assert.equal((await db("delivery_operation").where({ id: a.delivery.id }).first()).handoff_failures, 0);
      // Missing assignment-scoped GPS does not become handoff authority.
      await new RedisDispatchLocations(dispatchPolicy(), "tracking").clear(a.offer.id, start.generation);
      assert.equal((await tracking.customer(a.order.person.id, a.order.orderId)).tracking, null);
      await Promise.all([handoff.verify(a.who.identity, a.delivery.id, input), handoff.verify(a.who.identity, a.delivery.id, input)]);
      assert.equal((await handoff.read(a.who.identity, a.delivery.id)).state, "DELIVERED");
      const completedLatest = await handoff.latest(a.who.identity);
      assert.equal(completedLatest.handoff?.delivery_id, a.delivery.id);
      assert.equal(completedLatest.handoff?.state, "DELIVERED");
      for (const key of ["code", "nonce", "latitude", "longitude", "workflow_id", "transaction_id", "fulfillment_id"])
        assert.equal(JSON.stringify(completedLatest).includes('"' + key + '"'), false);
      await handoff.verify(a.who.identity, a.delivery.id, input);
      await handoff.observe(a.delivery.id); await occupied(a.delivery.id, 0);
      assert.equal((await db("delivery_completion").where({ delivery_id: a.delivery.id })).length, 1);
      assert.equal((await db("dispatch_event").where({ target_id: a.delivery.id, action: "DELIVERED" })).length, 1);
      assert.equal((await tracking.customer(a.order.person.id, a.order.orderId)).tracking, null);
      assert.equal((await handoff.customerCode(a.order.person.id, a.order.orderId)).code, null);
      await assert.rejects(tracking.update(a.who.identity, { purpose: "DELIVERY", generation: start.generation, sequence: 4, ...point }));
      const events = await db("dispatch_event").where({ target_id: a.delivery.id });
      for (const event of events) for (const field of ["code", "nonce", "key_id", "latitude", "longitude"])
        assert.equal(JSON.stringify(event.evidence).includes('"' + field + '"'), false);

      const limits = await trip("limits");
      let offset = 0;
      const clock = async (trx: Knex.Transaction) => new Date((await databaseTime(trx)).getTime() + offset);
      const controlled = new HandoffService(container, undefined, clock);
      r = await controlled.read(limits.who.identity, limits.delivery.id);
      await controlled.arrive(limits.who.identity, limits.delivery.id, { expected_revision: r.revision });
      let old: string | null = null;
      for (let generation = 1; generation <= 3; generation++) {
        let value = await controlled.customerCode(limits.order.person.id, limits.order.orderId); assert.ok(value.code);
        if (old) assert.notEqual(value.code, old);
        const wrong = old ?? (value.code === "000000" ? "000001" : "000000"); old = value.code;
        for (let n = 0; n < 5; n++) {
          const state = await controlled.read(limits.who.identity, limits.delivery.id);
          const outcomes = await Promise.allSettled([controlled.verify(limits.who.identity, limits.delivery.id, { expected_revision: state.revision, code: wrong }),
            controlled.verify(limits.who.identity, limits.delivery.id, { expected_revision: state.revision, code: wrong })]);
          assert.ok(outcomes.every(v => v.status === "rejected"));
        }
        assert.equal((await db("delivery_operation").where({ id: limits.delivery.id }).first()).handoff_failures, generation * 5);
        await occupied(limits.delivery.id);
        if (generation < 3) {
          offset += 61000;
          value = await controlled.customerCode(limits.order.person.id, limits.order.orderId);
          assert.equal(value.can_regenerate, true);
          await controlled.customerCode(limits.order.person.id, limits.order.orderId, { expected_revision: value.revision });
        }
      }
      assert.equal((await controlled.read(limits.who.identity, limits.delivery.id)).state, "ATTENTION_REQUIRED");
      assert.equal((await db("handoff_generation").where({ delivery_id: limits.delivery.id })).length, 3);

      const expired = await trip("expiry");
      r = await handoff.read(expired.who.identity, expired.delivery.id);
      await handoff.arrive(expired.who.identity, expired.delivery.id, { expected_revision: r.revision });
      const expiryCode = await handoff.customerCode(expired.order.person.id, expired.order.orderId); assert.ok(expiryCode.code);
      assert.ok(expiryCode.expires_at); const expiresAt = expiryCode.expires_at;
      const expiryClock = async () => new Date(expiresAt);
      const atExpiry = new HandoffService(container, undefined, expiryClock);
      await assert.rejects(atExpiry.verify(expired.who.identity, expired.delivery.id, { expected_revision: expiryCode.revision, code: expiryCode.code }));
      assert.equal((await db("delivery_operation").where({ id: expired.delivery.id }).first()).handoff_failures, 0);
      // Exhaust all generations through expiry alone: no lifetime-attempt reset
      // or fourth generation is permitted even with zero incorrect guesses.
      let expiredView = await atExpiry.customerCode(expired.order.person.id, expired.order.orderId);
      assert.equal(expiredView.state, "EXPIRED");
      let lastClock = atExpiry;
      for (let generation = 2; generation <= 3; generation++) {
        const next = await lastClock.customerCode(expired.order.person.id, expired.order.orderId, { expected_revision: expiredView.revision });
        assert.ok(next.expires_at);
        const boundary = new Date(next.expires_at);
        lastClock = new HandoffService(container, undefined, async () => boundary);
        expiredView = await lastClock.customerCode(expired.order.person.id, expired.order.orderId);
      }
      assert.equal(expiredView.state, "UNAVAILABLE");
      await assert.rejects(lastClock.customerCode(expired.order.person.id, expired.order.orderId, { expected_revision: expiredView.revision }));
      assert.equal((await lastClock.read(expired.who.identity, expired.delivery.id)).state, "ATTENTION_REQUIRED");
      await occupied(expired.delivery.id);

      const beforeExpiry = await trip("before-expiry");
      r = await handoff.read(beforeExpiry.who.identity, beforeExpiry.delivery.id);
      await handoff.arrive(beforeExpiry.who.identity, beforeExpiry.delivery.id, { expected_revision: r.revision });
      const moving = await handoff.read(beforeExpiry.who.identity, beforeExpiry.delivery.id);
      const trackingGeneration = await tracking.begin(beforeExpiry.who.identity, beforeExpiry.delivery.id, { expected_revision: moving.revision });
      const liveCode = await handoff.customerCode(beforeExpiry.order.person.id, beforeExpiry.order.orderId);
      assert.ok(liveCode.code); assert.ok(liveCode.expires_at);
      const lastInstant = new Date(new Date(liveCode.expires_at).getTime() - 1);
      const beforeExpiryClock = new HandoffService(container, undefined, async () => lastInstant);
      const [completion, locationUpdate] = await Promise.allSettled([
        beforeExpiryClock.verify(beforeExpiry.who.identity, beforeExpiry.delivery.id, { expected_revision: liveCode.revision, code: liveCode.code }),
        tracking.update(beforeExpiry.who.identity, { purpose: "DELIVERY", generation: trackingGeneration.generation, sequence: 1, ...point }),
      ]);
      assert.equal(completion.status, "fulfilled");
      if (completion.status === "fulfilled") assert.equal(completion.value.state, "DELIVERED");
      // Either serialized ordering is valid; a post-completion location write
      // must fail through the domain, never reopen tracking or driver capacity.
      if (locationUpdate.status === "rejected") assert.ok(locationUpdate.reason instanceof Error);
      assert.deepEqual(await tracking.customer(beforeExpiry.order.person.id, beforeExpiry.order.orderId), { state: "DELIVERED", tracking: null });
      await occupied(beforeExpiry.delivery.id, 0);

      const lost = await trip("lost-response"); r = await handoff.read(lost.who.identity, lost.delivery.id);
      await handoff.arrive(lost.who.identity, lost.delivery.id, { expected_revision: r.revision });
      const lostCode = await handoff.customerCode(lost.order.person.id, lost.order.orderId); assert.ok(lostCode.code);
      let runs = 0;
      class LostResponse extends NativeHandoff {
        override async run(op: DeliveryCompletion, ship: PickupOperation): Promise<never> { runs++; await super.run(op,ship); throw new Error("Injected native response loss"); }
        override async terminal() { return false; }
      }
      const uncertain = new HandoffService(container, new LostResponse(container));
      const lostInput = { expected_revision: lostCode.revision, code: lostCode.code };
      assert.equal((await uncertain.verify(lost.who.identity, lost.delivery.id, lostInput)).state, "ATTENTION_REQUIRED");
      await uncertain.verify(lost.who.identity, lost.delivery.id, lostInput); await uncertain.observe(lost.delivery.id);
      assert.equal(runs, 1); await occupied(lost.delivery.id);
      assert.deepEqual(await tracking.customer(lost.order.person.id, lost.order.orderId), { state: "ATTENTION_REQUIRED", tracking: null });
      // Terminal workflow observation restored; native readback remains real.
      class TerminalEvidence extends NativeHandoff { override async terminal() { return true; } }
      const repaired = new HandoffService(container, new TerminalEvidence(container));
      await Promise.all([repaired.observe(lost.delivery.id), repaired.observe(lost.delivery.id)]);
      assert.equal((await repaired.read(lost.who.identity, lost.delivery.id)).state, "DELIVERED"); await occupied(lost.delivery.id, 0);
      assert.equal(runs, 1);

      const race = await trip("regenerate-race"); r = await handoff.read(race.who.identity, race.delivery.id);
      await handoff.arrive(race.who.identity, race.delivery.id, { expected_revision: r.revision });
      const raceCode = await handoff.customerCode(race.order.person.id, race.order.orderId); assert.ok(raceCode.code);
      const afterCooldown = new HandoffService(container, undefined, async trx => new Date((await databaseTime(trx)).getTime() + 61000));
      await Promise.allSettled([afterCooldown.verify(race.who.identity, race.delivery.id, { expected_revision: raceCode.revision, code: raceCode.code }),
        afterCooldown.customerCode(race.order.person.id, race.order.orderId, { expected_revision: raceCode.revision })]);
      const raceOps = await db("delivery_completion").where({ delivery_id: race.delivery.id });
      assert.ok(raceOps.length <= 1);
      if (raceOps.length) { assert.equal((await handoff.read(race.who.identity, race.delivery.id)).state, "DELIVERED"); await occupied(race.delivery.id, 0); }
      else {
        assert.equal((await db("handoff_generation").where({ delivery_id: race.delivery.id })).length, 2);
        await occupied(race.delivery.id);
      }

      const rollback = await trip("completion-rollback"); r = await handoff.read(rollback.who.identity, rollback.delivery.id);
      await handoff.arrive(rollback.who.identity, rollback.delivery.id, { expected_revision: r.revision });
      const rollbackCode = await handoff.customerCode(rollback.order.person.id, rollback.order.orderId); assert.ok(rollbackCode.code);
      class InvalidReceipt extends NativeHandoff {
        override async validate(ship: PickupOperation, prepareId: string) {
          return { ...await super.validate(ship, prepareId), fulfillment_id: "foreign_fixture" };
        }
      }
      await assert.rejects(new HandoffService(container, new InvalidReceipt(container)).verify(rollback.who.identity, rollback.delivery.id,
        { expected_revision: rollbackCode.revision, code: rollbackCode.code }), /Delivery completion receipt required/);
      await occupied(rollback.delivery.id);
      assert.equal((await db("dispatch_event").where({ target_id: rollback.delivery.id, action: "DELIVERED" })).length, 0);
      await handoff.observe(rollback.delivery.id); await occupied(rollback.delivery.id, 0);
      assert.equal((await db("dispatch_event").where({ target_id: rollback.delivery.id, action: "DELIVERED" })).length, 1);
    } finally {
      for (const profile of profiles) await db("product_marketplace_profile").where({ id: profile.id }).update({ requires_age_verification: profile.requires_age_verification });
    }
  });
  console.log("M16-C passed: arrival, owned tracking, bounded OTP, native completion and retained/released driver capacity.");
}
