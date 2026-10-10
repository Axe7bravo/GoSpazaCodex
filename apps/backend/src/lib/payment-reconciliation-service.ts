import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { completeCartWorkflow } from "@medusajs/medusa/core-flows";
import { cartOperation } from "./cart-lock";
import { yocoConfiguration } from "./yoco-config";
import { establishPaymentSession } from "./payment-native";
import { assertNativeCheckoutSnapshot, checkoutMoney } from "./checkout-native";
import { capturedNativePayment, completionDisposition, inspectCompletion, validateCompletedOrder } from "./completion-native";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import type { Attempt } from "../modules/marketplace/checkout-repository";
import type { CompletionRow, InboxRow, CompensationRow } from "../modules/marketplace/reconciliation-types";
import { claimCompletion, designateCompletion, requireCompletionRecovery } from "../modules/marketplace/completion-repository";
import { checkoutSnapshot } from "../modules/marketplace/checkout-policy";
import { databaseTime, lockSlots } from "../modules/marketplace/delivery-reservation-repository";
import type { Hold } from "../modules/marketplace/delivery-reservation-repository";
import { fingerprint } from "../modules/yoco/request";
import { verifiedPayment, verifiedYocoEvent, verifyYocoInboxEvent } from "../modules/yoco/webhook";
import type { VerifiedYocoEvent } from "../modules/yoco/webhook";
import type { YocoWebhookPayload } from "../modules/yoco/types";
import { YocoProviderError } from "../modules/yoco/types";
import { nativePrice } from "../modules/marketplace/catalogue-policy";

export class PaymentReconciliationService {
  private db: Knex;
  private operations: PgYocoOperationStore;
  constructor(private container: MedusaContainer) {
    this.db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.operations = new PgYocoOperationStore(this.db);
  }

  async receive(payload: YocoWebhookPayload) {
    const config = yocoConfiguration(process.env);
    if (!config) throw new Error("Yoco ingress is disabled.");
    const event = verifyYocoInboxEvent(payload, config.webhookSecret);
    if (!event) return;
    // Persist verified normalized evidence, not unsigned parsed JSON or secrets.
    const bodyFingerprint = fingerprint(JSON.stringify(event));
    await this.db("yoco_inbox").insert({ id: "yin_" + randomUUID(), event_id: event.id,
      body_fingerprint: bodyFingerprint, event, state: "RECEIVED" }).onConflict("event_id").ignore();
    const saved = await this.db<InboxRow>("yoco_inbox").where({ event_id: event.id }).first();
    if (!saved || saved.body_fingerprint !== bodyFingerprint) throw new YocoProviderError("YOCO_CORRELATION_MISMATCH");
    // Acknowledge durable receipt only. Native/external work runs in the worker.
  }

