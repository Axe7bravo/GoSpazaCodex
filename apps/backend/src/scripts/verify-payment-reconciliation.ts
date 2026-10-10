import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "@medusajs/framework/zod";
import type { ExecArgs, IOrderModuleService, IPaymentModuleService, IInventoryService, IWorkflowEngineService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Link } from "@medusajs/framework/modules-sdk";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { withCheckoutVerification } from "./verify-checkout-foundation";
import type { CheckoutVerificationCustomer } from "./verify-checkout-foundation";
import { inspectCompletion } from "../lib/completion-native";
import { CartFoundationService } from "../lib/cart-service";
import { PaymentInitiationService } from "../lib/payment-initiation-service";
import { PaymentReconciliationService } from "../lib/payment-reconciliation-service";
import { yocoConfiguration, reconciliationWorkerEnabled } from "../lib/yoco-config";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import type { CompletionRow, InboxRow, CompensationRow } from "../modules/marketplace/reconciliation-types";
import { claimCompletion, designateCompletion } from "../modules/marketplace/completion-repository";
import { currentCheckout, assertCheckoutMutable } from "../modules/marketplace/checkout-repository";
import { databaseTime, lockSlots, occupied, releaseContextHold } from "../modules/marketplace/delivery-reservation-repository";
import { cartOperation } from "../lib/cart-lock";
import { establishPaymentCollection, establishPaymentSession, linkedCollection } from "../lib/payment-native";
import { requestSchema } from "../modules/yoco/request";
import { DeliveryReservationService } from "../lib/delivery-reservation-service";
import RegisteredYocoPaymentService from "../modules/yoco/registered-service";

const prepared = z.object({ quote: z.object({ checkout_revision: z.string() }) });
const confirmed = prepared.extend({ attempt: z.object({ id: z.string() }) });

