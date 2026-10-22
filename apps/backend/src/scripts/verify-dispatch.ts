import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Redis from "ioredis";
import { z } from "@medusajs/framework/zod";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IAuthModuleService, IInventoryService, IOrderModuleService, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import verifyOrderOperations from "./verify-order-operations";
import { cleanupShortages } from "./shortage-verification-cleanup";
import { DriverService } from "../modules/marketplace/driver-service";
import { PickingService } from "../lib/picking-service";
import { OrderOperationsService } from "../lib/order-operations-service";
import { SchedulingService } from "../lib/scheduling-service";
import { DispatchService } from "../lib/dispatch-service";
import { DispatchOrchestrator } from "../lib/dispatch-orchestrator";
import { dispatchSample } from "../lib/dispatch-location";

import { dispatchPolicy } from "../modules/marketplace/dispatch-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import type { CommitmentRow } from "../modules/marketplace/dispatch-rows";


const availability = z.object({ revision: z.number(), generation: z.string().nullable(), intent: z.string(), effective: z.string(), location_fresh: z.boolean() });
const decision = { expected_revision: 1 };
export default async function verifyDispatch(args: ExecArgs, orchestration = false, acceptance = false) {
  if (process.env.DISPATCH_WORKER_ENABLED === "true") throw new Error("Stop the automatic dispatch worker for isolated dispatch verification.");
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("M15-B verification requires REDIS_URL and the normal local dispatch policy.");
  await verifyOrderOperations(args, async f => {
    const { container, first, second } = f.fixture;
    const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
    const native = container.resolve<IOrderModuleService>(Modules.ORDER);
    const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
    const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const drivers = new DriverService(container), picking = new PickingService(container);
    const operations = new OrderOperationsService(container), scheduling = new SchedulingService(container);
    const dispatch = new DispatchService(container);
    const user = z.string().parse((await auth.retrieveAuthIdentity(f.platform.identity)).app_metadata?.user_id);
    const identities: string[] = [], profiles: string[] = [], cookies: string[] = [], orderIds: string[] = [];
    const prefix = "m15b-" + randomUUID(), failures: unknown[] = [];
    const http = async (cookie: string, method: string, path: string, body?: unknown, status = 200) =>
      f.expect(await f.http(cookie, method, path, body), status);
    const own = async (cookie: string) => availability.parse(await http(cookie, "GET", "/driver/availability"));
    const configPath = "/admin/gospaza/stores/" + first.store.id + "/dispatch-configuration";
    const point = z.object({ latitude: z.number(), longitude: z.number() }).parse(f.fixture.location);
    async function driver(label: string, store?: string) {
      const email = prefix + label + "@example.test", password = randomBytes(24).toString("hex");
      const registered = await auth.register("emailpass", { body: { email, password } });
      assert.ok(registered.authIdentity); const identity = registered.authIdentity.id; identities.push(identity);
      const login = z.object({ token: z.string() }).parse(await http("", "POST", "/auth/driver/emailpass", { email, password }));
      const response = await fetch(new URL("/auth/session", process.env.BACKEND_URL), { method: "POST", headers: { Authorization: "Bearer " + login.token }, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(v => v.split(";")[0]).join("; "); cookies.push(cookie);
      let a = await drivers.bootstrap(identity); profiles.push(a.profile.id);
      a = await drivers.mutate({ type: "driver", identity }, "EDIT", { expected_revision: a.profile.revision, display_name: "Fixture driver", contact_phone: "+27821234567" });
      a = await drivers.mutate({ type: "driver", identity }, "REQUEST", { expected_revision: a.profile.revision,
        kind: store ? "MERCHANT" : "PLATFORM", ...(store ? { merchant_store_id: store } : {}) });
      if (store) {
        assert.ok(a.affiliation);
        a = await drivers.mutate({ type: "merchant", identity: store === first.store.id ? f.ownerA.identity : f.ownerB.identity }, "ENDORSE",
          { expected_revision: a.profile.revision, confirmed: true, reason: "Fixture approval" }, undefined, a.affiliation.id);
      }
      a = await drivers.mutate({ type: "driver", identity }, "SUBMIT", { expected_revision: a.profile.revision });
      await drivers.mutate({ type: "user", id: user }, "APPROVE",
        { expected_revision: a.profile.revision, confirmed: true, reason: "Fixture approval" }, a.profile.id);
      return { identity, cookie, id: a.profile.id };
    }
    async function online(who: { cookie: string }, location = point) {
      const before = await own(who.cookie);
      const a = availability.parse(await http(who.cookie, "POST", "/driver/availability/online", { expected_revision: before.revision }));
      assert.ok(a.generation);
      await http(who.cookie, "PUT", "/driver/location", { ...location, generation: a.generation, sequence: 1 });
      return a.generation;
    }
    async function completed(label: string, omitted = false) {
      const order = await f.complete(prefix + label); orderIds.push(order.orderId);
      await operations.ensure(order.orderId);
      await operations.decide(f.ownerA.identity, order.orderId, "accept", { expected_revision: 0, confirmed: true });
      if (omitted) await picking.customerShortages(order.person.id, order.orderId, "PREFERENCE", { preference: "NO_SUBSTITUTION", expected_revision: 0 });
      let state = (await picking.mutate(f.picker.identity, order.orderId, "CLAIM", {})).picking;
      for (const line of state.lines) {
        state = (await picking.mutate(f.picker.identity, order.orderId, "LINE", { expected_revision: state.revision,
          picked_quantity: omitted ? 0 : line.ordered_quantity, shortage_recorded: omitted }, line.id)).picking;
      }
      await picking.mutate(f.picker.identity, order.orderId, "COMPLETE", { expected_revision: state.revision, confirmed: true });
      return order;
    }
    async function evidence(ids: string[]) {
      const orders = await Promise.all(ids.map(id => native.retrieveOrder(id, { relations: ["items","shipping_methods"] })));
      const reservations = await inventory.listReservationItems({ line_item_id: orders.flatMap(o => (o.items ?? []).map(i => i.id)) }, { take: null });
      const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
      const fulfillments = await query.graph({ entity: "order_fulfillment", fields: ["order_id","fulfillment_id"], filters: { order_id: ids } });
      const linked = await query.graph({ entity: "order_payment_collection", fields: ["payment_collection_id"], filters: { order_id: ids } });
      const collections = z.array(z.object({ payment_collection_id: z.string() })).parse(linked.data);
      const financial = [];
      for (const link of collections.sort((a,b) => a.payment_collection_id.localeCompare(b.payment_collection_id))) financial.push(
        await payments.retrievePaymentCollection(link.payment_collection_id, { relations: ["payments", "payments.captures", "payments.refunds"] }));
      return JSON.stringify({ orders, financial, reservations: reservations.sort((a,b) => a.id.localeCompare(b.id)), fulfillments: fulfillments.data });
    }
    try {
      await assert.rejects(() => dispatch.ensure(f.a.orderId)); // pending acceptance is not dispatchable
      // Move no committed slot. Create new future fixtures through the scheduling owner.
      const previousDeliveryConfiguration = await scheduling.configuration(first.store.id);
      await scheduling.savePolicy(first.store.id, { enabled: true, asap_enabled: true, scheduled_enabled: true, minimum_lead_minutes: 0 }, user, "M15 fixture");
      const invalidated = await scheduling.configuration(first.store.id);
      assert.ok(invalidated.options.length);
      for (const option of invalidated.options) {
        const previous = previousDeliveryConfiguration.options.find(row => row.id === option.id);
        assert.ok(previous);
        assert.equal(option.revision, previous.revision + 1, "M9 policy change invalidates each native option revision");
        assert.equal(option.synced_revision, previous.synced_revision);
        assert.equal(option.sync_state, "PENDING");
      }
      // M9 policy updates deliberately invalidate native shipping options.
      // Complete explicit fixture provisioning before discovery/selection; never
      // retry a checkout or suppress DELIVERY_CONFIGURATION_STALE.
      const synchronized = await scheduling.synchronize(first.store.id, user, "M15 fixture policy synchronization");
      for (const option of synchronized.options) {
        assert.equal(option.sync_state, "READY");
        assert.equal(option.synced_revision, option.revision);
      }
      const now = await db.transaction(databaseTime);
      await scheduling.saveSlot(first.store.id, { start_at: new Date(now.getTime() + 15 * 60000).toISOString(),
        end_at: new Date(now.getTime() + 45 * 60000).toISOString(), booking_cutoff_at: new Date(now.getTime() + 10 * 60000).toISOString(),
        capacity: 30, enabled: true }, user, "M15 fixture");
      // Only these synthetic inventory resources; baseline begins after fixture creation.
      const sampleOrder = await native.retrieveOrder(f.a.orderId, { relations: ["items"] });
      for (const r of await inventory.listReservationItems({ line_item_id: (sampleOrder.items ?? []).map(i => i.id) }, { take: null })) {
        await inventory.updateInventoryLevels({ inventory_item_id: r.inventory_item_id, location_id: r.location_id, stocked_quantity: 100 });
      }
      const one = await completed("one", true), two = await completed("two"), three = await completed("three"), four = await completed("four");
      // Restricted presence is server-derived; it does not manufacture M17 compliance.
      const productId = sampleOrder.items?.[0]?.product_id; assert.ok(productId);
      await db("product_marketplace_profile").where({ medusa_product_id: productId, merchant_id: first.merchantId }).update({ requires_age_verification: true });
      const d1s = await Promise.all([dispatch.ensure(one.orderId), dispatch.ensure(one.orderId)]);
      assert.equal(d1s[0]?.id, d1s[1]?.id); const d1 = d1s[0]; assert.ok(d1);
      const d2 = await dispatch.ensure(two.orderId), d3 = await dispatch.ensure(three.orderId), d4 = await dispatch.ensure(four.orderId);
      assert.equal((await db("delivery_operation").where({ medusa_order_id: one.orderId })).length, 1);
      const shortageRows = await db<{ financial_review_required: boolean }>("shortage_resolution").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: one.orderId }));
      assert.ok(shortageRows.length && shortageRows.every(r => r.financial_review_required));
      assert.equal(d1.restricted_content_present, true);
      // The earlier M10 fixture uses tomorrow's immutable scheduled slot.
      orderIds.push(f.a.orderId);
      await operations.decide(f.ownerA.identity, f.a.orderId, "accept", { expected_revision: 0, confirmed: true });
      let futurePick = (await picking.mutate(f.picker.identity, f.a.orderId, "CLAIM", {})).picking;
      for (const line of futurePick.lines) futurePick = (await picking.mutate(f.picker.identity, f.a.orderId, "LINE", {
        expected_revision: futurePick.revision, picked_quantity: line.ordered_quantity, shortage_recorded: false }, line.id)).picking;
      await picking.mutate(f.picker.identity, f.a.orderId, "COMPLETE", { expected_revision: futurePick.revision, confirmed: true });
      const futureDelivery = await dispatch.ensure(f.a.orderId);
      const baselineIds = [...orderIds], baseline = await evidence(baselineIds);
      await assert.rejects(() => dispatch.start(d1.id)); // DISABLED/unconfigured
      for (const cookie of ["", f.ownerA.cookie, f.picker.cookie, one.person.cookie]) await http(cookie, "PUT", configPath,
        { expected_revision: 0, mode: "HYBRID", reason: "hostile" }, 401);
      await http(f.platform.cookie, "PUT", configPath, { expected_revision: 0, mode: "HYBRID", reason: "fixture", merchant_id: "forged" }, 400);
      const beforeDispatchConfiguration = await scheduling.configuration(first.store.id);
      await http(f.platform.cookie, "PUT", configPath, { expected_revision: 0, mode: "HYBRID", reason: "M15 fixture" });
      assert.deepEqual(await scheduling.configuration(first.store.id), beforeDispatchConfiguration,
        "dispatch mode configuration must not invalidate M9 delivery configuration");
      await assert.rejects(() => dispatch.start(futureDelivery.id));
      const p = await driver("platform"), m = await driver("merchant", first.store.id), foreign = await driver("foreign", second.store.id);
      const assignedDriver = await driver("assigned", first.store.id);
      await online(p); await online(m, { latitude: 0, longitude: 0 }); await online(foreign);
      await dispatch.start(d1.id); await dispatch.start(d2.id);
      assert.equal(await dispatch.candidate(d1.id, m.id), true, "merchant uses exact affiliation even outside polygon");
      assert.equal(await dispatch.candidate(d1.id, p.id), false);
      assert.equal(await dispatch.candidate(d1.id, foreign.id), false);
      const page = await dispatch.candidatePage(d1.id);
      assert.ok(page.candidates.includes(m.id) && !page.candidates.includes(foreign.id));
      // Actual concurrent PostgreSQL calls, not Promise.all over a shared pg client.
      const races = await Promise.allSettled([dispatch.offer(d1.id, m.id), dispatch.offer(d2.id, m.id)]);
      assert.equal(races.filter(r => r.status === "fulfilled").length, 1);
      const offered = races.find((r): r is PromiseFulfilledResult<CommitmentRow> => r.status === "fulfilled"); assert.ok(offered);
      const offer = offered.value, winner = offer.delivery_id === d1.id ? d1 : d2, loser = winner.id === d1.id ? d2 : d1;
      const acceptedPath = "/driver/offers/" + offer.id + "/accept";
      await http(p.cookie, "POST", acceptedPath, decision, 404);
      await http(m.cookie, "POST", acceptedPath, { ...decision, driver_id: p.id }, 400);
      const decisionRace = await Promise.all([f.http(m.cookie, "POST", acceptedPath, decision), f.http(m.cookie, "POST", "/driver/offers/" + offer.id + "/decline", decision)]);
      assert.deepEqual(decisionRace.map(r => r.status).sort(), [200,409]);
      const won = await db<CommitmentRow>("dispatch_commitment").where({ id: offer.id }).first(); assert.ok(won);
      const replayAction = won.status === "ASSIGNED" ? "accept" : "decline";
      await http(m.cookie, "POST", "/driver/offers/" + offer.id + "/" + replayAction, decision);
      assert.equal((await dispatch.offer(winner.id, m.id)).id, offer.id, "no second offer to historical candidate");
      // New independent merchant driver lets the assignment invariants run regardless of race winner.
      await online(assignedDriver);
      const commitment = await dispatch.offer(loser.id, assignedDriver.id);
      await http(assignedDriver.cookie, "POST", "/driver/offers/" + commitment.id + "/accept", decision);
      assert.equal((await own(assignedDriver.cookie)).effective, "BUSY");
      const a = await own(assignedDriver.cookie);
      await http(assignedDriver.cookie, "POST", "/driver/availability/offline", { expected_revision: a.revision });
      assert.equal((await own(assignedDriver.cookie)).effective, "BUSY");
      const redis = new Redis(redisUrl);
      try {
        await redis.del("gospaza:dispatch:{" + assignedDriver.id + "}:sample");
        const lost = new DispatchService(container, dispatchPolicy(), { begin: async () => { throw new Error("unavailable"); },
          put: async () => { throw new Error("unavailable"); }, get: async () => null });
        assert.equal((await lost.readAvailability(assignedDriver.identity)).effective, "BUSY");
        assert.equal((await lost.current(assignedDriver.identity)).commitment?.id, commitment.id);
        await dispatch.start(d3.id);
        await assert.rejects(() => db.transaction(trx => trx("dispatch_commitment").insert({
          id: "dcommit_" + randomUUID(), delivery_id: d3.id, driver_profile_id: assignedDriver.id, generation: 1, path: "MERCHANT",
          status: "OFFERED", availability_generation: commitment.availability_generation, affiliation_id: commitment.affiliation_id,
          affiliation_revision: commitment.affiliation_revision, profile_revision: commitment.profile_revision, expires_at: commitment.expires_at,
        })), /dispatch_one_driver_commitment/);
        // Platform outside the zone is not a candidate; merchant-first fallback is one way.
        await dispatch.advance(d3.id, true);
        await online(p, { latitude: 0, longitude: 0 });
        assert.equal(await dispatch.candidate(d3.id, p.id), false);
        const generation = await online(p);
        await http(p.cookie, "PUT", "/driver/location", { ...point, generation, sequence: 1 }, 409);
        await http(p.cookie, "PUT", "/driver/location", { ...point, generation, sequence: 2, latitude: 100 }, 400);
        await http(p.cookie, "PUT", "/driver/location", { ...point, generation, sequence: 2, driver_id: m.id }, 400);
        assert.equal(await dispatch.candidate(d3.id, p.id), true);
        const sampleKey = "gospaza:dispatch:{" + p.id + "}:sample", fenceKey = "gospaza:dispatch:{" + p.id + "}:fence";
        const raw = await redis.get(sampleKey); assert.ok(raw);
        const sample = dispatchSample.parse(JSON.parse(raw));
        await redis.set(sampleKey, JSON.stringify({ ...sample, received_at: (await db.transaction(databaseTime)).getTime() - dispatch.policy.freshnessMs - 1 }));
        assert.equal(await dispatch.candidate(d3.id, p.id), false);
        await redis.del(sampleKey, fenceKey); // only this synthetic profile, simulates loss without FLUSHDB
        await http(p.cookie, "PUT", "/driver/location", { ...point, generation, sequence: 3 }, 409);
        const newGeneration = await online(p);
        assert.notEqual(newGeneration, generation);
        await http(p.cookie, "PUT", "/driver/location", { ...point, generation, sequence: 2147483647 }, 409);
        assert.equal(await dispatch.candidate(d3.id, p.id), true);
      } finally { redis.disconnect(); }
      // M14 revalidation after discovery, including revocation between offer and accept.
      const revoked = await driver("revoked", first.store.id); await online(revoked);
      await dispatch.start(d4.id);
      assert.equal(await dispatch.candidate(d4.id, revoked.id), true);
      const revokeOffer = await dispatch.offer(d4.id, revoked.id);
      const account = await drivers.own(revoked.identity); assert.ok(account.affiliation);
      await drivers.mutate({ type: "merchant", identity: f.ownerA.identity }, "REVOKE",
        { expected_revision: account.profile.revision, confirmed: true, reason: "Fixture revocation" }, undefined, account.affiliation.id);
      await http(revoked.cookie, "POST", "/driver/offers/" + revokeOffer.id + "/accept", decision, 409);
      assert.equal((await db<CommitmentRow>("dispatch_commitment").where({ id: revokeOffer.id }).first())?.status, "CANCELLED");
      const pOffer = await dispatch.offer(d3.id, p.id);
      const withoutLocation = new DispatchService(container, dispatchPolicy(), {
        begin: async () => { throw new Error("unavailable"); },
        put: async () => { throw new Error("unavailable"); },
        get: async () => null,
      });
      await assert.rejects(() => withoutLocation.decide(p.identity, pOffer.id, "ACCEPT", decision));
      assert.equal((await db<CommitmentRow>("dispatch_commitment").where({ id: pOffer.id }).first())?.status, "OFFERED",
        "location loss rejects acceptance without erasing occupied offer capacity");
      const duplicateOffers = await Promise.all([dispatch.offer(d3.id, p.id), dispatch.offer(d3.id, p.id)]);
      assert.ok(duplicateOffers.every(c => c.id === pOffer.id));
      // Offline-vs-accept is serialized; whichever wins, no orphan or second assignment.
      const before = await own(p.cookie);
      const offlineRace = await Promise.all([f.http(p.cookie, "POST", "/driver/availability/offline", { expected_revision: before.revision }),
        f.http(p.cookie, "POST", "/driver/offers/" + pOffer.id + "/accept", decision)]);
      assert.equal(offlineRace[0]?.status, 200);
      assert.ok([200,409].includes(offlineRace[1]?.status ?? 0));
      const pc = await db<CommitmentRow>("dispatch_commitment").where({ id: pOffer.id }).first(); assert.ok(pc);
      assert.ok(["ASSIGNED","CANCELLED"].includes(pc.status));
      assert.equal((await db("dispatch_commitment").where({ driver_profile_id: p.id }).whereIn("status", ["OFFERED","ASSIGNED"])).length, pc.status === "ASSIGNED" ? 1 : 0);
      assert.equal((await dispatch.advance(d4.id, true)).path, "PLATFORM");
      assert.equal((await dispatch.advance(d4.id, true)).status, "ATTENTION_REQUIRED");
      assert.equal((await dispatch.start(d4.id)).status, "ATTENTION_REQUIRED");
      assert.equal(await evidence(baselineIds), baseline, "dispatch never mutates native commerce/fulfillment");
      assert.ok((await db<{ financial_review_required: boolean }>("shortage_resolution").whereIn("order_operation_id",
        db("order_operation").select("id").where({ medusa_order_id: one.orderId }))).every(r => r.financial_review_required));
      // Explicit exclusive modes never use the other pool, and expired offer
      // fixtures exercise the HTTP expiry branch without sleeps or clock races.
      await http(f.platform.cookie, "PUT", configPath, { expected_revision: 1, mode: "MERCHANT_ONLY", reason: "M15 mode fixture" });
      const five = await completed("exclusive"); const d5 = await dispatch.ensure(five.orderId);
      const rivalA = await driver("rival-a", first.store.id), rivalB = await driver("rival-b", first.store.id);
      await online(rivalA); await online(rivalB); await dispatch.start(d5.id);
      const deliveryRace = await Promise.allSettled([dispatch.offer(d5.id, rivalA.id), dispatch.offer(d5.id, rivalB.id)]);
      assert.equal(deliveryRace.filter(r => r.status === "fulfilled").length, 1);
      const soleOffer = await db<CommitmentRow>("dispatch_commitment").where({ delivery_id: d5.id, status: "OFFERED" }).first(); assert.ok(soleOffer);
      const winningDriver = soleOffer.driver_profile_id === rivalA.id ? rivalA : rivalB;
      await http(winningDriver.cookie, "POST", "/driver/offers/" + soleOffer.id + "/decline", decision);
      assert.equal(await dispatch.candidate(d5.id, p.id), false);
      assert.equal((await dispatch.advance(d5.id, true)).status, "ATTENTION_REQUIRED");
      await http(f.platform.cookie, "PUT", configPath, { expected_revision: 2, mode: "PLATFORM_ONLY", reason: "M15 mode fixture" });
      const six = await completed("expiry"); const d6 = await dispatch.ensure(six.orderId); await dispatch.start(d6.id);
      assert.equal(await dispatch.candidate(d6.id, m.id), false);
      const expiryDriver = await driver("expiry"); const generation = await online(expiryDriver);
      const ea = await drivers.own(expiryDriver.identity); assert.ok(ea.affiliation);
      const expiredId = "dcommit_" + randomUUID();
      // A valid persisted historical OFFERED row whose deadline already elapsed.
      // Constraints/audit remain enabled; only this new synthetic delivery is touched.
      await db.transaction(async trx => {
        const time = await databaseTime(trx);
        await trx("dispatch_commitment").insert({ id: expiredId, delivery_id: d6.id, driver_profile_id: expiryDriver.id,
          generation: 1, path: "PLATFORM", status: "OFFERED", availability_generation: generation,
          affiliation_id: ea.affiliation?.id, affiliation_revision: ea.affiliation?.revision, profile_revision: ea.profile.revision,
          expires_at: new Date(time.getTime() - 1000) });
        await trx("delivery_operation").where({ id: d6.id }).update({ status: "OFFERED", revision: 3 });
        await trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: d6.id,
          revision: 3, action: "OFFER_CREATED", actor_type: "system", occurred_at: time, evidence: JSON.stringify({ fixture: true }) });
      });
      await http(expiryDriver.cookie, "POST", "/driver/offers/" + expiredId + "/accept", decision, 409);
      await http(expiryDriver.cookie, "POST", "/driver/offers/" + expiredId + "/accept", decision, 409);
      assert.equal((await db<CommitmentRow>("dispatch_commitment").where({ id: expiredId }).first())?.status, "EXPIRED");
      // Suspended after discovery is never admitted at offer creation.
      await online(expiryDriver);
      assert.equal(await dispatch.candidate(d6.id, expiryDriver.id), false, "candidate is not re-offered in a generation");
      const suspended = await driver("suspended"); await online(suspended);
      assert.equal(await dispatch.candidate(d6.id, suspended.id), true);
      const sa = await drivers.own(suspended.identity);
      await drivers.mutate({ type: "user", id: user }, "SUSPEND", { expected_revision: sa.profile.revision, confirmed: true, reason: "Fixture suspension" }, suspended.id);
      await assert.rejects(() => dispatch.offer(d6.id, suspended.id));
      const suspensionRaceDriver = await driver("suspension-race"); await online(suspensionRaceDriver);
      const suspensionOffer = await dispatch.offer(d6.id, suspensionRaceDriver.id);
      const suspensionAccount = await drivers.own(suspensionRaceDriver.identity);
      const suspensionRace = await Promise.allSettled([
        drivers.mutate({ type: "user", id: user }, "SUSPEND", { expected_revision: suspensionAccount.profile.revision, confirmed: true, reason: "Concurrent suspension" }, suspensionRaceDriver.id),
        dispatch.decide(suspensionRaceDriver.identity, suspensionOffer.id, "ACCEPT", decision),
      ]);
      assert.equal(suspensionRace[0]?.status, "fulfilled");
      await dispatch.reconcile(d6.id);
      const afterSuspension = await db<CommitmentRow>("dispatch_commitment").where({ id: suspensionOffer.id }).first(); assert.ok(afterSuspension);
      if (suspensionRace[1]?.status === "fulfilled") {
        assert.equal(afterSuspension.status, "ASSIGNED");
        assert.equal((await db("delivery_operation").where({ id: d6.id }).first()).status, "ATTENTION_REQUIRED");
      } else assert.equal(afterSuspension.status, "CANCELLED");
      await http(f.platform.cookie, "PUT", configPath, { expected_revision: 3, mode: "DISABLED", reason: "M15 disabled fixture" });
      await dispatch.reconcile(loser.id);
      assert.equal((await db<CommitmentRow>("dispatch_commitment").where({ id: commitment.id }).first())?.status, "ASSIGNED");
      assert.equal((await db("delivery_operation").where({ id: loser.id }).first()).status, "ATTENTION_REQUIRED");
      assert.equal((await own(assignedDriver.cookie)).effective, "BUSY");
      const safe = JSON.stringify(await http(assignedDriver.cookie, "GET", "/driver/dispatch/current"));
      for (const field of ["latitude","longitude","auth_identity_id","merchant_id","payment_id"]) assert.equal(safe.includes('"' + field + '"'), false);
      const audit = await db<{ evidence: unknown }>("dispatch_event").where(builder => builder
        .whereIn("target_id", db("driver_availability").select("id").whereIn("driver_profile_id", profiles))
        .orWhereIn("target_id", db("delivery_operation").select("id").whereIn("medusa_order_id", orderIds)));
      assert.ok(audit.length);
      for (const event of audit) {
        const evidence = JSON.stringify(event.evidence);
        for (const field of ["latitude","longitude","accuracy"]) assert.equal(evidence.includes('"' + field + '"'), false);
      }
      for (const cookie of [f.ownerA.cookie, one.person.cookie, f.platform.cookie]) await http(cookie, "GET", "/driver/availability", undefined, 401);
      if (orchestration) {
        // All prior domain/security assertions still run. Only synthetic profiles
        // are made offline; existing assignments stay occupied.
        for (const cookie of cookies) {
          const state = await own(cookie);
          await http(cookie, "POST", "/driver/availability/offline", { expected_revision: state.revision });
        }
        await http(f.platform.cookie, "PUT", configPath, { expected_revision: 4, mode: "HYBRID", reason: "M15-C orchestration fixture" });
        const seven = await completed("orchestration-merchant"), eight = await completed("orchestration-platform");
        const worker = new DispatchOrchestrator(container);
        const ensured = await Promise.all([worker.ensure(seven.orderId), new DispatchOrchestrator(container).ensure(seven.orderId)]);
        assert.equal(ensured[0]?.id, ensured[1]?.id, "duplicate event/ensure converges");
        const d7 = ensured[0]; assert.ok(d7);
        const d8 = await worker.ensure(eight.orderId);
        const merchantCandidate = await driver("orchestration-m", first.store.id);
        const platformCandidate = await driver("orchestration-p");
        await online(merchantCandidate); await online(platformCandidate);
        await Promise.all([worker.runBatch([d7.id]), new DispatchOrchestrator(container).runBatch([d7.id])]);
        const firstOffer = await db<CommitmentRow>("dispatch_commitment").where({ delivery_id: d7.id, status: "OFFERED" }).first();
        assert.ok(firstOffer);
        assert.equal(firstOffer.driver_profile_id, merchantCandidate.id);
        assert.equal(firstOffer.path, "MERCHANT");
        assert.equal((await db("dispatch_commitment").where({ delivery_id: d7.id })).length, 1);
        const merchantView = await http(f.ownerA.cookie, "GET", "/merchant/orders/" + seven.orderId + "/delivery");
        assert.equal(z.object({ phase: z.string() }).parse(merchantView).phase, "MERCHANT");
        await http(f.ownerB.cookie, "GET", "/merchant/orders/" + seven.orderId + "/delivery", undefined, 404);
        await http(f.picker.cookie, "GET", "/merchant/orders/" + seven.orderId + "/delivery", undefined, 403);
        await http(eight.person.cookie, "GET", "/store/gospaza/orders/" + seven.orderId + "/delivery", undefined, 404);
        await http(platformCandidate.cookie, "POST", "/driver/offers/" + firstOffer.id + "/accept", decision, 404);
        assert.equal(z.object({ commitment: z.unknown().nullable() }).parse(
          await http(platformCandidate.cookie, "GET", "/driver/dispatch/current")).commitment, null);
        const manualAssignment = await fetch(new URL("/merchant/orders/" + seven.orderId + "/delivery", process.env.BACKEND_URL), {
          method: "POST", headers: { Cookie: f.ownerA.cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ driver_id: platformCandidate.id, mode: "PLATFORM_ONLY" }), signal: AbortSignal.timeout(30000),
        });
        assert.ok([404, 405].includes(manualAssignment.status), "merchant has no dispatch mutation route");
        await manualAssignment.text();
        await http(merchantCandidate.cookie, "POST", "/driver/offers/" + firstOffer.id + "/decline", decision);
        // Advance only fixture-owned scheduler metadata, never business clocks
        // or immutable offer timestamps. Simulates the next due worker tick.
        await db("dispatch_work").where({ delivery_id: d7.id }).update({ next_due_at: db.fn.now() });
        await new DispatchOrchestrator(container).runBatch([d7.id]);
        const fallback = await db<CommitmentRow>("dispatch_commitment").where({ delivery_id: d7.id, status: "OFFERED" }).first();
        assert.ok(fallback); assert.equal(fallback.driver_profile_id, platformCandidate.id); assert.equal(fallback.path, "PLATFORM");
        await http(platformCandidate.cookie, "POST", "/driver/offers/" + fallback.id + "/accept", decision);
        await db("dispatch_work").where({ delivery_id: d7.id }).update({ next_due_at: db.fn.now() });
        await Promise.all([worker.runBatch([d7.id]), new DispatchOrchestrator(container).runBatch([d7.id])]);
        assert.equal((await db("dispatch_commitment").where({ delivery_id: d7.id, status: "ASSIGNED" })).length, 1);
        const customerView = await http(seven.person.cookie, "GET", "/store/gospaza/orders/" + seven.orderId + "/delivery");
        assert.deepEqual(customerView, { status: "ASSIGNED" });
        const assignedView = await http(f.ownerA.cookie, "GET", "/merchant/orders/" + seven.orderId + "/delivery");
        assert.equal(z.object({ status: z.string() }).parse(assignedView).status, "ASSIGNED");
        for (const view of [merchantView, customerView, assignedView]) {
          for (const key of ["latitude", "longitude", "driver_profile_id", "auth_identity_id", "generation"])
            assert.equal(JSON.stringify(view).includes('"' + key + '"'), false);
        }
        // Another order cannot consume the already-assigned platform driver.
        await worker.runBatch([d8.id]);
        const remaining = await db<CommitmentRow>("dispatch_commitment").where({ delivery_id: d8.id, status: "OFFERED" }).first();
        assert.ok(remaining); assert.equal(remaining.driver_profile_id, merchantCandidate.id);
        await http(merchantCandidate.cookie, "POST", "/driver/offers/" + remaining.id + "/decline", decision);
        await db("dispatch_work").where({ delivery_id: d8.id }).update({ next_due_at: db.fn.now() });
        await worker.runBatch([d8.id]);
        assert.equal((await db("delivery_operation").where({ id: d8.id }).first()).status, "ATTENTION_REQUIRED");
        await online(merchantCandidate);
        await db("dispatch_work").where({ delivery_id: d8.id }).update({ next_due_at: db.fn.now() });
        await new DispatchOrchestrator(container).runBatch([d8.id]);
        assert.equal((await db("delivery_operation").where({ id: d8.id }).first()).status, "ATTENTION_REQUIRED",
          "online event never restarts an exhausted generation");
        const scheduled = await worker.ensure(f.a.orderId);
        await worker.runBatch([scheduled.id]);
        assert.equal((await db("dispatch_commitment").where({ delivery_id: scheduled.id })).length, 0,
          "repair never dispatches before scheduled not-before");
        const nine = await completed("restart-expiry"), ten = await completed("generation-expiry");
        const d9 = await worker.ensure(nine.orderId), d10 = await worker.ensure(ten.orderId);
        const timed = await driver("timed", first.store.id), timed2 = await driver("timed2", first.store.id);
        const timedGeneration = await online(timed), timedGeneration2 = await online(timed2);
        async function historicalOffer(deliveryId: string, who: typeof timed, generation: string, ended: boolean) {
          const account = await drivers.own(who.identity); assert.ok(account.affiliation);
          const id = "dcommit_" + randomUUID();
          await db.transaction(async trx => {
            const time = await databaseTime(trx), started = new Date(time.getTime() - (ended ? 301000 : 121000));
            const deadline = new Date(started.getTime() + dispatch.policy.searchMs);
            await trx("delivery_operation").where({ id: deliveryId }).update({
              status: "OFFERED", revision: 2, generation: 1, mode: "HYBRID", configuration_revision: 5, path: "MERCHANT",
              started_at: started, deadline, merchant_deadline: new Date(started.getTime() + dispatch.policy.merchantPhaseMs),
              offer_ms: dispatch.policy.offerMs,
            });
            await trx("dispatch_commitment").insert({ id, delivery_id: deliveryId, driver_profile_id: who.id,
              generation: 1, path: "MERCHANT", status: "OFFERED", availability_generation: generation,
              affiliation_id: account.affiliation?.id, affiliation_revision: account.affiliation?.revision,
              profile_revision: account.profile.revision, expires_at: new Date(Math.min(time.getTime() - 1000, deadline.getTime())) });
            await trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: deliveryId,
              revision: 2, action: "OFFER_CREATED", actor_type: "system", occurred_at: time, evidence: JSON.stringify({ fixture: true }) });
          });
          return id;
        }
        const expiredOffer = await historicalOffer(d9.id, timed, timedGeneration, false);
        const endedOffer = await historicalOffer(d10.id, timed2, timedGeneration2, true);
        await Promise.all([
          new DispatchOrchestrator(container).runBatch([d9.id, d10.id]),
          f.http(timed.cookie, "POST", "/driver/offers/" + expiredOffer + "/accept", decision).then(r => f.expect(r, 409)),
          f.http(timed2.cookie, "POST", "/driver/offers/" + endedOffer + "/decline", decision).then(r => f.expect(r, 409)),
        ]);
        assert.equal((await db("dispatch_commitment").where({ id: expiredOffer }).first()).status, "EXPIRED");
        assert.equal((await db("dispatch_commitment").where({ id: endedOffer }).first()).status, "EXPIRED");
        await db("dispatch_work").whereIn("delivery_id", [d9.id, d10.id]).update({ next_due_at: db.fn.now() });
        await new DispatchOrchestrator(container).runBatch([d9.id, d10.id]);
        assert.equal((await db("delivery_operation").where({ id: d9.id }).first()).path, "PLATFORM");
        assert.equal((await db("delivery_operation").where({ id: d10.id }).first()).status, "ATTENTION_REQUIRED");
        assert.equal((await db("dispatch_commitment").where({ delivery_id: d10.id })).length, 1,
          "generation deadline never creates a replacement offer");
        if (acceptance) {
          // D adds only missing acceptance checks; B/C assertions above still run.
          // Keep discovery fixture-scoped by taking only our synthetic profiles
          // offline. Assignment commitments are deliberately retained.
          for (const cookie of cookies) {
            const state = await own(cookie);
            await http(cookie, "POST", "/driver/availability/offline", { expected_revision: state.revision });
          }
          const beforeOrder = await completed("phase-accept-wins"), afterOrder = await completed("phase-fallback-wins");
          const beforeDelivery = await worker.ensure(beforeOrder.orderId), afterDelivery = await worker.ensure(afterOrder.orderId);
          const beforeDriver = await driver("phase-before", first.store.id), afterDriver = await driver("phase-after", first.store.id);
          const spillover = await driver("phase-platform");
          // Seed valid durable elapsed-time state, not mutable production clocks
          // or sleeps. The expired offer ends AT the merchant-phase boundary.
          async function phaseOffer(deliveryId: string, who: typeof beforeDriver, elapsed: boolean) {
            const generation = await online(who), account = await drivers.own(who.identity);
            assert.ok(account.affiliation);
            const id = "dcommit_" + randomUUID();
            await db.transaction(async trx => {
              const now = await databaseTime(trx);
              const started = new Date(now.getTime() - (elapsed ? dispatch.policy.merchantPhaseMs + 1 : 0));
              const phase = new Date(started.getTime() + dispatch.policy.merchantPhaseMs);
              const deadline = new Date(started.getTime() + dispatch.policy.searchMs);
              assert.ok(deadline > now, "acceptance fixture needs merchant phase shorter than search window");
              await trx("delivery_operation").where({ id: deliveryId }).update({ status: "OFFERED", revision: 2,
                generation: 1, mode: "HYBRID", configuration_revision: 5, path: "MERCHANT", started_at: started,
                deadline, merchant_deadline: phase, offer_ms: dispatch.policy.offerMs });
              await trx("dispatch_commitment").insert({ id, delivery_id: deliveryId, driver_profile_id: who.id,
                generation: 1, path: "MERCHANT", status: "OFFERED", availability_generation: generation,
                affiliation_id: account.affiliation?.id, affiliation_revision: account.affiliation?.revision,
                profile_revision: account.profile.revision,
                expires_at: elapsed ? phase : new Date(Math.min(phase.getTime(), now.getTime() + dispatch.policy.offerMs)) });
              await trx("dispatch_event").insert({ id: "dsevt_" + randomUUID(), target_type: "DELIVERY", target_id: deliveryId,
                revision: 2, action: "OFFER_CREATED", actor_type: "system", occurred_at: now, evidence: JSON.stringify({ fixture: true }) });
            });
            return id;
          }
          const beforeOffer = await phaseOffer(beforeDelivery.id, beforeDriver, false);
          // Separate real transactions: duplicate accepts race a due worker and
          // an exhaustion/fallback observation. Only one assignment audit exists.
          const accepted = await Promise.all([
            dispatch.decide(beforeDriver.identity, beforeOffer, "ACCEPT", decision),
            dispatch.decide(beforeDriver.identity, beforeOffer, "ACCEPT", decision),
            worker.runBatch([beforeDelivery.id]),
            dispatch.advance(beforeDelivery.id, true),
          ]);
          assert.equal(accepted[0].status, "ASSIGNED"); assert.deepEqual(accepted[0], accepted[1]);
          assert.equal((await db("delivery_operation").where({ id: beforeDelivery.id }).first()).status, "ASSIGNED");
          assert.equal((await db("dispatch_commitment").where({ delivery_id: beforeDelivery.id })).length, 1);
          assert.equal((await db("dispatch_event").where({ target_id: beforeDelivery.id, action: "ASSIGNED" })).length, 1);
          assert.equal((await db("dispatch_event").where({ target_id: beforeDelivery.id, action: "PLATFORM_FALLBACK" })).length, 0);

          const afterOffer = await phaseOffer(afterDelivery.id, afterDriver, true);
          await online(spillover);
          await Promise.all([
            f.http(afterDriver.cookie, "POST", "/driver/offers/" + afterOffer + "/accept", decision).then(r => f.expect(r, 409)),
            worker.runBatch([afterDelivery.id]), new DispatchOrchestrator(container).runBatch([afterDelivery.id]),
          ]);
          assert.ok((await db("dispatch_commitment").where({ delivery_id: afterDelivery.id })
            .whereIn("status", ["OFFERED", "ASSIGNED"])).length <= 1);
          // A worker may lose its observed commitment to the concurrent expiry.
          // Its next durable observation must converge, without replaying accept.
          await db("dispatch_work").where({ delivery_id: afterDelivery.id }).update({ next_due_at: db.fn.now() });
          await new DispatchOrchestrator(container).runBatch([afterDelivery.id]);
          const phaseState = await db("delivery_operation").where({ id: afterDelivery.id }).first();
          assert.equal(phaseState.path, "PLATFORM"); assert.equal(phaseState.status, "OFFERED");
          const phaseCommitments = await db<CommitmentRow>("dispatch_commitment").where({ delivery_id: afterDelivery.id });
          assert.equal(phaseCommitments.find(c => c.id === afterOffer)?.status, "EXPIRED");
          const live = phaseCommitments.filter(c => ["OFFERED", "ASSIGNED"].includes(c.status));
          assert.equal(live.length, 1); assert.equal(live[0]?.driver_profile_id, spillover.id);
          assert.equal(live[0]?.path, "PLATFORM");
          const platformOffer = live[0]; assert.ok(platformOffer);
          const otherAccount = await drivers.own(expiryDriver.identity); assert.ok(otherAccount.affiliation);
          const otherAvailability = await own(expiryDriver.cookie); assert.ok(otherAvailability.generation);
          await assert.rejects(() => db.transaction(trx => trx("dispatch_commitment").insert({
            id: "dcommit_" + randomUUID(), delivery_id: afterDelivery.id, driver_profile_id: expiryDriver.id,
            generation: 1, path: "PLATFORM", status: "OFFERED", availability_generation: otherAvailability.generation,
            affiliation_id: otherAccount.affiliation?.id, affiliation_revision: otherAccount.affiliation?.revision,
            profile_revision: otherAccount.profile.revision, expires_at: platformOffer.expires_at,
          })), /dispatch_one_delivery_commitment/);
          assert.equal((await db("dispatch_event").where({ target_id: afterDelivery.id, action: "PLATFORM_FALLBACK" })).length, 1);
          await http(afterDriver.cookie, "POST", "/driver/offers/" + afterOffer + "/accept", decision, 409);
          await http(afterDriver.cookie, "POST", "/driver/offers/" + afterOffer + "/decline", decision, 409);
          await http(beforeDriver.cookie, "POST", "/driver/offers/" + afterOffer + "/decline", decision, 404);
          await http(beforeDriver.cookie, "POST", "/driver/offers/dcommit_unknown/decline", decision, 404);

          // Known IDs, stale configuration and every authority-bearing field are
          // hostile HTTP inputs, rather than happy-path UI/mocked assertions.
          for (const field of ["status", "merchant_id", "merchant_store_id", "driver_id", "mode", "path", "generation",
            "expires_at", "available_since", "eligible", "actor_id", "restricted_content_present"]) {
            await http(spillover.cookie, "POST", "/driver/offers/" + platformOffer.id + "/accept",
              { ...decision, [field]: "forged" }, 400);
          }
          for (const cookie of [spillover.cookie, afterOrder.person.cookie, f.ownerB.cookie])
            await http(cookie, "PUT", configPath, { expected_revision: 5, mode: "MERCHANT_ONLY", reason: "forged authority" }, 401);
          await http(f.platform.cookie, "PUT", configPath, { expected_revision: 4, mode: "DISABLED", reason: "stale write" }, 409);
          assert.equal((await dispatch.configuration(user, first.store.id)).revision, 5);
          await http(f.ownerB.cookie, "GET", "/merchant/orders/order_unknown/delivery", undefined, 404);
          await http(afterOrder.person.cookie, "GET", "/store/gospaza/orders/order_unknown/delivery", undefined, 404);
          await http(f.ownerA.cookie, "GET", "/merchant/orders/" + beforeOrder.orderId + "/delivery?merchant_id=" + second.merchantId, undefined, 400);
          await http(afterOrder.person.cookie, "GET", "/store/gospaza/orders/" + afterOrder.orderId + "/delivery?driver_id=" + spillover.id, undefined, 400);

          // Deferred audit enforcement must roll back a business write without
          // its evidence; terminal rows cannot be restarted even through SQL.
          const available = await db("driver_availability").where({ driver_profile_id: spillover.id }).first();
          await assert.rejects(() => db.transaction(trx => trx("driver_availability").where({ id: available.id })
            .update({ revision: available.revision + 1 })), /Dispatch audit required/);
          assert.equal((await db("driver_availability").where({ id: available.id }).first()).revision, available.revision);
          const assignedDelivery = await db("delivery_operation").where({ id: beforeDelivery.id }).first();
          await assert.rejects(() => db.transaction(trx => trx("delivery_operation").where({ id: beforeDelivery.id })
            .update({ status: "SEARCHING", revision: assignedDelivery.revision + 1 })), /Terminal delivery/);
          const duplicateDeclines = await Promise.all([
            dispatch.decide(spillover.identity, platformOffer.id, "DECLINE", decision),
            dispatch.decide(spillover.identity, platformOffer.id, "DECLINE", decision),
          ]);
          assert.deepEqual(duplicateDeclines[0], duplicateDeclines[1]);
          assert.equal((await db("dispatch_event").where({ target_id: afterDelivery.id, action: "DECLINED" })).length, 1);
          await http(spillover.cookie, "POST", "/driver/offers/" + platformOffer.id + "/accept", decision, 409);
          // Explicitly verify native commercial and financial evidence after D.
          assert.equal(await evidence(baselineIds), baseline, "dispatch acceptance never mutates native commerce");
        }
        const eleven = await completed("readiness-loss"), d11 = await worker.ensure(eleven.orderId);
        const fresh = await driver("readiness-loss", first.store.id); await online(fresh);
        await dispatch.start(d11.id);
        const pending = await dispatch.offer(d11.id, fresh.id);
        await http(f.platform.cookie, "PUT", configPath, { expected_revision: 5, mode: "DISABLED", reason: "Readiness loss fixture" });
        await http(fresh.cookie, "POST", "/driver/offers/" + pending.id + "/accept", decision, 409);
        await worker.runBatch([d11.id]);
        assert.equal((await db("dispatch_commitment").where({ id: pending.id }).first()).status, "CANCELLED");
        assert.equal((await db("delivery_operation").where({ id: d11.id }).first()).status, "ATTENTION_REQUIRED");
        // Existing assignment remains occupied even after safety disablement.
        await db("dispatch_work").where({ delivery_id: d7.id }).update({ next_due_at: db.fn.now() });
        await worker.runBatch([d7.id]);
        assert.equal((await db("dispatch_commitment").where({ id: fallback.id }).first()).status, "ASSIGNED");
        assert.equal((await db("delivery_operation").where({ id: d7.id }).first()).status, "ATTENTION_REQUIRED");
      }
    } catch (error) { failures.push(error); }
    // Fixture-scoped only; no shared Redis clear, no disabling constraints/triggers.
    for (const cookie of cookies) { try { await http(cookie, "DELETE", "/auth/session"); } catch (error) { failures.push(error); } }
    try {
      const redis = new Redis(redisUrl);
      try { for (const id of profiles) await redis.del(...["sample","fence","rate"].map(s => "gospaza:dispatch:{" + id + "}:" + s)); }
      finally { redis.disconnect(); }
      await db.transaction(async trx => {
        const deliveryIds = trx("delivery_operation").select("id").whereIn("medusa_order_id", orderIds);
        const availabilityIds = trx("driver_availability").select("id").whereIn("driver_profile_id", profiles);
        const configs = trx("store_dispatch_configuration").select("id").whereIn("merchant_store_id", [first.store.id,second.store.id]);
        await trx("dispatch_event").where(builder => builder.whereIn("target_id", deliveryIds).orWhereIn("target_id", availabilityIds).orWhereIn("target_id", configs)).delete();
        await trx("dispatch_commitment").whereIn("delivery_id", deliveryIds).delete();
        await trx("dispatch_work").whereIn("delivery_id", deliveryIds).delete();
        await trx("delivery_operation").whereIn("medusa_order_id", orderIds).delete();
        await trx("driver_availability").whereIn("driver_profile_id", profiles).delete();
        await trx("store_dispatch_configuration").whereIn("merchant_store_id", [first.store.id,second.store.id]).delete();
        const sessions = trx("pick_session").select("id").whereIn("order_operation_id", trx("order_operation").select("id").whereIn("medusa_order_id", orderIds));
        await cleanupShortages(trx, orderIds);
        await trx("pick_event").whereIn("pick_session_id", sessions).delete();
        await trx("pick_line").whereIn("pick_session_id", sessions).delete();
        await trx("pick_session").whereIn("id", sessions).delete();
        await trx("driver_event").whereIn("driver_profile_id", profiles).delete();
        await trx("driver_affiliation").whereIn("driver_profile_id", profiles).delete();
        await trx("driver_profile").whereIn("id", profiles).delete();
      });
      await auth.deleteAuthIdentities(identities);
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, acceptance ? "M15-D dispatch acceptance verification failed."
      : orchestration ? "M15-C dispatch orchestration verification failed." : "M15-B dispatch domain verification failed.");
  });
  console.log("M15-B passed: real Order readiness, omission admission, actor authority, Redis fences, commitment races and unchanged native commerce.");
}
