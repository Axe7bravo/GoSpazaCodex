import { switchMarketplaceCart } from "../workflows/switch-marketplace-cart";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, ICartModuleService, IFulfillmentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { deleteShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";
import { z } from "@medusajs/framework/zod";
import verifyCartFoundation from "./verify-cart-foundation";
import type { CartVerificationFixture } from "./verify-cart-foundation";
import { SchedulingService } from "../lib/scheduling-service";
import { LocationService } from "../lib/location-service";
import { cartOperation } from "../lib/cart-lock";
import { databaseTime, lockSlots } from "../modules/marketplace/delivery-reservation-repository";

const selection = z.object({
  state: z.enum(["held", "unselected", "expired", "unavailable", "stale"]), revision: z.number().int().nonnegative(),
  timezone: z.string().nullable(),
  selection: z.object({
    id: z.string(), slot_id: z.string(), option_id: z.string(),
    start_at: z.string(), end_at: z.string(), expires_at: z.string(),
    fee_minor: z.number().int().nonnegative(), currency_code: z.literal("zar"),
  }).strict().nullable(),
}).strict();
const availability = z.object({ revision: z.number(), options: z.array(z.object({ id: z.string(), mode: z.string(), revision: z.number() })),
  slots: z.array(z.object({ id: z.string() })) });
const cartResult = z.object({ cart_id: z.string() });

async function verify(fixture: CartVerificationFixture) {
  const { container, first, second, location, request } = fixture;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
  const scheduling = new SchedulingService(container);
  const stores = [first.store.id, second.store.id];
  const prefix = "m9c-" + randomUUID();
  const path = "/store/gospaza/cart/delivery-selection";
  const optionsPath = "/store/gospaza/cart/delivery-options";
  async function http(cookie: string, method: string, body?: unknown, route = path) {
    const response = await request(route, cookie, method, body);
    const bodyValue: unknown = await response.json();
    return { status: response.status, body: bodyValue };
  }
  const expect = (result: { status: number; body: unknown }, status = 200) => {
    assert.equal(result.status, status, JSON.stringify(result)); return result.body;
  };
  async function parallel(tasks: Promise<Awaited<ReturnType<typeof http>>>[]) {
    const results = await Promise.allSettled(tasks);
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results));
    return results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
  }
  async function customer(suffix: string, variantId = first.variantId) {
    const person = await fixture.createCustomer(prefix + suffix);
    const cart = cartResult.parse(expect(await http(person.cookie, "POST", { variant_id: variantId, quantity: 2, location }, "/store/gospaza/cart/items")));
    return { ...person, cartId: cart.cart_id };
  }
  const read = async (person: { cookie: string; cartId: string }) => selection.parse(expect(await http(person.cookie, "GET", undefined, path + "?cart_id=" + person.cartId)));
  const discover = async (person: { cookie: string; cartId: string }) => availability.parse(expect(await http(person.cookie, "POST", { cart_id: person.cartId, location }, optionsPath)));
  const reason = "M9-C isolated reservation verification";
  const errors: unknown[] = [];
  const addressFixtures: { cookie: string; id: string }[] = [];
  try {
    const now = await db.transaction(databaseTime);
    const start = new Date(now.getTime() + 86400000);
    const slotBody = (offset: number, capacity = 1) => ({ start_at: new Date(start.getTime() + offset * 7200000).toISOString(),
      end_at: new Date(start.getTime() + offset * 7200000 + 3600000).toISOString(),
      booking_cutoff_at: new Date(start.getTime() + offset * 7200000 - 3600000).toISOString(), capacity, enabled: true });
    for (const storeId of stores) {
      await scheduling.savePolicy(storeId, { enabled: true, asap_enabled: true, scheduled_enabled: true }, prefix, reason);
      const assignments = await db<{ id: string }>("merchant_store_service_zone").where({ merchant_store_id: storeId });
      for (const assignment of assignments) await scheduling.configureAssignment(storeId, assignment.id, 1, true, true, prefix, reason);
      await scheduling.synchronize(storeId, prefix, reason);
    }
    const slotA = await scheduling.saveSlot(first.store.id, slotBody(0), prefix, reason);
    const slotB = await scheduling.saveSlot(first.store.id, slotBody(1), prefix, reason);
    const slotC = await scheduling.saveSlot(first.store.id, slotBody(2, 3), prefix, reason);
    const expiredSlot = await scheduling.saveSlot(first.store.id, {
      ...slotBody(3), booking_cutoff_at: new Date(now.getTime() - 60000).toISOString(),
    }, prefix, reason);
    const foreignSlot = await scheduling.saveSlot(second.store.id, slotBody(0), prefix, reason);
    const a = await customer("a"), b = await customer("b"), foreign = await customer("foreign", second.variantId);
    const advertised = await discover(a), foreignOptions = await discover(foreign);
    const scheduled = advertised.options.find((o) => o.mode === "SCHEDULED");
    const asap = advertised.options.find((o) => o.mode === "ASAP");
    assert.ok(scheduled && asap && foreignOptions.options[0]);
    const input = (person: typeof a, slotId: string, revision = 0) => ({ cart_id: person.cartId, location,
      option_id: scheduled.id, expected_option_revision: scheduled.revision, slot_id: slotId, expected_revision: revision });
    const release = async (person: typeof a) => {
      const held = await read(person);
      return selection.parse(expect(await http(person.cookie, "DELETE", { cart_id: person.cartId,
        expected_revision: held.revision, ...(held.selection ? { reservation_id: held.selection.id } : {}) })));
    };
    // No anonymous/native alternate path; forged authority is tested over HTTP.
    expect(await http("", "PUT", input(a, slotA.id)), 401);
    for (const [route, method] of [["/store/shipping-options", "GET"], ["/store/shipping-options/so_foreign/calculate", "POST"],
      ["/store/carts/" + a.cartId + "/shipping-methods", "POST"]]) {
      assert.ok(route && method);
      expect(await http(a.cookie, method, method === "POST" ? {} : undefined, route), 404);
    }
    for (const field of ["merchant_id", "store_id", "merchant_store_id", "customer_id", "sales_channel_id", "zone_id", "fee_minor", "context_id", "reservation_id"]) {
      expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), [field]: "forged" }), 400);
    }
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), cart_id: foreign.cartId }), 404);
    expect(await http(a.cookie, "GET", undefined, path + "?cart_id=" + foreign.cartId), 404);
    expect(await http(a.cookie, "DELETE", { cart_id: foreign.cartId, expected_revision: 0 }), 404);
    const foreignNativeOption = await db<{ medusa_shipping_option_id: string }>("delivery_option_configuration")
      .where({ id: foreignOptions.options[0].id }).first();
    assert.ok(foreignNativeOption);
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), option_id: foreignNativeOption.medusa_shipping_option_id }), 404);
    expect(await http(a.cookie, "PUT", input(a, foreignSlot.id)), 409);
    expect(await http(a.cookie, "PUT", input(a, expiredSlot.id)), 409);
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), option_id: foreignOptions.options[0].id }), 404);
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), location: { address_id: "cuaddr_foreign" } }), 404);
    // M9-E: hostile known IDs must also fail on read-only discovery endpoints.
    for (const route of [optionsPath, "/store/gospaza/cart/delivery-slots"]) {
      expect(await http("", "POST", { cart_id: a.cartId, location }, route), 401);
      expect(await http(a.cookie, "POST", { cart_id: foreign.cartId, location }, route), 404);
      for (const field of ["merchant_id", "store_id", "customer_id", "sales_channel_id", "zone_id", "fee_minor", "context_id"]) {
        expect(await http(a.cookie, "POST", { cart_id: a.cartId, location, [field]: "forged" }, route), 400);
      }
      expect(await http(a.cookie, "POST", { cart_id: a.cartId, location: { latitude: 0, longitude: 0 } }, route), 409);
    }
    expect(await http("", "GET"), 401);
    expect(await http("", "DELETE", { cart_id: a.cartId, expected_revision: 0 }), 401);
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), location: { latitude: 0, longitude: 0 } }), 409);
    expect(await http(a.cookie, "GET", undefined, path + "?cart_id=" + a.cartId + "&customer_id=" + foreign.id), 400);
    expect(await http(a.cookie, "DELETE", { cart_id: a.cartId, expected_revision: 0, customer_id: foreign.id }), 400);

    // Native routes must reject real known option/cart IDs before any native
    // read or write, for authenticated and anonymous callers and every method.
    for (const cookie of ["", a.cookie]) {
      for (const route of ["/store/shipping-options", "/store/shipping-options/" + foreignNativeOption.medusa_shipping_option_id,
        "/store/shipping-options/" + foreignNativeOption.medusa_shipping_option_id + "/calculate",
        "/store/carts/" + a.cartId + "/shipping-methods"]) {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          expect(await http(cookie, method, method === "GET" ? undefined
            : { cart_id: a.cartId, option_id: foreignNativeOption.medusa_shipping_option_id }, route), 404);
        }
      }
    }

    // A real owned address is an allowed location for its owner, but never for
    // a different customer's availability or reservation operation.
    const point = z.object({ latitude: z.number(), longitude: z.number() }).parse(location);
    expect(await http(foreign.cookie, "POST", {
      first_name: "Fixture", last_name: "Customer", address_1: "1 Fixture Street", address_2: "",
      city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "za", phone: "",
      location: { ...point, source: "browser_geolocation" },
    }, "/store/gospaza/addresses"), 201);
    const ownedAddresses = z.object({ addresses: z.array(z.object({ id: z.string() })) })
      .parse(expect(await http(foreign.cookie, "GET", undefined, "/store/gospaza/addresses")));
    for (const address of ownedAddresses.addresses) addressFixtures.push({ cookie: foreign.cookie, id: address.id });
    assert.equal(ownedAddresses.addresses.length, 1);
    const addressId = ownedAddresses.addresses[0]?.id;
    assert.ok(addressId);
    expect(await http(foreign.cookie, "POST", { cart_id: foreign.cartId, location: { address_id: addressId } }, optionsPath));
    for (const route of [optionsPath, "/store/gospaza/cart/delivery-slots"]) {
      expect(await http(a.cookie, "POST", { cart_id: a.cartId, location: { address_id: addressId } }, route), 404);
    }
    expect(await http(a.cookie, "PUT", { ...input(a, slotA.id), location: { address_id: addressId } }), 404);


    const raced = await parallel([http(a.cookie, "PUT", input(a, slotA.id)), http(b.cookie, "PUT", input(b, slotA.id))]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409], JSON.stringify(raced));
    const winner = raced[0]?.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    const held = await read(winner);
    assert.ok(held.selection);

    // The same slot capacity is shared by operational modes. An ASAP customer
    // must skip the full window already held through SCHEDULED, not multiply it.
    const modeCustomer = await customer("mode-capacity");
    const modeHold = selection.parse(expect(await http(modeCustomer.cookie, "PUT", {
      cart_id: modeCustomer.cartId, location, option_id: asap.id,
      expected_option_revision: asap.revision, expected_revision: 0,
    })));
    assert.equal(modeHold.selection?.slot_id, slotB.id, "ASAP must skip capacity consumed by SCHEDULED");
    assert.equal((await db("delivery_reservation").where({ delivery_slot_id: slotA.id, status: "HELD" })).length, 1);
    await release(modeCustomer);

    const repeat = selection.parse(expect(await http(winner.cookie, "PUT", input(winner, slotA.id, held.revision))));
    assert.deepEqual(repeat, held, "identical selection and restoration cannot renew expiry");
    expect(await http(loser.cookie, "DELETE", { cart_id: loser.cartId, reservation_id: held.selection.id, expected_revision: 0 }), 404);
    const occupiedB = selection.parse(expect(await http(loser.cookie, "PUT", input(loser, slotB.id))));
    expect(await http(winner.cookie, "PUT", input(winner, slotB.id, held.revision)), 409);
    assert.deepEqual(await read(winner), held, "failed replacement preserves original valid hold");
    await release(loser);
    const replaced = selection.parse(expect(await http(winner.cookie, "PUT", input(winner, slotB.id, held.revision))));
    assert.ok(replaced.selection);
    assert.notEqual(replaced.selection.id, held.selection.id);
    expect(await http(winner.cookie, "PUT", input(winner, slotA.id, held.revision)), 409);
    // Neither a known replaced reservation nor an old revision may release the
    // new hold. Exercise the ID and revision boundaries independently over HTTP.
    for (const staleRelease of [
      { reservation_id: held.selection.id, expected_revision: replaced.revision },
      { reservation_id: replaced.selection.id, expected_revision: held.revision },
    ]) {
      const rejectedRelease = await http(winner.cookie, "DELETE", { cart_id: winner.cartId, ...staleRelease });
      expect(rejectedRelease, 409);
      assert.equal(z.object({ code: z.string() }).parse(rejectedRelease.body).code, "DELIVERY_SELECTION_STALE");
      assert.deepEqual(await read(winner), replaced, "stale release cannot discard the replacement or renew expiry");
    }
    assert.equal((await db("delivery_reservation").where({ id: held.selection.id }).first()).status, "RELEASED");
    assert.ok(occupiedB.selection);
    // Earliest eligible window, not the caller's preferred ASAP slot.
    const earliest = selection.parse(expect(await http(loser.cookie, "PUT", { cart_id: loser.cartId, location,
      option_id: asap.id, expected_option_revision: asap.revision, expected_revision: (await read(loser)).revision })));
    assert.equal(earliest.selection?.slot_id, slotA.id);
    assert.ok(earliest.selection);
    const releaseInput = { cart_id: loser.cartId, reservation_id: earliest.selection.id, expected_revision: earliest.revision };
    const releasedOnce = expect(await http(loser.cookie, "DELETE", releaseInput));
    assert.deepEqual(expect(await http(loser.cookie, "DELETE", releaseInput)), releasedOnce, "exact release replay is idempotent");
    const rev = (await read(loser)).revision;
    const same = await parallel([http(loser.cookie, "PUT", input(loser, slotC.id, rev)), http(loser.cookie, "PUT", input(loser, slotC.id, rev))]);
    assert.deepEqual(same.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await db("delivery_reservation").where({ status: "HELD" }).whereIn("merchant_store_id", stores)).length, 2);

    // Expired HELD record still exists; it must not consume capacity before cleanup.
    const beforeExpiry = await read(winner);
    assert.ok(beforeExpiry.selection);
    await cartOperation(container, winner.id, () => db.transaction(async (trx) => {
      await lockSlots(trx, [slotB.id]);
      const time = await databaseTime(trx);
      await trx("delivery_reservation").where({ id: beforeExpiry.selection?.id }).update({
        created_at: new Date(time.getTime() - 120000), expires_at: new Date(time.getTime() - 60000),
      });
    }));
    assert.equal((await db("delivery_reservation").where({ id: beforeExpiry.selection.id }).first()).status, "HELD");
    await release(loser);
    expect(await http(loser.cookie, "PUT", input(loser, slotB.id, (await read(loser)).revision)));
    await release(loser);
    // An expired old row and a new selection race through the real customer
    // boundary. Either restoration publishes EXPIRED first (stale selection),
    // or replacement publishes HELD first (restoration sees that new hold).
    const expiryRace = await parallel([
      http(winner.cookie, "PUT", input(winner, slotC.id, beforeExpiry.revision)),
      http(winner.cookie, "GET", undefined, path + "?cart_id=" + winner.cartId),
    ]);
    assert.ok([200, 409].includes(expiryRace[0]!.status), JSON.stringify(expiryRace));
    expect(expiryRace[1]!);
    const afterExpiry = await read(winner);
    if (expiryRace[0]!.status === 200) {
      assert.equal(afterExpiry.selection?.slot_id, slotC.id);
    } else {
      assert.equal(afterExpiry.selection, null);
      // A distinct, explicitly refreshed selection following the stale response.
      expect(await http(winner.cookie, "PUT", input(winner, slotC.id, afterExpiry.revision)));
    }

    // Capacity reduction cannot displace existing effective holds.
    const extra = await customer("capacity");
    expect(await http(extra.cookie, "PUT", input(extra, slotC.id)));
    await assert.rejects(scheduling.saveSlot(first.store.id, slotBody(2, 1), prefix, reason, slotC.id), /occupancy/);
    await scheduling.saveSlot(first.store.id, slotBody(2, 2), prefix, reason, slotC.id);
    assert.equal((await read(extra)).state, "held");
    await release(extra);
    const reductionRevision = (await read(extra)).revision;
    const reduceRace = await Promise.allSettled([
      scheduling.saveSlot(first.store.id, slotBody(2, 1), prefix, reason, slotC.id),
      http(extra.cookie, "PUT", input(extra, slotC.id, reductionRevision)),
    ]);
    const booking = reduceRace[1];
    assert.ok(booking?.status === "fulfilled");
    if (reduceRace[0]?.status === "fulfilled") expect(booking.value, 409);
    else expect(booking.value);
    await release(extra);
    await scheduling.saveSlot(first.store.id, slotBody(2, 2), prefix, reason, slotC.id);
    // A failed Marketplace publication rolls back the release of the old hold.
    const prior = await read(winner);
    const faultName = prefix.replaceAll("-", "_") + "_publication";
    await db.raw(`create function "${faultName}"() returns trigger language plpgsql as $$ begin
      if new.delivery_slot_id = '${slotB.id}' and new.status = 'HELD' then raise exception 'M9-C fixture publication failure'; end if;
      return new; end; $$`);
    try {
      await db.raw(`create trigger "${faultName}" before insert on delivery_reservation for each row execute function "${faultName}"()`);
      expect(await http(winner.cookie, "PUT", input(winner, slotB.id, prior.revision)), 503);
      assert.deepEqual(await read(winner), prior, "failed replacement must preserve old hold and expiry");
    } finally {
      await db.raw(`drop trigger if exists "${faultName}" on delivery_reservation`);
      await db.raw(`drop function "${faultName}"()`);
    }
    // Disabled and expired windows cannot be selected even using stale discovery.
    await scheduling.saveSlot(first.store.id, { ...slotBody(0), enabled: false }, prefix, reason, slotA.id);
    expect(await http(extra.cookie, "PUT", input(extra, slotA.id, (await read(extra)).revision)), 409);


    // M9-E: disabling a held slot invalidates restoration and releases capacity.
    const slotD = await scheduling.saveSlot(first.store.id, slotBody(4), prefix, reason);
    const extraRevision = (await read(extra)).revision;
    const disabledHold = selection.parse(expect(await http(extra.cookie, "PUT", input(extra, slotD.id, extraRevision))));
    assert.ok(disabledHold.selection);
    await scheduling.saveSlot(first.store.id, { ...slotBody(4), enabled: false }, prefix, reason, slotD.id);
    const disabledRestoration = await read(extra);
    assert.equal(disabledRestoration.state, "unavailable");
    assert.equal(disabledRestoration.selection, null);
    assert.equal((await db("delivery_reservation").where({ id: disabledHold.selection.id }).first()).status, "RELEASED");
    await scheduling.saveSlot(first.store.id, slotBody(4), prefix, reason, slotD.id);

    // Native final-item deletion cannot be rolled back by failed hold cleanup.
    // Its uncertain response must be recoverable by a read, never a blind replay.
    const recovery = await customer("empty-recovery");
    const recoveryHold = selection.parse(expect(await http(recovery.cookie, "PUT", input(recovery, slotD.id))));
    assert.ok(recoveryHold.selection);
    const recoveryCart = await carts.retrieveCart(recovery.cartId, { relations: ["items"] });
    const recoveryLine = recoveryCart.items?.[0];
    assert.ok(recoveryLine);
    const cleanupFault = prefix.replaceAll("-", "_") + "_empty_cleanup";
    await db.raw(`create function "${cleanupFault}"() returns trigger language plpgsql as $$ begin
      if new.id = '${recoveryHold.selection.id}' and new.release_reason = 'CART_EMPTY'
        then raise exception 'M9-E fixture final-item cleanup failure'; end if;
      return new; end; $$`);
    try {
      await db.raw(`create trigger "${cleanupFault}" before update on delivery_reservation for each row execute function "${cleanupFault}"()`);
      const failedRemoval = await http(recovery.cookie, "DELETE", { cart_id: recovery.cartId },
        "/store/gospaza/cart/items/" + recoveryLine.id);
      expect(failedRemoval, 503);
      assert.equal(z.object({ code: z.string() }).parse(failedRemoval.body).code, "CART_MUTATION_UNCERTAIN");
      assert.equal((await carts.retrieveCart(recovery.cartId, { relations: ["items"] })).items?.length, 0,
        "native removal succeeded despite the uncertain cleanup response");
      assert.equal((await db("delivery_reservation").where({ id: recoveryHold.selection.id }).first()).status, "HELD");
      const recovered = await read(recovery);
      assert.equal(recovered.state, "unavailable");
      assert.equal(recovered.selection, null);
    } finally {
      await db.raw(`drop trigger if exists "${cleanupFault}" on delivery_reservation`);
      await db.raw(`drop function "${cleanupFault}"()`);
    }
    // Recovery released the only capacity unit; another current cart can take it.
    expect(await http(extra.cookie, "PUT", input(extra, slotD.id, (await read(extra)).revision)));
    await release(extra);

    const holdBeforeFailedSwitch = await read(winner);
    await assert.rejects(() => cartOperation(container, winner.id, () => switchMarketplaceCart(container, {
      oldCartId: winner.cartId, customerId: winner.id, merchantId: second.merchantId,
      storeId: first.store.id, channelId: second.channelId, regionId: fixture.regionId,
      variantId: second.variantId, quantity: 1,
    })));
    assert.deepEqual(await read(winner), holdBeforeFailedSwitch, "failed switch publication preserves old hold");

    const switchInput = { cart_id: winner.cartId, variant_id: second.variantId, quantity: 1, location, confirm: true };
    const switchRevision = (await read(winner)).revision;
    const switched = await parallel([
      http(winner.cookie, "POST", switchInput, "/store/gospaza/cart/switch-store"),
      http(winner.cookie, "PUT", input(winner, slotB.id, switchRevision)),
    ]);
    expect(switched[0]!);
    assert.ok([200, 404].includes(switched[1]!.status), JSON.stringify(switched));
    const newCart = cartResult.parse(switched[0]!.body).cart_id;
    expect(await http(winner.cookie, "PUT", input(winner, slotB.id, 0)), 404);
    expect(await http(winner.cookie, "GET", undefined, path + "?cart_id=" + winner.cartId), 404);
    expect(await http(winner.cookie, "DELETE", { cart_id: winner.cartId, expected_revision: switchRevision }), 404);
    assert.equal((await read({ ...winner, cartId: newCart })).selection, null);
    const oldContext = await db<{ id: string }>("cart_marketplace_context").where({ medusa_cart_id: winner.cartId }).first();
    assert.ok(oldContext);
    assert.equal((await db("delivery_reservation").where({ cart_context_id: oldContext.id, status: "HELD" })).length, 0);

    // M8 decrease/removal remain usable when store eligibility disappears.
    expect(await http(loser.cookie, "PUT", input(loser, slotB.id, (await read(loser)).revision)));
    const native = await carts.retrieveCart(loser.cartId, { relations: ["items"] });
    const line = native.items?.[0]; assert.ok(line);
    await db("merchant_store").where({ id: first.store.id }).update({ active: false });
    try {
      expect(await http(loser.cookie, "PATCH", { cart_id: loser.cartId, quantity: 1 }, "/store/gospaza/cart/items/" + line.id));
      expect(await http(loser.cookie, "DELETE", { cart_id: loser.cartId }, "/store/gospaza/cart/items/" + line.id));
      assert.equal((await read(loser)).selection, null);
    } finally { await db("merchant_store").where({ id: first.store.id }).update({ active: true }); }
    // A real M6 tariff change must invalidate an existing quote, synchronize
    // native pricing, then require explicit selection with the new revision.
    const assignment = await db<{ service_zone_id: string }>("merchant_store_service_zone")
      .where({ merchant_store_id: first.store.id }).first();
    assert.ok(assignment);
    const quoted = selection.parse(expect(await http(extra.cookie, "PUT", input(extra, slotB.id, (await read(extra)).revision))));
    assert.ok(quoted.selection);
    const locations = new LocationService(container);
    const { zone } = await locations.zone(assignment.service_zone_id);
    const { id: zoneId, ...tariff } = zone;
    assert.equal(quoted.selection.fee_minor, tariff.delivery_fee_minor);
    const changedFee = tariff.delivery_fee_minor + 101;
    await locations.save({ ...tariff, delivery_fee_minor: changedFee }, zoneId, prefix);
    const invalidated = await read(extra);
    assert.equal(invalidated.state, "stale");
    assert.equal(invalidated.selection, null);
    const historicalQuote = await db<{ status: string; quoted_fee_minor: number }>("delivery_reservation")
      .where({ id: quoted.selection.id }).first();
    assert.ok(historicalQuote);
    assert.equal(historicalQuote.status, "RELEASED");
    assert.equal(historicalQuote.quoted_fee_minor, quoted.selection.fee_minor, "configuration changes do not rewrite the old quote");
    expect(await http(extra.cookie, "POST", { cart_id: extra.cartId, location }, optionsPath), 409);
    await scheduling.synchronize(first.store.id, prefix, reason);
    expect(await http(extra.cookie, "PUT", input(extra, slotB.id, invalidated.revision)), 409);
    assert.equal((await read(extra)).selection, null, "synchronization and reads must not automatically reconfirm");
    const refreshed = await discover(extra);
    const newOption = refreshed.options.find((o) => o.mode === "SCHEDULED");
    assert.ok(newOption);
    assert.notEqual(newOption.revision, scheduled.revision);
    const reconfirmed = selection.parse(expect(await http(extra.cookie, "PUT", {
      ...input(extra, slotB.id, refreshed.revision), expected_option_revision: newOption.revision,
    })));
    assert.equal(reconfirmed.selection?.fee_minor, changedFee);
    const nativeQuotedCart = await carts.retrieveCart(extra.cartId, { relations: ["shipping_methods"] });
    assert.deepEqual(nativeQuotedCart.shipping_methods, [], "M9 quotes/reserves without attaching a native Shipping Method");
    // Store/zone eligibility loss releases a hold on restoration, retaining cart.
    await db("merchant_store").where({ id: first.store.id }).update({ active: false });
    try { assert.equal((await read(extra)).state, "unavailable"); }
    finally { await db("merchant_store").where({ id: first.store.id }).update({ active: true }); }
    // Release remains idempotent and requires no location.
    assert.deepEqual(await release(loser), await release(loser));
  } catch (error) { errors.push(error); }
  for (const address of addressFixtures) {
    try { expect(await http(address.cookie, "DELETE", undefined, "/store/gospaza/addresses/" + address.id)); }
    catch (error) { errors.push(new Error("M9-E address fixture cleanup failed: " + prefix, { cause: error })); }
  }
  // Run before the reused M8 fixture removes contexts, products and topology.
  try {
    const options = await db<{ id: string }>("delivery_option_configuration").whereIn("merchant_store_id", stores);
    for (const option of options) {
      const native = await fulfillment.listShippingOptions({ name: "gospaza:" + option.id }, { take: null });
      if (native.length) await deleteShippingOptionsWorkflow(container).run({ input: { ids: native.map((o) => o.id) } });
    }
    await db.transaction(async (trx) => {
      await trx("delivery_reservation").whereIn("merchant_store_id", stores).delete();
      await trx("delivery_slot").whereIn("merchant_store_id", stores).delete();
      await trx("delivery_option_configuration").whereIn("merchant_store_id", stores).delete();
      await trx("store_delivery_policy").whereIn("merchant_store_id", stores).delete();
      await trx("scheduling_event").where({ platform_user_id: prefix }).delete();
    });
  } catch (error) { errors.push(new Error("M9-C fixture cleanup failed: " + prefix, { cause: error })); }
  if (errors.length) throw new AggregateError(errors, "M9-C reservation verification failed.");
}

export default async function verifyDeliveryReservations(args: ExecArgs) {
  await verifyCartFoundation(args, verify);
  console.log("M9-C passed: reservation HTTP authority, capacity concurrency, expiry, switching and final-item release.");
}
