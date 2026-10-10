import assert from "node:assert/strict";
import type { ExecArgs, IPaymentModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Link } from "@medusajs/framework/modules-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { withCheckoutVerification } from "./verify-checkout-foundation";
import type { CheckoutVerificationCustomer } from "./verify-checkout-foundation";
import { cartOperation } from "../lib/cart-lock";
import { PaymentInitiationService } from "../lib/payment-initiation-service";
import { establishPaymentCollection, linkedCollection } from "../lib/payment-native";
import { paymentDeadlineMinutes, yocoConfiguration, YOCO_PROVIDER_ID } from "../lib/yoco-config";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import { checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import { SchedulingService } from "../lib/scheduling-service";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import { databaseTime, occupied, lockSlots } from "../modules/marketplace/delivery-reservation-repository";
import { nativePrice } from "../modules/marketplace/catalogue-policy";
import { requestSchema } from "../modules/yoco/request";
import type { CheckoutReceipt } from "../modules/yoco/types";
import { DeliveryReservationService } from "../lib/delivery-reservation-service";
import { LocationService } from "../lib/location-service";

const confirmation = z.object({
  attempt: z.object({ id: z.string() }),
  quote: z.object({ checkout_revision: z.string() }),
});
const quote = z.object({ quote: z.object({ checkout_revision: z.string() }) });

export default async function verifyPaymentInitiation(args: ExecArgs) {
  const configuration = yocoConfiguration(process.env);
  if (!configuration) {
    throw new Error("Payment initiation verification requires YOCO_ENABLED=true and valid test-mode Yoco configuration.");
  }
  assert.ok(configuration.secretKey.startsWith("sk_test_"), "Enable the test-mode Yoco provider before this verifier. Live keys are forbidden.");
  assert.ok(["development", "test"].includes(process.env.APP_ENV ?? ""));
  const originalFetch = globalThis.fetch;
  const external = new Map<string, { body: string; receipt: CheckoutReceipt }>();
  const posts: { key: string; body: string }[] = [];
  let loseNextResponse = false;
  // Only the external transport is substituted. All native resources, custom
  // constraints, advisory locks, sessions and captures use the real database.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://payments.yoco.com") return originalFetch(input, init);
    assert.equal(url.pathname, "/api/checkouts", "This slice must not send refunds or other provider operations.");
    assert.equal(init?.method, "POST");
    const key = new Headers(init?.headers).get("Idempotency-Key");
    assert.ok(key);
    const body = String(init?.body);
    const parsed = requestSchema.parse(JSON.parse(body));
    posts.push({ key, body });
    const previous = external.get(key);
    if (previous && previous.body !== body) return new Response("mismatch", { status: 422 });
    const receipt: CheckoutReceipt = previous?.receipt ?? {
      id: "ch_" + parsed.externalId, status: "created", amount: parsed.amount, currency: "ZAR",
      processingMode: "test", redirectUrl: "https://c.yoco.com/checkout/" + parsed.externalId,
    };
    external.set(key, { body, receipt });
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new Error("Fixture: external checkout exists but initiation response was lost.");
    }
    return Response.json(receipt);
  };

  try {
    await withCheckoutVerification(args, async ({ prefix, fixture, customer, http, expect }) => {
      const { container, first, second } = fixture;
      const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
      const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
      const operations = new PgYocoOperationStore(db);
      const attemptIds: string[] = [];
      const fixtureCollections = new Set<string>();
      const failures: unknown[] = [];
      const path = "/store/gospaza/checkout";
      async function confirmed(person: CheckoutVerificationCustomer) {
        const prepared = quote.parse(expect(await http(person.cookie, "POST", path + "/prepare", person.input)));
        const frozen = confirmation.parse(expect(await http(person.cookie, "POST", path + "/confirm", {
          ...person.input, confirmed: true, checkout_revision: prepared.quote.checkout_revision,
        })));
        attemptIds.push(frozen.attempt.id);
        return { cart_id: person.cartId, attempt_id: frozen.attempt.id,
          checkout_revision: frozen.quote.checkout_revision, confirmed: true as const };
      }
      async function row(attemptId: string) {
        const found = await db<OperationRow>("provider_operation").where({ checkout_attempt_id: attemptId }).first();
        assert.ok(found);
        return found;
      }
      try {
        const a = await customer("payment-double");
        const input = await confirmed(a);
        const service = () => new PaymentInitiationService(container, a.id);
        for (const suffix of ["/pay", "/retry"]) {
          expect(await http("", "POST", path + suffix, input), 401);
          for (const key of ["customer_id", "merchant_id", "store_id", "operation_id", "session_id",
            "payment_collection_id", "amount", "currency", "redirect_url"]) {
            expect(await http(a.cookie, "POST", path + suffix, { ...input, [key]: "forged" }), 400);
          }
        }
        const stranger = await customer("payment-foreign", second.variantId);
        const foreignInput = await confirmed(stranger);
        expect(await http(stranger.cookie, "POST", path + "/pay", input), 404);
        expect(await http(stranger.cookie, "POST", path + "/pay", { ...foreignInput, attempt_id: input.attempt_id }), 404);
        for (const nativePath of ["/store/payment-collections", "/store/payment-collections/known/payment-sessions",
          "/store/carts/" + a.cartId + "/complete", "/hooks/payment/yoco_yoco"]) {
          expect(await http(a.cookie, "POST", nativePath, { cart_id: a.cartId, provider_id: YOCO_PROVIDER_ID }), 404);
        }

        const [firstPay, secondPay, mutation, switchStore] = await Promise.all([
          service().initiate(input), service().initiate(input),
          http(a.cookie, "POST", "/store/gospaza/cart/items", {
            cart_id: a.cartId, variant_id: first.variantId, quantity: 1, location: fixture.location,
          }),
          http(a.cookie, "POST", "/store/gospaza/cart/switch-store", {
            cart_id: a.cartId, variant_id: second.variantId, quantity: 1, location: fixture.location, confirm: true,
          }),
        ]);
        expect(mutation, 409);
        expect(switchStore, 409);
        const bound = await db<{ medusa_cart_id: string; merchant_store_id: string }>("cart_marketplace_context")
          .where({ medusa_cart_id: a.cartId }).whereNull("superseded_at").first();
        assert.equal(bound?.merchant_store_id, first.store.id, "Pay/switch race retains the confirmed store/cart");
        const results = [firstPay, secondPay];
        assert.equal(results[0]?.state, "ready");
        assert.deepEqual(results[0], results[1]);
        const op = await row(input.attempt_id);
        assert.equal(posts.filter((post) => post.key === op.idempotency_key).length, 1);
        assert.equal((await db("provider_operation").where({ checkout_attempt_id: input.attempt_id })).length, 1);
        assert.equal((await db("provider_session").where({ operation_id: op.id })).length, 1);
        const frozen = await db<Attempt>("checkout_attempt").where({ id: input.attempt_id }).first();
        assert.ok(frozen?.payment_deadline);
        assert.equal(frozen.state, "PAYMENT_PENDING");
        assert.equal(new Date(frozen.expires_at).toISOString(), a.hold.selection.expires_at);
        assert.ok(new Date(frozen.payment_deadline).getTime() <= Date.now() + paymentDeadlineMinutes(process.env) * 60000);
        const restored = z.object({ attempt: z.object({ state: z.literal("PAYMENT_PENDING"), payment_deadline: z.string() }) })
          .parse(expect(await http(a.cookie, "GET", path + "?cart_id=" + a.cartId)));
        assert.equal(restored.attempt.payment_deadline, results[0]?.payment_deadline);
        expect(await http(a.cookie, "POST", "/store/payment-collections/" + op.payment_collection_id + "/payment-sessions",
          { provider_id: YOCO_PROVIDER_ID, data: { operation_id: op.id } }), 404);
        const replay = await service().initiate(input, true);
        assert.deepEqual(replay, results[0], "restoration/retry cannot renew payment expiry");
        await assert.rejects(() => db("provider_operation").where({ id: op.id }).update({ idempotency_key: "different" }));
        await assert.rejects(() => db("provider_operation").where({ id: op.id }).update({ request_json: "{}" }));
        await assert.rejects(() => db("checkout_attempt").where({ id: frozen.id }).update({ payment_deadline: db.raw("clock_timestamp() + interval '1 day'") }));
        await assert.rejects(() => db("provider_session").where({ operation_id: op.id }).update({ native_session_id: "forged" }));
        await assert.rejects(() => db("delivery_reservation").where({ id: a.hold.selection.id })
          .update({ payment_deadline: db.raw("clock_timestamp() + interval '1 day'") }));

        // Original HELD expiry is no longer the capacity clock.
        await db("delivery_reservation").where({ id: a.hold.selection.id }).update({
          created_at: db.raw("clock_timestamp() - interval '2 minutes'"),
          expires_at: db.raw("clock_timestamp() - interval '1 minute'"),
        });
        const hold = await db<{ delivery_slot_id: string; cart_context_id: string }>("delivery_reservation").where({ id: a.hold.selection.id }).first();
        assert.ok(hold);
        const count = await db.transaction(async (trx) => {
          await lockSlots(trx, [hold.delivery_slot_id]);
          const now = await databaseTime(trx);
          return await occupied(trx, hold.delivery_slot_id, now)
            - await occupied(trx, hold.delivery_slot_id, now, hold.cart_context_id);
        });
        assert.equal(count, 1, "this payment commitment consumes capacity past HELD expiry");
        assert.equal((await service().initiate(input)).state, "ready");
        const delivery = new DeliveryReservationService(container, a.id);
        await assert.rejects(() => delivery.release({
          cart_id: a.cartId, expected_revision: a.hold.revision + 1,
        }), /CHECKOUT_FROZEN/);
        const pendingRestore = await delivery.restore({ cart_id: a.cartId });
        assert.equal(pendingRestore.selection?.expires_at, results[0]?.payment_deadline);
        expect(await http(a.cookie, "POST", "/store/gospaza/cart/switch-store", {
          cart_id: a.cartId, variant_id: second.variantId, quantity: 1, location: fixture.location, confirm: true,
        }), 409);

        // Real native failure cleanup removes the first payses; history survives.
        const lost = await customer("payment-lost");
        const lostInput = await confirmed(lost);
        const lostService = () => new PaymentInitiationService(container, lost.id);
        loseNextResponse = true;
        assert.equal((await lostService().initiate(lostInput)).state, "uncertain");
        const uncertain = await row(lostInput.attempt_id);
        assert.equal(uncertain.state, "uncertain");
        assert.ok(uncertain.payment_collection_id);
        assert.equal((await payments.listPaymentSessions({ payment_collection_id: uncertain.payment_collection_id })).length, 0);
        const oldAssociations = await db<{ native_session_id: string }>("provider_session").where({ operation_id: uncertain.id });
        assert.equal(oldAssociations.length, 1);
        const originalSession = oldAssociations[0]?.native_session_id;
        assert.ok(originalSession);
        const externalBefore = external.size;
        const recovered = await Promise.all([lostService().initiate(lostInput, true), lostService().initiate(lostInput, true)]);
        assert.ok(recovered.every((result) => result.state === "ready"));
        assert.equal(external.size, externalBefore, "recovery cannot create a second payable checkout");
        const sent = posts.filter((post) => post.key === uncertain.idempotency_key);
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[0], sent[1]);
        const current = await operations.read(uncertain.id);
        assert.ok(current?.canonicalSessionId);
        assert.ok(current.sessionIds.includes(originalSession));
        assert.notEqual(current.canonicalSessionId, originalSession);
        assert.equal(current.requestJson, uncertain.request_json);
        const canonical = await payments.retrievePaymentSession(current.canonicalSessionId);
        assert.equal(canonical.data?.session_id, canonical.id);

        // Native compensation cannot use copied provider data to create a new
        // payable session: its consumed local permit must fail before transport.
        const beforeCompensation = posts.length;
        await assert.rejects(() => payments.createPaymentSession(uncertain.payment_collection_id ?? "", {
          provider_id: YOCO_PROVIDER_ID, currency_code: "zar", amount: nativePrice(Number(uncertain.amount_minor)),
          data: canonical.data,
        }));
        assert.equal(posts.length, beforeCompensation);

        // Trusted fixture evidence only, not a webhook implementation. This
        // proves native reconstruction/materialization needed by E without
        // an external charge/refund, Order, or reconciliation endpoint.
        assert.ok(current.checkout);
        await db("provider_operation").where({ id: uncertain.id }).update({
          verified_payment: {
            id: "evt_" + uncertain.id, type: "payment.succeeded", paymentId: "pay_yoco_" + uncertain.id,
            checkoutId: current.checkout.id, operationId: uncertain.id, amount: Number(uncertain.amount_minor),
            currency: "ZAR", mode: "test",
          },
        });
        const token = await operations.permitSession(uncertain.id, false);
        const reconstructed = await payments.createPaymentSession(uncertain.payment_collection_id, {
          provider_id: YOCO_PROVIDER_ID, currency_code: "zar", amount: nativePrice(Number(uncertain.amount_minor)),
          data: { operation_id: uncertain.id, session_token: token },
        });
        assert.equal(posts.length, beforeCompensation, "captured evidence reconstruction must not POST a checkout");
        await operations.selectCanonical(uncertain.id, reconstructed.id);
        await assert.rejects(() => payments.authorizePaymentSession(canonical.id, {}));
        const authorizations = await Promise.allSettled([
          payments.authorizePaymentSession(reconstructed.id, {}),
          payments.authorizePaymentSession(reconstructed.id, {}),
        ]);
        assert.ok(authorizations.some((result) => result.status === "fulfilled"));
        const financial = await payments.retrievePaymentCollection(uncertain.payment_collection_id, {
          relations: ["payments", "payments.captures"],
        });
        assert.equal(financial.payments?.length, 1);
        assert.equal(financial.payments?.[0]?.captures?.length, 1);
        await assert.rejects(() => operations.selectCanonical(uncertain.id, canonical.id));
        await db("provider_operation").where({ id: uncertain.id }).update({ terminal_refunded: true });
        await assert.rejects(() => payments.createPaymentSession(uncertain.payment_collection_id ?? "", {
          provider_id: YOCO_PROVIDER_ID, currency_code: "zar", amount: nativePrice(Number(uncertain.amount_minor)),
          data: canonical.data,
        }));
        assert.equal(posts.length, beforeCompensation);

        // Confirmed commercial amounts survive later tariff changes. Geography
        // remains authoritative; only price/config defaults apply to later attempts.
        const tariffCustomer = await customer("payment-tariff");
        const tariffInput = await confirmed(tariffCustomer);
        const assignment = await db<{ service_zone_id: string }>("merchant_store_service_zone")
          .where({ merchant_store_id: first.store.id }).first();
        assert.ok(assignment);
        const locationService = new LocationService(container);
        const { zone } = await locationService.zone(assignment.service_zone_id);
        const { id: zoneId, ...tariff } = zone;
        await locationService.save({ ...tariff, delivery_fee_minor: tariff.delivery_fee_minor + 100 }, zoneId, prefix);
        try {
          assert.equal((await new PaymentInitiationService(container, tariffCustomer.id).initiate(tariffInput)).state, "ready");
          const tariffOperation = await row(tariffInput.attempt_id);
          const tariffAttempt = await db<Attempt>("checkout_attempt").where({ id: tariffInput.attempt_id }).first();
          assert.ok(tariffAttempt);
          assert.equal(Number(tariffOperation.amount_minor), checkoutSnapshot.parse(tariffAttempt.snapshot).totals.total_minor);
        } finally {
          await locationService.save(tariff, zoneId, prefix);
          await new SchedulingService(container).synchronize(first.store.id, prefix, "Restore fixture tariff");
          await new SchedulingService(container).synchronize(second.store.id, prefix, "Restore fixture tariff");
        }


        // Gate the real customer lock and expire the HELD fixture while Pay is
        // waiting. This makes the after-lock time check deterministic without sleep.
        const waiting = await customer("payment-waiting-expiry");
        const waitingInput = await confirmed(waiting);
        let signalLocked: () => void = () => { throw new Error("Lock gate was not initialized."); };
        let releaseLock: () => void = () => { throw new Error("Lock gate was not initialized."); };
        const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
        const unlock = new Promise<void>((resolve) => { releaseLock = resolve; });
        const holder = cartOperation(container, waiting.id, async () => { signalLocked(); await unlock; });
        await Promise.race([locked, holder.then(() => { throw new Error("Lock gate ended unexpectedly."); })]);
        const waitingPay = new PaymentInitiationService(container, waiting.id).initiate(waitingInput);
        const waitingOutcome = Promise.allSettled([waitingPay]);
        try {
          await db.transaction(async (trx) => {
            const hold = await trx<{ delivery_slot_id: string }>("delivery_reservation")
              .where({ id: waiting.hold.selection.id }).first();
            assert.ok(hold);
            await lockSlots(trx, [hold.delivery_slot_id]);
            await trx("delivery_reservation").where({ id: waiting.hold.selection.id }).update({
              created_at: trx.raw("clock_timestamp() - interval '2 minutes'"),
              expires_at: trx.raw("clock_timestamp() - interval '1 minute'"),
            });
          });
        } finally {
          releaseLock();
          await holder;
          await waitingOutcome;
        }
        const [outcome] = await waitingOutcome;
        assert.equal(outcome?.status, "fulfilled");
        if (outcome?.status === "fulfilled") assert.equal(outcome.value.state, "expired");
        assert.equal((await db("provider_operation").where({ checkout_attempt_id: waitingInput.attempt_id })).length, 0);

        // A past-deadline fixture is established before it is read. No clock
        // sleeps, expiry renewal, or disabling production immutability triggers.
        const expired = await customer("payment-expired");
        const expiredInput = await confirmed(expired);
        await db.transaction(async (trx) => {
          const now = await databaseTime(trx);
          const deadline = new Date(now.getTime() - 1000);
          const [past] = await trx<Attempt>("checkout_attempt").where({ id: expiredInput.attempt_id })
            .update({ state: "PAYMENT_PENDING", payment_deadline: deadline }).returning("*");
          assert.ok(past);
          await trx("delivery_reservation").where({ id: expired.hold.selection.id })
            .update({ status: "PAYMENT_PENDING", payment_deadline: deadline });
          await operations.prepare(trx, past, configuration);
        });
        const old = await row(expiredInput.attempt_id);
        // Simulate native creation completing before its locator was saved.
        // Recovery must adopt the native metadata marker, not create again.
        const orphanCollection = await payments.createPaymentCollections({
          amount: nativePrice(Number(old.amount_minor)), currency_code: "zar",
          metadata: { gospaza_operation_id: old.id },
        });
        fixtureCollections.add(orphanCollection.id);
        const oldCollection = await establishPaymentCollection(container, old, expired.cartId);
        assert.equal(oldCollection.id, orphanCollection.id);
        assert.equal((await payments.listPaymentCollections({}, { take: null }))
          .filter((collection) => collection.metadata?.gospaza_operation_id === old.id).length, 1);
        const priorPosts = posts.length;
        const expiredResult = await new PaymentInitiationService(container, expired.id).initiate(expiredInput, true);
        assert.equal(expiredResult.state, "expired");
        assert.equal(expiredResult.redirect_url, null);
        assert.equal(posts.length, priorPosts);
        const ended = await db<Attempt>("checkout_attempt").where({ id: expiredInput.attempt_id }).first();
        assert.equal(ended?.state, "EXPIRED");
        const released = await db<{ status: string }>("delivery_reservation").where({ id: expired.hold.selection.id }).first();
        assert.equal(released?.status, "EXPIRED");
        await assert.rejects(() => operations.permitSession(old.id, true));

        // Late trusted fixture evidence can reconstruct native resources for
        // future compensation, but it cannot reopen the expired attempt.
        await db("provider_operation").where({ id: old.id }).update({
          checkout_id: "ch_late_" + old.id,
          verified_payment: {
            id: "evt_late_" + old.id, type: "payment.succeeded", paymentId: "pay_late_" + old.id,
            checkoutId: "ch_late_" + old.id, operationId: old.id, amount: Number(old.amount_minor),
            currency: "ZAR", mode: "test",
          },
        });
        const historicalPermit = await operations.permitSession(old.id, false);
        const historicalSession = await payments.createPaymentSession(oldCollection.id, {
          provider_id: YOCO_PROVIDER_ID, currency_code: "zar", amount: nativePrice(Number(old.amount_minor)),
          data: { operation_id: old.id, session_token: historicalPermit },
        });
        await operations.selectCanonical(old.id, historicalSession.id);
        assert.equal(posts.length, priorPosts, "late capture reconstruction cannot create a checkout");


        const available = z.object({
          revision: z.number(), options: z.array(z.object({ id: z.string(), mode: z.string(), revision: z.number() })),
          slots: z.array(z.object({ id: z.string() })),
        }).parse(expect(await http(expired.cookie, "POST", "/store/gospaza/cart/delivery-options", {
          cart_id: expired.cartId, location: { address_id: expired.addressId },
        })));
        const option = available.options.find((value) => value.mode === "SCHEDULED");
        const slot = available.slots[0]; assert.ok(option && slot);
        const replacementHold = z.object({ revision: z.number() }).parse(expect(await http(expired.cookie, "PUT",
          "/store/gospaza/cart/delivery-selection", {
            cart_id: expired.cartId, location: { address_id: expired.addressId }, option_id: option.id,
            slot_id: slot.id, expected_option_revision: option.revision, expected_revision: available.revision,
          })));
        const later = await confirmed({ ...expired, input: { ...expired.input, expected_reservation_revision: replacementHold.revision } });
        assert.equal(await linkedCollection(container, expired.cartId), null, "preparation detaches historical payment resources");
        const laterResult = await new PaymentInitiationService(container, expired.id).initiate(later);
        assert.equal(laterResult.state, "ready");
        const laterOp = await row(later.attempt_id);
        assert.notEqual(laterOp.id, old.id);
        assert.notEqual(laterOp.payment_collection_id, oldCollection.id);
        assert.equal((await payments.retrievePaymentCollection(oldCollection.id)).id, oldCollection.id);
        assert.equal((await operations.row(old.id)).payment_collection_id, oldCollection.id);
        assert.equal((await payments.retrievePaymentSession(historicalSession.id)).payment_collection_id, oldCollection.id);
        assert.ok((await operations.read(old.id))?.sessionIds.includes(historicalSession.id));
        assert.equal((await new PaymentInitiationService(container, expired.id).initiate(expiredInput, true)).state, "expired");
        assert.equal(await linkedCollection(container, expired.cartId), laterOp.payment_collection_id);
      } catch (error) { failures.push(error); }

      // Delete only this callback's known fixture resources. Public native APIs
      // own native cleanup; deferred custom FKs permit atomic fixture removal.
      const rows = await db<OperationRow>("provider_operation").whereIn("checkout_attempt_id", attemptIds);
      for (const row of rows) if (row.payment_collection_id) fixtureCollections.add(row.payment_collection_id);
      for (const collectionId of fixtureCollections) {
        try {
          const row = rows.find((candidate) => candidate.payment_collection_id === collectionId);
          const attempt = row ? await db<Attempt>("checkout_attempt").where({ id: row.checkout_attempt_id }).first() : undefined;
          if (attempt && await linkedCollection(container, attempt.medusa_cart_id) === collectionId) {
            await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({
              [Modules.CART]: { cart_id: attempt.medusa_cart_id },
              [Modules.PAYMENT]: { payment_collection_id: collectionId },
            });
          }
          await payments.deletePaymentCollections(collectionId);
        } catch (error) { failures.push(error); }
      }
      try {
        await db.transaction(async (trx) => {
          await trx("provider_session").whereIn("operation_id", rows.map((row) => row.id)).delete();
          await trx("provider_operation").whereIn("id", rows.map((row) => row.id)).delete();
        });
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "M10-D payment initiation verification failed.");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("M10-D passed: durable initiation, capacity deadline, native replacement/correlation, canonical financial session and historical attempt isolation. No external payment/refund was sent.");
}