export default async function verifyPaymentReconciliation(args: ExecArgs) {
  const loadedConfig = yocoConfiguration(process.env);
  if (!loadedConfig || !loadedConfig.secretKey.startsWith("sk_test_") || !["development", "test"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("M10-E verification requires local test-mode Yoco configuration.");
  }
  const config = loadedConfig;
  if (reconciliationWorkerEnabled(process.env)) throw new Error("Set PAYMENT_RECONCILIATION_WORKER_ENABLED=false in both local backend and verifier; restart backend before verification.");
  const base = new URL(process.env.BACKEND_URL ?? "");
  assert.ok(["localhost", "127.0.0.1"].includes(base.hostname));
  const originalFetch = globalThis.fetch;
  const sent = new Map<string, { body: string; receipt: object }>();
  const refundPosts: { key: string; body: string }[] = [];
  let pendingRefund = false;
  let checkoutPosts = 0;
  let beforeCheckoutResponse: ((operationId: string) => Promise<void>) | undefined;
  let loseRefundResponse = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://payments.yoco.com") return originalFetch(input, init);
    assert.equal(init?.method, "POST");
    const key = new Headers(init?.headers).get("Idempotency-Key"); assert.ok(key);
    const body = String(init?.body);
    if (url.pathname === "/api/checkouts") checkoutPosts++;
    const previous = sent.get(key);
    if (previous) { assert.equal(previous.body, body); return Response.json(previous.receipt); }
    let receipt: object;
    if (url.pathname === "/api/checkouts") {
      const request = requestSchema.parse(JSON.parse(body));
      receipt = { id: "ch_" + request.externalId, redirectUrl: "https://c.yoco.com/checkout/" + request.externalId,
        amount: request.amount, currency: "ZAR", status: "created", processingMode: "test" };
    } else {
      assert.match(url.pathname, /^\/api\/checkouts\/[^/]+\/refund$/);
      refundPosts.push({ key, body });
      receipt = { id: url.pathname.split("/")[3], refundId: "ref_" + key, status: pendingRefund ? "pending" : "succeeded" };
    }
    sent.set(key, { body, receipt });
    if (url.pathname === "/api/checkouts" && beforeCheckoutResponse) {
      const beforeResponse = beforeCheckoutResponse;
      beforeCheckoutResponse = undefined;
      await beforeResponse(requestSchema.parse(JSON.parse(body)).externalId);
    }
    if (url.pathname.endsWith("/refund") && loseRefundResponse) {
      loseRefundResponse = false;
      throw new Error("Fixture: refund succeeded but its response was lost.");
    }
    return Response.json(receipt);
  };
  try {
    await withCheckoutVerification(args, async ({ fixture, customer, http, expect }) => {
      const { container } = fixture;
      const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
      const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
      const orders = container.resolve<IOrderModuleService>(Modules.ORDER);
      const engine = container.resolve<IWorkflowEngineService>(Modules.WORKFLOW_ENGINE);
      const operations = new PgYocoOperationStore(db);
      const service = new PaymentReconciliationService(container);
      const attempts: string[] = [], eventIds: string[] = [], people: string[] = [];
      const failures: unknown[] = [];
      async function prepare(person: CheckoutVerificationCustomer, initiate = true) {
        people.push(person.id);
        const quote = prepared.parse(expect(await http(person.cookie, "POST", "/store/gospaza/checkout/prepare", person.input)));
        const result = confirmed.parse(expect(await http(person.cookie, "POST", "/store/gospaza/checkout/confirm", {
          ...person.input, confirmed: true, checkout_revision: quote.quote.checkout_revision,
        })));
        attempts.push(result.attempt.id);
        const input = { cart_id: person.cartId, attempt_id: result.attempt.id, checkout_revision: result.quote.checkout_revision, confirmed: true as const };
        if (initiate) assert.equal((await new PaymentInitiationService(container, person.id).initiate(input)).state, "ready");
        return input;
      }
      async function operation(attemptId: string) {
        const row = await db<OperationRow>("provider_operation").where({ checkout_attempt_id: attemptId }).first(); assert.ok(row); return row;
      }
      function event(op: OperationRow, type = "payment.succeeded") {
        const id = "event_" + randomUUID(); eventIds.push(id);
        return { id, type, payload: { id: "yp_" + op.id, type: "payment", status: type.endsWith("succeeded") ? "succeeded" : "failed",
          amount: Number(op.amount_minor), currency: "ZAR", mode: "test", metadata: { operation_id: op.id, checkoutId: op.checkout_id ?? "ch_" + op.id } } };
      }
      function signed(body: unknown, seconds = String(Math.floor(Date.now() / 1000))) {
        const rawData = JSON.stringify(body);
        const signature = createHmac("sha256", Buffer.from(config.webhookSecret.slice(6), "base64"))
          .update("delivery_test." + seconds + "." + rawData).digest("base64");
        return { data: {}, rawData, headers: { "webhook-id": "delivery_test", "webhook-timestamp": seconds, "webhook-signature": "v1," + signature } };
      }
      async function apply(body: { id: string }) {
        await service.receive(signed(body));
        const inbox = await db<InboxRow>("yoco_inbox").where({ event_id: body.id }).first(); assert.ok(inbox);
        await service.applyInbox(inbox.id);
        return inbox;
      }
      async function expiredOperation(suffix: string) {
        const person = await customer(suffix), input = await prepare(person, false);
        await db.transaction(async (trx) => {
          const deadline = new Date((await databaseTime(trx)).getTime() - 1000);
          const [past] = await trx<Attempt>("checkout_attempt").where({ id: input.attempt_id })
            .update({ state: "PAYMENT_PENDING", payment_deadline: deadline }).returning("*"); assert.ok(past);
          await trx("delivery_reservation").where({ id: person.hold.selection.id }).update({ status: "PAYMENT_PENDING", payment_deadline: deadline });
          await operations.prepare(trx, past, config);
        });
        const row = await operation(input.attempt_id);
        await establishPaymentCollection(container, row, person.cartId);
        return { person, input, row };
      }
      async function customerStatus(cookie: string, attemptId: string) {
        const result = expect(await http(cookie, "GET", "/store/gospaza/checkout/status?attempt_id=" + encodeURIComponent(attemptId)));
        const parsed = z.object({ state: z.string(), order_id: z.string().nullable(),
          attempt: z.object({ id: z.string() }).nullable() }).parse(result);
        const serialized = JSON.stringify(result);
        for (const forbidden of ["operation_id", "transaction_id", "run_id", "idempotency_key", "verified_payment", "recovery_reason", "payment_collection_id", "payment_session_id"]) {
          assert.equal(serialized.includes('"' + forbidden + '"'), false, "customer status excludes " + forbidden);
        }
        return parsed;
      }
      try {
        const a = await customer("reconcile-success"), input = await prepare(a), op = await operation(input.attempt_id);
        const success = event(op), payload = signed(success);
        const invalid = await originalFetch(new URL("/hooks/gospaza/yoco", base), { method: "POST",
          headers: { "Content-Type": "application/json", ...payload.headers }, body: "{}" });
        assert.equal(invalid.status, 400);
        assert.equal((await db("yoco_inbox").where({ event_id: success.id })).length, 0);
        // Real HTTP ingress: rejected payloads must not become durable evidence.
        const stale = signed(success, String(Math.floor(Date.now() / 1000) - 181));
        for (const hostile of [
          { raw: payload.rawData, headers: { ...payload.headers, "webhook-signature": "v1,invalid" }, status: 400 },
          { raw: stale.rawData, headers: stale.headers, status: 400 },
          { raw: "{", headers: payload.headers, status: 400 },
          { raw: JSON.stringify({ padding: "x".repeat(65537) }), headers: payload.headers, status: 413 },
        ]) {
          const rejected = await originalFetch(new URL("/hooks/gospaza/yoco", base), {
            method: "POST", headers: { "Content-Type": "application/json", ...hostile.headers }, body: hostile.raw,
          });
          assert.equal(rejected.status, hostile.status);
          await rejected.text();
          assert.equal((await db("yoco_inbox").where({ event_id: success.id })).length, 0);
        }
        const received = await originalFetch(new URL("/hooks/gospaza/yoco", base), { method: "POST",
          headers: { "Content-Type": "application/json", ...payload.headers }, body: payload.rawData });
        assert.equal(received.status, 200);
        await Promise.all([service.receive(payload), service.receive(payload)]);
        const inbox = await db<InboxRow>("yoco_inbox").where({ event_id: success.id }).first(); assert.ok(inbox);
        assert.equal((await db("yoco_inbox").where({ event_id: success.id })).length, 1);
        await assert.rejects(() => db("yoco_inbox").where({ id: inbox.id }).update({ event: {} }));
        await Promise.all([service.applyInbox(inbox.id), service.applyInbox(inbox.id)]);
        const accepted = await db<Attempt>("checkout_attempt").where({ id: input.attempt_id }).first(); assert.ok(accepted?.payment_accepted_at);
        // Simulate the exact process-loss boundary: claim and run once, omit the
        // GoSpaza terminal write. Reconciliation must inspect, never run again.
        const session = await establishPaymentSession(container, op.id, true);
        await payments.authorizePaymentSession(session.id, {});
        const designated = await designateCompletion(db, accepted, op.id);
        const claims = await Promise.all([claimCompletion(db, designated.id), claimCompletion(db, designated.id)]);
        assert.equal(claims.filter(Boolean).length, 1);
        await completeCartWorkflow(container).run({ input: { id: a.cartId }, context: { transactionId: designated.transaction_id } });
        await assert.rejects(() => new CartFoundationService(container, a.id).add({
          variant_id: fixture.first.variantId, quantity: 1, location: fixture.location,
        }), /CHECKOUT_FROZEN/, "native completed_at without terminal receipt cannot create a replacement cart");
        expect(await http(a.cookie, "GET", "/store/orders"), 404);
        const observed = await inspectCompletion(container, designated);
        assert.ok(observed, "the designated execution must be readable before reconciliation");
        await Promise.all([service.reconcile(op.id), service.reconcile(op.id)]);
        const completion = await db<CompletionRow>("checkout_completion").where({ id: designated.id }).first();
        assert.equal(completion?.state, "SUCCEEDED", JSON.stringify(completion));
        assert.ok(Array.isArray(completion.unresolved), "unresolved must persist as a JSON array, including when empty");
        assert.deepEqual(completion.unresolved, observed.unresolved, "native step observations must round-trip through jsonb unchanged");
        const restoredStatus = await customerStatus(a.cookie, input.attempt_id);
        assert.equal(restoredStatus.state, "succeeded");
        assert.equal(restoredStatus.order_id, completion.order_id);
        assert.ok(completion.execution_id && completion.run_id && completion.terminal_receipt);
        expect(await http(a.cookie, "GET", "/store/orders/" + completion.order_id), 404);
        assert.equal((await engine.listWorkflowExecutions({ workflow_id: "complete-cart", transaction_id: designated.transaction_id })).length, 1);
        assert.equal((await orders.listOrders({ customer_id: a.id }, { take: null })).length, 1);
        assert.equal((await db<Attempt>("checkout_attempt").where({ id: input.attempt_id }).first())?.state, "COMPLETED");
        assert.equal((await db<{ status: string }>("delivery_reservation").where({ id: a.hold.selection.id }).first())?.status, "COMMITTED");
        await service.reconcile(op.id);
        assert.equal(await claimCompletion(db, designated.id), undefined);
        await assert.rejects(() => db("checkout_completion").where({ id: designated.id }).update({ state: "READY", dispatched_at: null }));

        // Normal worker path, including simultaneous first reconciliation.
        const normal = await customer("reconcile-worker"), normalInput = await prepare(normal), normalOp = await operation(normalInput.attempt_id);
        await apply(event(normalOp));
        await Promise.all([service.reconcile(normalOp.id), service.reconcile(normalOp.id)]);
        const normalCompletion = await db<CompletionRow>("checkout_completion").where({ operation_id: normalOp.id }).first();
        assert.equal(normalCompletion?.state, "SUCCEEDED", JSON.stringify(normalCompletion));
        assert.ok(normalCompletion);
        assert.equal((await engine.listWorkflowExecutions({ workflow_id: normalCompletion.workflow_id, transaction_id: normalCompletion.transaction_id })).length, 1);
        assert.equal((await orders.listOrders({ customer_id: normal.id }, { take: null })).length, 1);

        // Verified inbox receipt may precede a lost initiation response. Ingress
        // persists without acquiring the customer lock held by initiation.
        const early = await customer("reconcile-early"), earlyInput = await prepare(early, false);
        let earlyEventId = "";
        beforeCheckoutResponse = async (operationId) => {
          const sending = await operations.row(operationId);
          assert.equal(sending.state, "sending");
          assert.equal(sending.checkout_receipt, null);
          const body = event(sending);
          earlyEventId = body.id;
          const evidence = signed(body);
          const response = await originalFetch(new URL("/hooks/gospaza/yoco", base), {
            method: "POST", headers: { "Content-Type": "application/json", ...evidence.headers }, body: evidence.rawData,
          });
          assert.equal(response.status, 200);
          await response.text();
          assert.equal((await db<InboxRow>("yoco_inbox").where({ event_id: body.id }).first())?.state, "RECEIVED");
          throw new Error("Fixture: verified webhook arrived, then checkout response was lost.");
        };
        try {
          assert.equal((await new PaymentInitiationService(container, early.id).initiate(earlyInput)).state, "uncertain");
        } finally { beforeCheckoutResponse = undefined; }
        const earlyOperation = await operation(earlyInput.attempt_id);
        const earlyMessage = await db<InboxRow>("yoco_inbox").where({ event_id: earlyEventId }).first();
        assert.ok(earlyMessage);
        const postsAfterLostResponse = checkoutPosts;
        const earlyAttempt = await db<Attempt>("checkout_attempt").where({ id: earlyInput.attempt_id }).first();
        assert.ok(earlyAttempt);
        await Promise.all([
          service.applyInbox(earlyMessage.id), service.applyInbox(earlyMessage.id),
          cartOperation(container, early.id, () => currentCheckout(db, earlyAttempt.cart_context_id)),
        ]);
        await Promise.all([service.reconcile(earlyOperation.id), service.reconcile(earlyOperation.id)]);
        assert.equal(checkoutPosts, postsAfterLostResponse, "verified evidence recovery must not POST another checkout");
        assert.equal((await db<Attempt>("checkout_attempt").where({ id: earlyInput.attempt_id }).first())?.state, "COMPLETED");
        assert.equal((await orders.listOrders({ customer_id: early.id }, { take: null })).length, 1);
        const materialized = await operations.row(earlyOperation.id);
        assert.ok(materialized.payment_collection_id);
        const financial = await payments.retrievePaymentCollection(materialized.payment_collection_id, { relations: ["payments", "payments.captures"] });
        assert.equal(financial.payments?.length, 1);
        assert.equal(financial.payments?.[0]?.captures?.length, 1);
        assert.equal((await db("provider_session").where({ operation_id: earlyOperation.id })).length, 2,
          "original deleted session and replacement remain correlated to one operation");
        const failed = await customer("reconcile-failure"), failedInput = await prepare(failed), failedOp = await operation(failedInput.attempt_id);
        expect(await http(failed.cookie, "GET", "/store/gospaza/checkout/status?attempt_id=" + input.attempt_id), 404);
        for (const [key, value] of Object.entries({
          customer_id: a.id, cart_id: a.cartId, merchant_id: fixture.first.merchantId,
          payment_session_id: op.canonical_session_id, provider_operation_id: op.id,
          amount: "1", currency: "USD",
        })) {
          expect(await http(failed.cookie, "GET", "/store/gospaza/checkout/status?" + key + "=" + encodeURIComponent(String(value))), 400);
        }
        await apply(event(failedOp, "payment.failed"));
        assert.equal((await db<Attempt>("checkout_attempt").where({ id: failedInput.attempt_id }).first())?.state, "FAILED");
        assert.equal((await db<{ status: string }>("delivery_reservation").where({ id: failed.hold.selection.id }).first())?.status, "RELEASED");
        await service.reconcile(failedOp.id);
        assert.equal((await orders.listOrders({ customer_id: failed.id })).length, 0);

        // Signed but hostile amount/mode/correlation cannot publish payment evidence.
        const hostile = await customer("reconcile-hostile"), hostileInput = await prepare(hostile), hostileOp = await operation(hostileInput.attempt_id);
        for (const patch of [{ amount: Number(hostileOp.amount_minor) + 1 }, { mode: "live" },
          { metadata: { operation_id: hostileOp.id, checkoutId: op.checkout_id } }]) {
          const body = event(hostileOp); Object.assign(body.payload, patch);
          const row = await apply(body);
          assert.equal((await db<InboxRow>("yoco_inbox").where({ id: row.id }).first())?.state, "REJECTED");
        }
        assert.equal((await operations.row(hostileOp.id)).verified_payment, null);
        const conflictingReplay = { ...success, payload: { ...success.payload, amount: success.payload.amount + 1 } };
        await assert.rejects(() => service.receive(signed(conflictingReplay)), /YOCO_CORRELATION_MISMATCH/);
        assert.equal((await db<InboxRow>("yoco_inbox").where({ event_id: success.id }).first())?.state, "APPLIED");
        const registered = new RegisteredYocoPaymentService({ __pg_connection__: db }, config);
        assert.deepEqual(await registered.getWebhookActionAndData(payload), { action: "not_supported" });
        for (const path of ["/hooks/payment/yoco_yoco", "/store/carts/" + hostile.cartId + "/complete", "/store/payment-collections/" + hostileOp.payment_collection_id + "/payment-sessions"]) {
          expect(await http(hostile.cookie, "POST", path, {}), 404);
        }

        // Claimed dispatch with no execution is intentionally unrecoverable by
        // replay, including repeated workers after native history is absent.
        await apply(event(hostileOp));
        const recoveryAttempt = await db<Attempt>("checkout_attempt").where({ id: hostileInput.attempt_id }).first(); assert.ok(recoveryAttempt);
        const ambiguous = await designateCompletion(db, recoveryAttempt, hostileOp.id);
        assert.ok(await claimCompletion(db, ambiguous.id));
        const postsBefore = sent.size;
        await Promise.all([service.reconcile(hostileOp.id), service.reconcile(hostileOp.id)]);
        assert.equal((await db<Attempt>("checkout_attempt").where({ id: hostileInput.attempt_id }).first())?.state, "RECOVERY_REQUIRED");
        assert.equal((await engine.listWorkflowExecutions({ workflow_id: "complete-cart", transaction_id: ambiguous.transaction_id })).length, 0);
        assert.equal((await new PaymentInitiationService(container, hostile.id).initiate(hostileInput, true)).state, "reconciliation_required");
        await assert.rejects(() => assertCheckoutMutable(db, recoveryAttempt.cart_context_id), /CHECKOUT_FROZEN/);
        await assert.rejects(() => new DeliveryReservationService(container, hostile.id).release({ cart_id: hostile.cartId, expected_revision: hostile.hold.revision + 1 }), /CHECKOUT_FROZEN/);
        await assert.rejects(() => db.transaction((trx) => releaseContextHold(trx, recoveryAttempt.cart_context_id, "HOSTILE_RELEASE")), /CHECKOUT_FROZEN/);
        await assert.rejects(() => operations.claimRefund(hostileOp.id, "forged", "{}"));
        const hold = await db<{ delivery_slot_id: string }>("delivery_reservation").where({ id: hostile.hold.selection.id }).first(); assert.ok(hold);
        const contribution = await db.transaction(async (trx) => {
          await lockSlots(trx, [hold.delivery_slot_id]);
          const future = new Date((await databaseTime(trx)).getTime() + 10 * 86400000);
          return await occupied(trx, hold.delivery_slot_id, future) - await occupied(trx, hold.delivery_slot_id, future, recoveryAttempt.cart_context_id);
        });
        assert.equal(contribution, 1, "recovery capacity survives deadline/history retention");
        await service.reconcile(hostileOp.id);
        assert.equal(sent.size, postsBefore);
        assert.equal((await db("technical_compensation").where({ operation_id: hostileOp.id })).length, 0);
        assert.equal((await currentCheckout(db, recoveryAttempt.cart_context_id))?.state, "RECOVERY_REQUIRED");
        assert.equal((await customerStatus(hostile.cookie, hostileInput.attempt_id)).state, "recovery_required");
        await assert.rejects(() => db("delivery_reservation").where({ id: hostile.hold.selection.id }).update({ status: "RELEASED" }));
        await assert.rejects(() => db("checkout_attempt").where({ id: recoveryAttempt.id }).update({ state: "EXPIRED", closed_at: db.fn.now() }));

        // Expired capacity cannot be revived by late capture. Establish the
        // past deadline before first use; never mutate an immutable deadline.
        const { person: late, input: lateInput, row: lateOp } = await expiredOperation("reconcile-late");
        // Both real operations enter the same customer boundary; DB time wins.
        const lateMessage = event(lateOp);
        await service.receive(signed(lateMessage));
        const lateInbox = await db<InboxRow>("yoco_inbox").where({ event_id: lateMessage.id }).first(); assert.ok(lateInbox);
        const lateAttempt = await db<Attempt>("checkout_attempt").where({ id: lateInput.attempt_id }).first(); assert.ok(lateAttempt);
        await Promise.all([service.applyInbox(lateInbox.id), cartOperation(container, late.id, () => currentCheckout(db, lateAttempt.cart_context_id))]);
        pendingRefund = true;
        await service.reconcile(lateOp.id);
        const refund = await db<CompensationRow>("technical_compensation").where({ operation_id: lateOp.id }).first();
        assert.equal(refund?.state, "pending"); assert.ok(refund);
        assert.equal((await customerStatus(late.cookie, lateInput.attempt_id)).state, "refund_pending");
        assert.equal((await operations.row(lateOp.id)).terminal_refunded, false);
        assert.equal((await orders.listOrders({ customer_id: late.id })).length, 0);
        const refundEvent = { id: "event_" + randomUUID(), type: "refund.succeeded", payload: {
          type: "refund", status: "succeeded", amount: Number(lateOp.amount_minor), currency: "ZAR", mode: "test", metadata: { checkoutId: "ch_" + lateOp.id },
        } }; eventIds.push(refundEvent.id);
        await apply(refundEvent);
        await Promise.all([service.reconcile(lateOp.id), service.reconcile(lateOp.id)]);
        assert.equal((await operations.row(lateOp.id)).terminal_refunded, true);
        assert.equal((await customerStatus(late.cookie, lateInput.attempt_id)).state, "refunded");
        const refunded = await payments.retrievePayment(refund.native_payment_id, { relations: ["refunds"] });
        assert.equal(refunded.refunds?.length, 1);
        assert.equal(refundPosts.filter((post) => post.key === refund.idempotency_key).length, 1);
        assert.equal((await db<Attempt>("checkout_attempt").where({ id: lateInput.attempt_id }).first())?.state, "EXPIRED");
        assert.equal((await db("checkout_completion").where({ operation_id: lateOp.id })).length, 0);
        // A lost external refund response reuses the identical durable key/body
        // after native readback proves its provisional Refund was removed.
        const lostRefund = await expiredOperation("reconcile-lost-refund");
        await apply(event(lostRefund.row));
        pendingRefund = false;
        loseRefundResponse = true;
        await service.reconcile(lostRefund.row.id);
        const uncertainRefund = await db<CompensationRow>("technical_compensation").where({ operation_id: lostRefund.row.id }).first();
        assert.equal(uncertainRefund?.state, "uncertain"); assert.ok(uncertainRefund);
        assert.equal((await operations.row(lostRefund.row.id)).terminal_refunded, false);
        assert.equal((await payments.retrievePayment(uncertainRefund.native_payment_id, { relations: ["refunds"] })).refunds?.length, 0);
        const payableCheckouts = [...sent.keys()].filter((key) => !key.includes("tcomp_")).length;
        await service.reconcile(lostRefund.row.id);
        assert.equal((await operations.row(lostRefund.row.id)).terminal_refunded, true);
        assert.equal((await payments.retrievePayment(uncertainRefund.native_payment_id, { relations: ["refunds"] })).refunds?.length, 1);
        assert.equal([...sent.keys()].filter((key) => !key.includes("tcomp_")).length, payableCheckouts);
        assert.equal(refundPosts.filter((post) => post.key === uncertainRefund.idempotency_key).length, 1, "one external refund business effect despite replay");

      } catch (error) { failures.push(error); }

      // Known fixture IDs only; native cleanup uses public module/link APIs.
      const rows = await db<OperationRow>("provider_operation").whereIn("checkout_attempt_id", attempts);
      const nativeOrders = await orders.listOrders({ customer_id: people }, { relations: ["items"], take: null });
      for (const order of nativeOrders) {
        try {
          const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
          const reservations = await inventory.listReservationItems({ line_item_id: (order.items ?? []).map((item) => item.id) }, { take: null });
          if (reservations.length) await inventory.deleteReservationItems(reservations.map((item) => item.id));
          const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
          const links = await query.graph({ entity: "order_cart", fields: ["cart_id"], filters: { order_id: order.id } });
          for (const value of links.data) {
            const link = z.object({ cart_id: z.string() }).parse(value);
            await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({ [Modules.ORDER]: { order_id: order.id }, [Modules.CART]: { cart_id: link.cart_id } });
          }
          const collections = await query.graph({ entity: "order_payment_collection", fields: ["payment_collection_id"], filters: { order_id: order.id } });
          for (const value of collections.data) {
            const link = z.object({ payment_collection_id: z.string() }).parse(value);
            await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({ [Modules.ORDER]: { order_id: order.id }, [Modules.PAYMENT]: { payment_collection_id: link.payment_collection_id } });
          }
          await orders.deleteOrders([order.id]);
        } catch (error) { failures.push(error); }
      }
      for (const row of rows) {
        try {
          const attempt = await db<Attempt>("checkout_attempt").where({ id: row.checkout_attempt_id }).first();
          if (attempt && row.payment_collection_id && await linkedCollection(container, attempt.medusa_cart_id) === row.payment_collection_id) {
            await container.resolve<Link>(ContainerRegistrationKeys.LINK).dismiss({ [Modules.CART]: { cart_id: attempt.medusa_cart_id }, [Modules.PAYMENT]: { payment_collection_id: row.payment_collection_id } });
          }
          if (row.payment_collection_id) await payments.deletePaymentCollections(row.payment_collection_id);
        } catch (error) { failures.push(error); }
      }
      try {
        await db.transaction(async (trx) => {
          await trx("yoco_inbox").whereIn("event_id", eventIds).delete();
          await trx("checkout_completion").whereIn("checkout_attempt_id", attempts).delete();
          await trx("technical_compensation").whereIn("operation_id", rows.map((row) => row.id)).delete();
          await trx("provider_session").whereIn("operation_id", rows.map((row) => row.id)).delete();
          await trx("provider_operation").whereIn("id", rows.map((row) => row.id)).delete();
        });
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "M10-E reconciliation verification failed.");
    });
  } finally { globalThis.fetch = originalFetch; }
  console.log("M10-E passed: verified inbox, concurrent deduplication, native terminal readback, one completion dispatch, recovery freeze/capacity, late capture and pending refund recovery. External Yoco transport was substituted.");
}