  async applyInbox(id: string) {
    const inbox = await this.db<InboxRow>("yoco_inbox").where({ id }).first();
    if (!inbox || inbox.state !== "RECEIVED") return;
    const event = verifiedYocoEvent.parse(inbox.event);
    const operation = "operationId" in event
      ? await this.db<OperationRow>("provider_operation").where({ id: event.operationId }).first()
      : await this.db<OperationRow>("provider_operation").where({ checkout_id: event.checkoutId }).first();
    if (!operation) return this.rejectInbox(id);
    const attempt = await this.db<Attempt>("checkout_attempt").where({ id: operation.checkout_attempt_id }).first();
    if (!attempt) return this.rejectInbox(id);
    const snapshot = checkoutSnapshot.parse(attempt.snapshot);
    return cartOperation(this.container, snapshot.customer_id, async () => {
      await this.db.transaction(async (trx) => {
        const message = await trx<InboxRow>("yoco_inbox").where({ id }).forUpdate().first();
        if (!message || message.state !== "RECEIVED") return;
        const row = await trx<OperationRow>("provider_operation").where({ id: operation.id }).forUpdate().first();
        const current = await trx<Attempt>("checkout_attempt").where({ id: attempt.id }).forUpdate().first();
        if (!row || !current || !await this.correlates(trx, row, event)) {
          await trx("yoco_inbox").where({ id }).update({ state: "REJECTED", rejection_code: "CORRELATION", updated_at: trx.fn.now() });
          return;
        }
        if (event.type === "refund.succeeded" || event.type === "refund.failed") {
          const refund = await trx<CompensationRow>("technical_compensation").where({ operation_id: row.id }).forUpdate().first();
          if (!refund || current.state === "RECOVERY_REQUIRED") {
            await trx("yoco_inbox").where({ id }).update({ state: "REJECTED", rejection_code: "UNAPPROVED_REFUND", updated_at: trx.fn.now() });
            return;
          }
          if (refund.state !== "succeeded" || event.type === "refund.succeeded") await trx("technical_compensation").where({ id: refund.id }).update({
            verified_event: event, state: event.type === "refund.succeeded" ? "succeeded" : refund.state,
            recovery_required: event.type === "refund.failed", replay_allowed: false, updated_at: trx.fn.now(),
          });
        } else {
          const previous = row.verified_payment ? verifiedPayment.parse(row.verified_payment) : null;
          if (previous?.type !== "payment.succeeded") {
            await trx("provider_operation").where({ id: row.id }).update({
              verified_payment: event, reconciliation_pending: event.type === "payment.succeeded", checkout_id: event.checkoutId, replay_allowed: false, updated_at: trx.fn.now(),
            });
          }
          const hold = await trx<Hold>("delivery_reservation").where({ id: current.reservation_id }).first();
          if (hold) await lockSlots(trx, [hold.delivery_slot_id]);
          const now = await databaseTime(trx);
          if (!current.closed_at && !current.payment_accepted_at && current.state === "PAYMENT_PENDING") {
            const context = await trx("cart_marketplace_context").where({ id: current.cart_context_id, medusa_cart_id: current.medusa_cart_id })
              .whereNull("superseded_at").whereNull("deleted_at").first();
            const live = context && hold?.status === "PAYMENT_PENDING" && !hold.deleted_at
              && hold.payment_deadline && current.payment_deadline
              && new Date(hold.payment_deadline).getTime() === new Date(current.payment_deadline).getTime()
              && new Date(current.payment_deadline) > now;
            if (event.type === "payment.succeeded" && live && hold) {
              await trx("checkout_attempt").where({ id: current.id }).update({ payment_accepted_at: now, updated_at: now });
              await trx("delivery_reservation").where({ id: hold.id }).update({ payment_accepted_at: now, updated_at: now });
            } else if (event.type === "payment.failed" || !live) {
              await trx("checkout_attempt").where({ id: current.id }).update({ state: event.type === "payment.failed" ? "FAILED" : "EXPIRED", closed_at: now, updated_at: now });
              if (hold?.status === "PAYMENT_PENDING") await trx("delivery_reservation").where({ id: hold.id }).update({
                status: "RELEASED", released_at: now, release_reason: "PAYMENT_NOT_ACCEPTED", updated_at: now,
              });
            }
          }
        }
        await trx("yoco_inbox").where({ id }).update({ state: "APPLIED", updated_at: trx.fn.now() });
      });
    });
  }

  private async rejectInbox(id: string) {
    await this.db("yoco_inbox").where({ id, state: "RECEIVED" }).update({ state: "REJECTED", rejection_code: "CORRELATION", updated_at: this.db.fn.now() });
  }

  private async correlates(trx: Knex.Transaction, row: OperationRow, event: VerifiedYocoEvent) {
    const config = yocoConfiguration(process.env);
    if (!config || row.account_fingerprint !== fingerprint(config.secretKey) || row.mode !== event.mode
      || Number(row.amount_minor) !== event.amount || event.currency !== "ZAR"
      || row.checkout_id && row.checkout_id !== event.checkoutId) return false;
    if ("operationId" in event) {
      if (event.operationId !== row.id) return false;
      if (event.sessionId && !await trx("provider_session").where({ operation_id: row.id, native_session_id: event.sessionId }).first()) return false;
      if (row.verified_payment) {
        const previous = verifiedPayment.parse(row.verified_payment);
        if (previous.type === "payment.succeeded" && previous.paymentId !== event.paymentId) return false;
      }
    } else if (!row.checkout_id || !row.verified_payment || verifiedPayment.parse(row.verified_payment).type !== "payment.succeeded") return false;
    return true;
  }

