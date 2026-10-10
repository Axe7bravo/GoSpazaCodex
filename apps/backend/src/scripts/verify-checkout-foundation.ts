import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecArgs, ICartModuleService, ICustomerModuleService, IFulfillmentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { deleteShippingOptionsWorkflow } from "@medusajs/medusa/core-flows";
import { z } from "@medusajs/framework/zod";
import verifyCartFoundation from "./verify-cart-foundation";
import type { CartVerificationFixture } from "./verify-cart-foundation";
import { SchedulingService } from "../lib/scheduling-service";
import { LocationService } from "../lib/location-service";
import { checkoutMoney, requireUnpaidCart } from "../lib/checkout-native";
import { checkoutAddress, checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";

const cents = z.number().int().nonnegative();
const quoteSchema = z.object({
  cart_id: z.string(), address_id: z.string(), checkout_revision: z.string(), expires_at: z.string(),
  address: checkoutAddress, currency_code: z.literal("zar"), totals: z.object({
    total_minor: cents, subtotal_minor: cents, tax_total_minor: cents,
    discount_total_minor: cents, shipping_total_minor: cents,
  }).strict(),
}).strict();
const attemptSchema = z.object({
  id: z.string(), state: z.enum(["CONFIRMED", "ABANDONED", "EXPIRED"]), quote: quoteSchema,
}).strict();
const preparedSchema = z.object({
  quote: quoteSchema, attempt: attemptSchema.nullable(), reconfirmation_required: z.boolean(),
  code: z.string().optional(),
}).strict();

export interface CheckoutVerificationCustomer {
  id: string; cookie: string; cartId: string; addressId: string;
  hold: { revision: number; selection: { id: string; expires_at: string } };
  input: { cart_id: string; address_id: string; expected_reservation_revision: number };
}
export interface CheckoutVerificationFixture {
  prefix: string;
  fixture: CartVerificationFixture;
  customer(suffix: string, variantId?: string): Promise<CheckoutVerificationCustomer>;
  http(cookie: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  expect(result: { status: number; body: unknown }, status?: number): unknown;
}
async function verify(fixture: CartVerificationFixture, extension?: (fixture: CheckoutVerificationFixture) => Promise<void>) {
  const { container, first, second, request, location } = fixture;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const carts = container.resolve<ICartModuleService>(Modules.CART);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const fulfillment = container.resolve<IFulfillmentModuleService>(Modules.FULFILLMENT);
  const scheduling = new SchedulingService(container);
  const prefix = "m10c-" + randomUUID();
  const reason = "M10-C isolated checkout foundation verification";
  const stores = [first.store.id, second.store.id];
  const addresses: { id: string; cookie: string }[] = [];
  const failures: unknown[] = [];
  const path = "/store/gospaza/checkout";
  const faultName = "checkout_fixture_" + randomUUID().replaceAll("-", "");
  let faultInstalled = false;
  async function http(cookie: string, method: string, route: string, body?: unknown) {
    const response = await request(route, cookie, method, body);
    const data: unknown = await response.json();
    return { status: response.status, body: data };
  }
  const expect = (result: { status: number; body: unknown }, status = 200) => {
    assert.equal(result.status, status, JSON.stringify(result));
    return result.body;
  };
  async function parallel(tasks: Promise<Awaited<ReturnType<typeof http>>>[]) {
    const outcomes = await Promise.allSettled(tasks);
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"), JSON.stringify(outcomes));
    return outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
  }
  try {
    const now = await db.transaction(databaseTime);
    for (const storeId of stores) {
      await scheduling.savePolicy(storeId, { enabled: true, asap_enabled: true, scheduled_enabled: true }, prefix, reason);
      const assignments = await db<{ id: string }>("merchant_store_service_zone").where({ merchant_store_id: storeId });
      for (const assignment of assignments) {
        await scheduling.configureAssignment(storeId, assignment.id, 1, true, true, prefix, reason);
      }
      await scheduling.synchronize(storeId, prefix, reason);
      await scheduling.saveSlot(storeId, {
        start_at: new Date(now.getTime() + 86400000).toISOString(),
        end_at: new Date(now.getTime() + 90000000).toISOString(),
        booking_cutoff_at: new Date(now.getTime() + 82800000).toISOString(), capacity: 30, enabled: true,
      }, prefix, reason);
    }
    async function customer(suffix: string, variantId = first.variantId) {
      const person = await fixture.createCustomer(prefix + suffix);
      const cart = z.object({ cart_id: z.string() }).parse(expect(await http(person.cookie, "POST",
        "/store/gospaza/cart/items", { variant_id: variantId, quantity: 1, location })));
      const point = z.object({ latitude: z.number(), longitude: z.number() }).parse(location);
      expect(await http(person.cookie, "POST", "/store/gospaza/addresses", {
        first_name: "Fixture", last_name: "Customer", address_1: "1 Fixture Street", address_2: "",
        city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "za", phone: "",
        location: { ...point, source: "manual" },
      }), 201);
      const owned = z.object({ addresses: z.array(z.object({ id: z.string() })) })
        .parse(expect(await http(person.cookie, "GET", "/store/gospaza/addresses")));
      for (const address of owned.addresses) addresses.push({ id: address.id, cookie: person.cookie });
      assert.equal(owned.addresses.length, 1);
      const address = owned.addresses[0]; assert.ok(address);
      const available = z.object({
        revision: z.number(), options: z.array(z.object({ id: z.string(), mode: z.string(), revision: z.number() })),
        slots: z.array(z.object({ id: z.string() })),
      }).parse(expect(await http(person.cookie, "POST", "/store/gospaza/cart/delivery-options", {
        cart_id: cart.cart_id, location: { address_id: address.id },
      })));
      const option = available.options.find((item) => item.mode === "SCHEDULED");
      const slot = available.slots[0]; assert.ok(option && slot);
      const held = z.object({
        revision: z.number(), selection: z.object({ id: z.string(), expires_at: z.string() }),
      }).parse(expect(await http(person.cookie, "PUT", "/store/gospaza/cart/delivery-selection", {
        cart_id: cart.cart_id, location: { address_id: address.id }, option_id: option.id,
        expected_option_revision: option.revision, expected_revision: available.revision, slot_id: slot.id,
      })));
      return { ...person, cartId: cart.cart_id, addressId: address.id, hold: held,
        input: { cart_id: cart.cart_id, address_id: address.id, expected_reservation_revision: held.revision } };
    }
    if (extension) {
      await extension({ prefix, fixture, customer, http, expect });
    } else {
      const a = await customer("a"), b = await customer("b", second.variantId);
      expect(await http("", "POST", path + "/prepare", a.input), 401);
      expect(await http(a.cookie, "POST", path + "/prepare", { ...a.input, cart_id: b.cartId }), 404);
      expect(await http(a.cookie, "POST", path + "/prepare", { ...a.input, address_id: b.addressId }), 404);
      expect(await http(a.cookie, "POST", path + "/prepare", { ...a.input, expected_reservation_revision: a.hold.revision + 1 }), 409);
      for (const field of ["merchant_id", "store_id", "merchant_store_id", "zone_id", "sales_channel_id", "customer_id",
        "cart_context_id", "context_id", "reservation_id", "delivery_option_id", "shipping_option_id",
        "payment_collection_id", "payment_session_id", "yoco_checkout_id", "fee_minor", "total", "currency_code"]) {
        expect(await http(a.cookie, "POST", path + "/prepare", { ...a.input, [field]: b.hold.selection.id }), 400);
        expect(await http(a.cookie, "POST", path + "/confirm", {
          ...a.input, confirmed: true, checkout_revision: "a".repeat(64), [field]: b.hold.selection.id,
        }), 400);
      }

      // Native addresses can predate M6 completeness rules. Ownership alone is
      // insufficient; a real incomplete native address must fail before shipping.
      await customers.updateCustomerAddresses(a.addressId, { city: "" });
      try { expect(await http(a.cookie, "POST", path + "/prepare", a.input), 400); }
      finally { await customers.updateCustomerAddresses(a.addressId, { city: "Fixture" }); }
      const addressFields = {
        first_name: "Fixture", last_name: "Customer", address_1: "1 Fixture Street", address_2: "",
        city: "Fixture", province: "Fixture", postal_code: "1234", country_code: "za", phone: "",
      };
      expect(await http(a.cookie, "PATCH", "/store/gospaza/addresses/" + a.addressId, {
        ...addressFields, location: { latitude: 0, longitude: 0, source: "manual" },
      }));
      try { expect(await http(a.cookie, "POST", path + "/prepare", a.input), 409); }
      finally {
        const point = z.object({ latitude: z.number(), longitude: z.number() }).parse(location);
        expect(await http(a.cookie, "PATCH", "/store/gospaza/addresses/" + a.addressId, {
          ...addressFields, location: { ...point, source: "manual" },
        }));
      }

      const nativeBefore = await carts.retrieveCart(a.cartId, { relations: ["shipping_methods"] });
      assert.equal(nativeBefore.shipping_methods?.length, 0, "hostile input must not reach native shipping attachment");
      for (const cookie of ["", a.cookie]) {
        for (const route of ["/store/payment-collections", "/store/payment-collections/pay_col_foreign/payment-sessions",
          "/store/carts/" + a.cartId + "/complete", "/store/carts/" + a.cartId + "/shipping-methods",
          "/hooks/payment/yoco_yoco", "/hooks/payment/pp_yoco_yoco"]) {
          expect(await http(cookie, "POST", route, { cart_id: a.cartId, provider_id: "pp_yoco_yoco" }), 404);
        }
      }

      const prepared = preparedSchema.parse(expect(await http(a.cookie, "POST", path + "/prepare", a.input)));
      assert.equal(prepared.attempt, null, "preparing a quote does not silently confirm or initiate payment");
      assert.equal(prepared.quote.expires_at, a.hold.selection.expires_at);
      const native = await carts.retrieveCart(a.cartId, {
        select: ["id", "total", "shipping_total"], relations: ["items", "shipping_methods"],
      });
      assert.equal(native.shipping_methods?.length, 1);
      assert.equal(prepared.quote.totals.total_minor, checkoutMoney(native.total));
      assert.equal(prepared.quote.totals.shipping_total_minor, checkoutMoney(native.shipping_total));
      await requireUnpaidCart(container, a.cartId);
      const repeated = preparedSchema.parse(expect(await http(a.cookie, "POST", path + "/prepare", a.input)));
      assert.deepEqual(repeated, prepared, "repeated preparation converges without duplicate shipping or renewed expiry");
      expect(await http(a.cookie, "POST", path + "/confirm", { ...a.input, checkout_revision: prepared.quote.checkout_revision }), 400);
      const confirms = await parallel([0, 1].map(() => http(a.cookie, "POST", path + "/confirm", {
        ...a.input, confirmed: true, checkout_revision: prepared.quote.checkout_revision,
      })));
      const confirmed = confirms.map((result) => preparedSchema.parse(expect(result)));
      const attempt = confirmed[0]?.attempt; assert.ok(attempt);
      assert.equal(confirmed[1]?.attempt?.id, attempt.id, "concurrent confirmations converge on one snapshot");
      const rows = await db<Attempt>("checkout_attempt").where({ medusa_cart_id: a.cartId }).whereNull("closed_at");
      assert.equal(rows.length, 1);
      const row = rows[0]; assert.ok(row);
      const snapshot = checkoutSnapshot.parse(row.snapshot);
      assert.equal(snapshot.customer_id, a.id);
      assert.equal(snapshot.merchant_id, first.merchantId);
      assert.equal(snapshot.merchant_store_id, first.store.id);
      assert.equal(snapshot.reservation_id, a.hold.selection.id);
      assert.equal(snapshot.shipping_method_id, native.shipping_methods?.[0]?.id);
      assert.equal(snapshot.shipping_option_id, native.shipping_methods?.[0]?.shipping_option_id);
      await assert.rejects(() => db("checkout_attempt").insert({ ...row, id: "chk_" + randomUUID() }),
        "database uniqueness independently enforces one active attempt");
      await assert.rejects(() => db("checkout_attempt").where({ id: row.id }).update({ snapshot: { ...snapshot, merchant_id: second.merchantId } }),
        "frozen snapshot cannot be overwritten");
      const restored = z.object({ attempt: attemptSchema }).parse(expect(await http(a.cookie, "GET", path + "?cart_id=" + a.cartId)));
      assert.deepEqual(restored.attempt, attempt);
      expect(await http(b.cookie, "GET", path + "/attempts/" + attempt.id + "?cart_id=" + b.cartId), 404);
      expect(await http(b.cookie, "POST", path + "/abandon", {
        cart_id: b.cartId, attempt_id: attempt.id, checkout_revision: attempt.quote.checkout_revision, confirmed: true,
      }), 404);
      const line = (await carts.retrieveCart(a.cartId, { relations: ["items"] })).items?.[0]; assert.ok(line);
      for (const mutation of [
        { method: "POST", route: "/store/gospaza/cart/items", body: { cart_id: a.cartId, variant_id: first.variantId, quantity: 1, location } },
        { method: "PATCH", route: "/store/gospaza/cart/items/" + line.id, body: { cart_id: a.cartId, quantity: 2, location } },
        { method: "DELETE", route: "/store/gospaza/cart/items/" + line.id, body: { cart_id: a.cartId } },
        { method: "POST", route: "/store/gospaza/cart/switch-store", body: { cart_id: a.cartId, variant_id: second.variantId, quantity: 1, location, confirm: true } },
      ]) {
        const blocked = expect(await http(a.cookie, mutation.method, mutation.route, mutation.body), 409);
        assert.equal(z.object({ code: z.string() }).parse(blocked).code, "CHECKOUT_FROZEN");
      }

      // A changed native amount requires a new explicit confirmation token.
      const changed = await customer("changed");
      const initial = preparedSchema.parse(expect(await http(changed.cookie, "POST", path + "/prepare", changed.input)));
      const changedLine = (await carts.retrieveCart(changed.cartId, { relations: ["items"] })).items?.[0]; assert.ok(changedLine);
      expect(await http(changed.cookie, "PATCH", "/store/gospaza/cart/items/" + changedLine.id,
        { cart_id: changed.cartId, quantity: 2, location }));
      const newer = preparedSchema.parse(expect(await http(changed.cookie, "POST", path + "/confirm", {
        ...changed.input, confirmed: true, checkout_revision: initial.quote.checkout_revision,
      }), 409));
      assert.equal(newer.reconfirmation_required, true);
      assert.equal(newer.attempt, null);
      assert.notEqual(newer.quote.totals.total_minor, initial.quote.totals.total_minor);
      assert.equal((await db("checkout_attempt").where({ medusa_cart_id: changed.cartId })).length, 0);
      const accepted = preparedSchema.parse(expect(await http(changed.cookie, "POST", path + "/confirm", {
        ...changed.input, confirmed: true, checkout_revision: newer.quote.checkout_revision,
      })));
      assert.ok(accepted.attempt);
      const abandonment = { cart_id: changed.cartId, attempt_id: accepted.attempt.id,
        checkout_revision: accepted.quote.checkout_revision, confirmed: true };
      expect(await http(changed.cookie, "POST", path + "/abandon", abandonment));
      expect(await http(changed.cookie, "POST", path + "/abandon", abandonment));
      expect(await http(changed.cookie, "PATCH", "/store/gospaza/cart/items/" + changedLine.id, { cart_id: changed.cartId, quantity: 1 }));

      // Real HTTP race: confirmation blocks mutation, or mutation forces a new quote.
      const race = await customer("race");
      const raceQuote = preparedSchema.parse(expect(await http(race.cookie, "POST", path + "/prepare", race.input)));
      const raceLine = (await carts.retrieveCart(race.cartId, { relations: ["items"] })).items?.[0]; assert.ok(raceLine);
      const raced = await parallel([
        http(race.cookie, "POST", path + "/confirm", { ...race.input, confirmed: true, checkout_revision: raceQuote.quote.checkout_revision }),
        http(race.cookie, "PATCH", "/store/gospaza/cart/items/" + raceLine.id, { cart_id: race.cartId, quantity: 2, location }),
      ]);
      assert.deepEqual(raced.map((result) => result.status).sort(), [200, 409], JSON.stringify(raced));
      const raceAttempts = await db<Attempt>("checkout_attempt").where({ medusa_cart_id: race.cartId }).whereNull("closed_at");
      const raceNative = await carts.retrieveCart(race.cartId, { relations: ["items"] });
      if (raced[0]?.status === 200) {
        assert.equal(raceAttempts.length, 1);
        assert.equal(Number(raceNative.items?.[0]?.quantity), 1);
      } else {
        assert.equal(raceAttempts.length, 0);
        assert.equal(Number(raceNative.items?.[0]?.quantity), 2);
      }


      // A simultaneous store switch either wins before confirmation, or is
      // blocked by the newly frozen snapshot. A superseded cart cannot freeze.
      const switchRace = await customer("switch-race");
      const switchQuote = preparedSchema.parse(expect(await http(switchRace.cookie, "POST", path + "/prepare", switchRace.input)));
      const switchOutcomes = await parallel([
        http(switchRace.cookie, "POST", path + "/confirm", {
          ...switchRace.input, confirmed: true, checkout_revision: switchQuote.quote.checkout_revision,
        }),
        http(switchRace.cookie, "POST", "/store/gospaza/cart/switch-store", {
          cart_id: switchRace.cartId, variant_id: second.variantId, quantity: 1, location, confirm: true,
        }),
      ]);
      const oldContext = await db<{ superseded_at: Date | null }>("cart_marketplace_context")
        .where({ medusa_cart_id: switchRace.cartId }).first();
      assert.ok(oldContext);
      const switchAttempts = await db<Attempt>("checkout_attempt")
        .where({ medusa_cart_id: switchRace.cartId }).whereNull("closed_at");
      if (switchOutcomes[0]?.status === 200) {
        assert.equal(switchOutcomes[1]?.status, 409, JSON.stringify(switchOutcomes));
        assert.equal(oldContext.superseded_at, null);
        assert.equal(switchAttempts.length, 1);
      } else {
        assert.equal(switchOutcomes[0]?.status, 404, JSON.stringify(switchOutcomes));
        assert.equal(switchOutcomes[1]?.status, 200, JSON.stringify(switchOutcomes));
        assert.ok(oldContext.superseded_at);
        assert.equal(switchAttempts.length, 0);
      }

      // Expiry is database-authoritative, with no sleep or browser timer involved.
      const expired = await customer("expired");
      await db("delivery_reservation").where({ id: expired.hold.selection.id }).update({
        created_at: db.raw("clock_timestamp() - interval '2 minutes'"),
        expires_at: db.raw("clock_timestamp() - interval '1 minute'"),
      });
      expect(await http(expired.cookie, "POST", path + "/prepare", expired.input), 409);
      await db("delivery_reservation").where({ id: a.hold.selection.id }).update({
        created_at: db.raw("clock_timestamp() - interval '2 minutes'"),
        expires_at: db.raw("clock_timestamp() - interval '1 minute'"),
      });
      assert.deepEqual(expect(await http(a.cookie, "GET", path + "?cart_id=" + a.cartId)), { attempt: null });
      const expiredAttempt = z.object({ attempt: attemptSchema }).parse(expect(await http(a.cookie, "GET",
        path + "/attempts/" + attempt.id + "?cart_id=" + a.cartId)));
      assert.equal(expiredAttempt.attempt.state, "EXPIRED");
      expect(await http(a.cookie, "DELETE", "/store/gospaza/cart/items/" + line.id, { cart_id: a.cartId }));

      const switched = await customer("superseded");
      expect(await http(switched.cookie, "POST", "/store/gospaza/cart/switch-store", {
        cart_id: switched.cartId, variant_id: second.variantId, quantity: 1, location, confirm: true,
      }));
      expect(await http(switched.cookie, "POST", path + "/prepare", switched.input), 404);

      // Snapshot publication fault after native work: recovery reconciles state
      // without a duplicate shipping method or a false successful confirmation.
      const fault = await customer("fault");
      const faultQuote = preparedSchema.parse(expect(await http(fault.cookie, "POST", path + "/prepare", fault.input)));
      assert.match(faultName, /^[a-z0-9_]+$/);
      assert.match(fault.cartId, /^[a-zA-Z0-9_]+$/);
      await db.raw(`create function ${faultName}() returns trigger language plpgsql as $$ begin
        if new.medusa_cart_id = '${fault.cartId}' then raise exception 'checkout fixture publication failure'; end if;
        return new; end; $$;
        create trigger ${faultName} before insert on checkout_attempt for each row execute function ${faultName}();`);
      faultInstalled = true;
      expect(await http(fault.cookie, "POST", path + "/confirm", {
        ...fault.input, confirmed: true, checkout_revision: faultQuote.quote.checkout_revision,
      }), 503);
      assert.equal((await db("checkout_attempt").where({ medusa_cart_id: fault.cartId })).length, 0);
      await db.raw(`drop trigger ${faultName} on checkout_attempt; drop function ${faultName}();`);
      faultInstalled = false;
      const recovered = preparedSchema.parse(expect(await http(fault.cookie, "POST", path + "/prepare", fault.input)));
      expect(await http(fault.cookie, "POST", path + "/confirm", {
        ...fault.input, confirmed: true, checkout_revision: recovered.quote.checkout_revision,
      }));
      assert.equal((await carts.retrieveCart(fault.cartId, { relations: ["shipping_methods"] })).shipping_methods?.length, 1);
      await requireUnpaidCart(container, fault.cartId);

      // Later tariffs invalidate future preparation, never rewrite confirmation.
      const frozen = await db<Attempt>("checkout_attempt").where({ medusa_cart_id: fault.cartId }).first(); assert.ok(frozen);

      const assignment = await db<{ service_zone_id: string }>("merchant_store_service_zone")
        .where({ merchant_store_id: first.store.id }).first(); assert.ok(assignment);
      const locations = new LocationService(container);
      const { zone } = await locations.zone(assignment.service_zone_id);
      const { id: zoneId, ...tariff } = zone;
      await locations.save({ ...tariff, delivery_fee_minor: tariff.delivery_fee_minor + 100 }, zoneId, prefix);
      assert.deepEqual((await db<Attempt>("checkout_attempt").where({ id: frozen.id }).first())?.snapshot, frozen.snapshot);
      expect(await http(b.cookie, "POST", path + "/prepare", b.input), 409);
      expect(await http(fault.cookie, "DELETE", "/store/gospaza/cart/delivery-selection", {
        cart_id: fault.cartId, reservation_id: fault.hold.selection.id, expected_revision: fault.hold.revision,
      }));
      assert.deepEqual(expect(await http(fault.cookie, "GET", path + "?cart_id=" + fault.cartId)), { attempt: null },
        "M9 release needs no location and ends only the unpaid C confirmation");
      const releasedLine = (await carts.retrieveCart(fault.cartId, { relations: ["items"] })).items?.[0];
      assert.ok(releasedLine);
      expect(await http(fault.cookie, "DELETE", "/store/gospaza/cart/items/" + releasedLine.id, { cart_id: fault.cartId }));

    }
  } catch (error) { failures.push(error); }

  if (faultInstalled) {
    try { await db.raw(`drop trigger ${faultName} on checkout_attempt; drop function ${faultName}();`); }
    catch (error) { failures.push(error); }
  }
  for (const address of addresses) {
    try { expect(await http(address.cookie, "DELETE", "/store/gospaza/addresses/" + address.id)); }
    catch (error) { failures.push(new Error("M10-C address cleanup failed: " + prefix, { cause: error })); }
  }
  try {
    const contexts = await db<{ id: string }>("cart_marketplace_context").whereIn("merchant_store_id", stores);
    await db("checkout_attempt").whereIn("cart_context_id", contexts.map((context) => context.id)).delete();
    const options = await db<{ id: string }>("delivery_option_configuration").whereIn("merchant_store_id", stores);
    for (const option of options) {
      const native = await fulfillment.listShippingOptions({ name: "gospaza:" + option.id }, { take: null });
      if (native.length) await deleteShippingOptionsWorkflow(container).run({ input: { ids: native.map((item) => item.id) } });
    }
    await db.transaction(async (trx) => {
      await trx("delivery_reservation").whereIn("merchant_store_id", stores).delete();
      await trx("delivery_slot").whereIn("merchant_store_id", stores).delete();
      await trx("delivery_option_configuration").whereIn("merchant_store_id", stores).delete();
      await trx("store_delivery_policy").whereIn("merchant_store_id", stores).delete();
      await trx("scheduling_event").where({ platform_user_id: prefix }).delete();
    });
  } catch (error) { failures.push(new Error("M10-C fixture cleanup failed: " + prefix, { cause: error })); }
  if (failures.length) throw new AggregateError(failures, "M10-C checkout foundation verification failed.");
}

export async function withCheckoutVerification(
  args: ExecArgs, extension: (fixture: CheckoutVerificationFixture) => Promise<void>,
) {
  await verifyCartFoundation(args, (fixture) => verify(fixture, extension));
}

export default async function verifyCheckoutFoundation(args: ExecArgs) {
  await verifyCartFoundation(args, verify);
  console.log("M10-C passed: owned checkout, native shipping/totals, reconfirmation, immutable snapshots, concurrent freeze and bypass protection.");
}