  async reconcile(operationId: string) {
    const initial = await this.operations.row(operationId);
    const attempt = await this.db<Attempt>("checkout_attempt").where({ id: initial.checkout_attempt_id }).first();
    if (!attempt) throw new Error("PAYMENT_ATTEMPT_MISSING");
    const snapshot = checkoutSnapshot.parse(attempt.snapshot);
    return cartOperation(this.container, snapshot.customer_id, async () => {
      const current = await this.db<Attempt>("checkout_attempt").where({ id: attempt.id }).first();
      if (!current) throw new Error("PAYMENT_ATTEMPT_MISSING");
      const row = await this.operations.row(operationId);
      if (!row.verified_payment || verifiedPayment.parse(row.verified_payment).type !== "payment.succeeded" || row.terminal_refunded) return;
      const completion = await this.db<CompletionRow>("checkout_completion").where({ checkout_attempt_id: current.id }).first();
      if (completion?.state === "SUCCEEDED") return; // durable receipt survives native retention
      if (completion?.dispatched_at) return this.observe(current, row, completion);
      if (current.state === "RECOVERY_REQUIRED") return;
      try {
        const session = await establishPaymentSession(this.container, row.id, true);
        const payments = this.container.resolve<IPaymentModuleService>(Modules.PAYMENT);
        await payments.authorizePaymentSession(session.id, {});
        const financial = await this.operations.row(row.id);
        const payment = await capturedNativePayment(this.container, financial);
        if (current.closed_at || !current.payment_accepted_at) {
          return this.compensateLate(current, financial, payment.id);
        }
        if (payment.refunds?.length) throw new Error("CAPTURE_ALREADY_REFUNDED");
        await assertNativeCheckoutSnapshot(this.container, snapshot);
        const designated = await designateCompletion(this.db, current, row.id);
        const claimed = await claimCompletion(this.db, designated.id);
        if (!claimed) return this.observe(current, financial, designated);
        // The only completion dispatch site. No retry/runAsStep/cancel/resume.
        try {
          await completeCartWorkflow(this.container).run({ input: { id: current.medusa_cart_id },
            context: { transactionId: claimed.transaction_id }, throwOnError: false });
        } catch {
          // A thrown/lost result is not proof of failure. Inspect the exact run.
        }
        await this.observe(current, financial, claimed);
      } catch {
        if (!current.closed_at) await requireCompletionRecovery(this.db, current.id, "NATIVE_FINANCIAL_OR_COMPLETION_UNCERTAINTY");
        else throw new Error("TECHNICAL_COMPENSATION_REQUIRES_RECOVERY");
      }
    });
  }

  private async observe(attempt: Attempt, operation: OperationRow, completion: CompletionRow) {
    if (completion.state === "SUCCEEDED") return;
    const execution = await inspectCompletion(this.container, completion);
    if (!execution) return requireCompletionRecovery(this.db, attempt.id, "EXECUTION_HISTORY_MISSING_OR_CONFLICTING");
    // pg encodes JS arrays as PostgreSQL arrays; jsonb requires explicit JSON text.
    await this.db("checkout_completion").where({ id: completion.id }).update({ execution_id: execution.id,
      run_id: execution.runId, native_state: execution.state, unresolved: JSON.stringify(execution.unresolved), updated_at: this.db.fn.now() });
    if (completionDisposition(execution.state) === "RECOVERY_REQUIRED") {
      // Even reverted/failed can hide uncompensated native effects or a failed
      // nested refund. Never treat the lifecycle label as financial proof.
      return requireCompletionRecovery(this.db, attempt.id, "NATIVE_" + execution.state.toUpperCase());
    }
    try {
      const receipt = await validateCompletedOrder(this.container, operation, checkoutSnapshot.parse(attempt.snapshot));
      await this.db.transaction(async (trx) => {
        const hold = await trx<Hold>("delivery_reservation").where({ id: attempt.reservation_id }).first();
        if (!hold || !hold.payment_accepted_at || hold.status !== "PAYMENT_PENDING") throw new Error("COMPLETION_CAPACITY_MISSING");
        await lockSlots(trx, [hold.delivery_slot_id]);
        const now = await databaseTime(trx);
        await trx("delivery_reservation").where({ id: hold.id }).update({ status: "COMMITTED", medusa_order_id: receipt.order_id, updated_at: now });
        await trx("checkout_attempt").where({ id: attempt.id, closed_at: null }).update({ state: "COMPLETED", closed_at: now, updated_at: now });
        await trx("provider_operation").where({ id: operation.id }).update({ reconciliation_pending: false, updated_at: now });
        await trx("checkout_completion").where({ id: completion.id }).update({ state: "SUCCEEDED", order_id: receipt.order_id,
          terminal_receipt: { ...receipt, workflow_id: completion.workflow_id, transaction_id: completion.transaction_id,
            execution_id: execution.id, run_id: execution.runId, verified_at: now.toISOString() }, recovery_reason: null, updated_at: now });
      });
    } catch {
      await requireCompletionRecovery(this.db, attempt.id, "TERMINAL_NATIVE_READBACK_FAILED");
    }
  }

  private async compensateLate(attempt: Attempt, operation: OperationRow, paymentId: string) {
    // Only a proven closed, never-dispatched attempt is automatically refundable.
    if (!attempt.closed_at || attempt.payment_accepted_at
      || await this.db("checkout_completion").where({ operation_id: operation.id }).first()) throw new Error("REFUND_NOT_SAFE");
    const query = this.container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
    const linked = await query.graph({ entity: "order_payment_collection", fields: ["order_id"],
      filters: { payment_collection_id: operation.payment_collection_id } });
    if (linked.data.length) throw new Error("REFUND_ORDER_RELATIONSHIP_REQUIRES_RECOVERY");
    // Safety derives from never dispatching this attempt, plus native readback;
    // absence of this link alone would not authorize a refund after dispatch.
    const event = verifiedPayment.parse(operation.verified_payment);
    const id = "tcomp_" + randomUUID();
    await this.db("technical_compensation").insert({ id, operation_id: operation.id, native_payment_id: paymentId,
      provider_payment_id: event.paymentId, amount_minor: Number(operation.amount_minor), idempotency_key: "gospaza_" + id,
      request_json: JSON.stringify({ amount: Number(operation.amount_minor) }), reason: "CAPTURE_AFTER_CLOSED_ATTEMPT",
    }).onConflict("operation_id").ignore();
    const refund = await this.db<CompensationRow>("technical_compensation").where({ operation_id: operation.id }).first();
    if (!refund || refund.recovery_required) return;
    const payments = this.container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const native = await payments.retrievePayment(paymentId, { relations: ["refunds"] });
    if (native.refunds?.length) {
      const existing = native.refunds[0];
      if (native.refunds.length === 1 && existing && checkoutMoney(existing.amount) === Number(operation.amount_minor)
        && refund.state === "succeeded") {
        await this.db.transaction(async (trx) => {
          await trx("technical_compensation").where({ id: refund.id }).update({ native_refund_id: existing.id, updated_at: trx.fn.now() });
          await trx("provider_operation").where({ id: operation.id }).update({ terminal_refunded: true, reconciliation_pending: false, updated_at: trx.fn.now() });
        });
      } else {
        // Native refund is inserted before the provider call. Its existence is
        // not refund proof and may represent a still-progressing native call.
        await this.db("technical_compensation").where({ id: refund.id }).update({ recovery_required: true, updated_at: this.db.fn.now() });
      }
      return;
    }
    if (refund.native_dispatch_at && refund.state === "sending") {
      await this.db("technical_compensation").where({ id: refund.id }).update({ recovery_required: true, updated_at: this.db.fn.now() });
      return;
    }
    // Native refund failure removes its provisional row. Retry only after this
    // readback, using the identical durable external request/key.
    await this.db("technical_compensation").where({ id: refund.id }).update({
      native_dispatch_at: this.db.fn.now(), replay_allowed: ["uncertain", "pending"].includes(refund.state), updated_at: this.db.fn.now(),
    });
    try {
      await payments.refundPayment({ payment_id: paymentId, amount: nativePrice(Number(operation.amount_minor)) });
    } catch {
      return; // provider persisted pending/uncertain; worker observes next pass
    }
    const fresh = await payments.retrievePayment(paymentId, { relations: ["refunds"] });
    const completed = await this.db<CompensationRow>("technical_compensation").where({ id: refund.id }).first();
    if (completed?.state === "succeeded" && fresh.refunds?.length === 1
      && checkoutMoney(fresh.refunds[0]?.amount) === Number(operation.amount_minor)) {
      await this.db.transaction(async (trx) => {
        await trx("technical_compensation").where({ id: refund.id }).update({ native_refund_id: fresh.refunds?.[0]?.id, updated_at: trx.fn.now() });
        await trx("provider_operation").where({ id: operation.id }).update({ terminal_refunded: true, reconciliation_pending: false, updated_at: trx.fn.now() });
      });
    }
  }
}
