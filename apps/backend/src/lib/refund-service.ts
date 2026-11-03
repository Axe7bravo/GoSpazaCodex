import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { IUserModuleService, MedusaContainer, Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import { z } from "@medusajs/framework/zod";
import { FinancialService, type AdjustmentRow } from "./financial-service";
import { readFinancialEconomics } from "./financial-native";
import { readOrderHandoff } from "../modules/marketplace/order-operation-repository";
import { financialParse, hasFinancialCapability } from "../modules/marketplace/financial-policy";
import { resourceId } from "../modules/marketplace/team-policy";
import { databaseTime } from "../modules/marketplace/delivery-reservation-repository";
import { reserveSettlement } from "../modules/marketplace/settlement-repository";
import { refundCommand, refundConflict, refundRequest, mayReplayRefund, type RefundRow, type RefundAttemptRow } from "../modules/marketplace/refund-policy";
import { assertCheckoutRefundAvailable, refundEvent, updateRefund, withRefund } from "../modules/marketplace/refund-repository";
import { verifiedPayment, type VerifiedRefundEvent } from "../modules/yoco/webhook";
import { fingerprint } from "../modules/yoco/request";
import { YocoRefundTransport, type RefundTransport } from "../modules/yoco/refund-transport";
import { NativeRefundAccounting, type RefundNative } from "./refund-native";
import { yocoConfiguration } from "./yoco-config";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";

export class RefundService {
  readonly db: Knex;
  private readonly native: RefundNative;
  constructor(private readonly container: MedusaContainer, private readonly transport: RefundTransport = new YocoRefundTransport(),
    native?: RefundNative, db?: Knex) {
    this.db = db ?? container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    this.native = native ?? new NativeRefundAccounting(container);
  }
  private async authorize(user: string) {
    if (!hasFinancialCapability(user, "EXECUTE_REFUND")) throw new MedusaError(MedusaError.Types.FORBIDDEN, "Refund execution capability required.");
    await this.container.resolve<IUserModuleService>(Modules.USER).retrieveUser(user);
  }
  private async createAttempt(trx: Knex.Transaction, row: RefundRow) {
    const prior = await trx<RefundAttemptRow>("provider_refund_attempt").where({ refund_operation_id: row.id }).orderBy("attempt_number", "desc").first();
    if (prior && prior.status !== "FAILED_NOT_CREATED") throw refundConflict();
    const id = "rfat_" + randomUUID(), request = refundRequest(row.id, id, Number(row.amount_minor));
    await trx("provider_refund_attempt").insert({ id, refund_operation_id: row.id, attempt_number: (prior?.attempt_number ?? 0) + 1,
      idempotency_key: "gospaza_" + id, request_json: request.json, request_fingerprint: request.fingerprint,
      request_version: "M18-C1-1", status: "CREATED" });
    return id;
  }
  async command(user: string, adjustmentId: string, body: unknown) {
    await this.authorize(user);
    financialParse(resourceId, adjustmentId);
    const input = financialParse(refundCommand, body);
    const reasons = { EXECUTE: "APPROVED_ADJUSTMENT", RECONCILE: "RECOVER_UNCERTAIN_REQUEST", RETRY_NOT_CREATED: "RETRY_CONFIRMED_NOT_CREATED" };
    if (input.reason !== reasons[input.action]) throw refundConflict();
    let operation = await this.db<RefundRow>("refund_operation").where({ adjustment_id: adjustmentId }).first();
    if (!operation) {
      if (input.action !== "EXECUTE") throw refundConflict();
      operation = await this.prepare(user, adjustmentId);
    } else if (input.action === "RETRY_NOT_CREATED") {
      operation = await withRefund(this.db, operation.id, async (trx, row) => {
        await this.authorize(user);
        const currentAttempt = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: row.current_attempt_id ?? "" }).first();
        if (currentAttempt && currentAttempt.attempt_number === (input.expected_attempt_number ?? 0) + 1) return row;
        if (currentAttempt?.attempt_number !== input.expected_attempt_number) throw refundConflict();
        if (row.status !== "FAILED_NOT_CREATED" || row.native_dispatched_at) throw refundConflict();
        await assertCheckoutRefundAvailable(trx, row.provider_operation_id, row.id);
        const current = await this.createAttempt(trx, row);
        return updateRefund(trx, row, { current_attempt_id: current, status: "CREATED", attention_reason: null }, "RETRY_NOT_CREATED_AUTHORIZED", user);
      });
    }
    if (input.action === "RECONCILE" && operation.status === "ATTENTION_REQUIRED"
      && ["NATIVE_REFUND_RESULT_MISSING", "NATIVE_ORDER_RESULT_MISSING"].includes(operation.attention_reason ?? "")) {
      const attentionReason = operation.attention_reason;
      await withRefund(this.db, operation.id, async (trx, row) => {
        // Readback recovery only: immutable dispatch timestamps prevent a new
        // native write, and this cannot authorize a new provider request.
        if (row.status === "ATTENTION_REQUIRED" && row.attention_reason === attentionReason)
          await updateRefund(trx, row, { status: "PROVIDER_SUCCEEDED", attention_reason: null }, "NATIVE_READBACK_REQUESTED", user);
      });
    }
    // EXECUTE replays never grant recovery of a timed-out request implicitly.
    await this.advance(operation.id, input.action === "RECONCILE", user);
    return this.view(operation.id);
  }
  private async prepare(user: string, adjustmentId: string) {
    const initial = await this.db<AdjustmentRow>("financial_adjustment").where({ id: adjustmentId }).first();
    if (!initial) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Financial resource not found.");
    await new FinancialService(this.container, this.db).ensure(initial.medusa_order_id);
    const handoff = await readOrderHandoff(this.db, initial.medusa_order_id);
    if (!handoff) throw refundConflict();
    // A mixed-funded adjustment needs source allocation/restoration before
    // original-payment execution. Never turn its Store Credit component into cash.
    if(handoff.snapshot.store_credit) throw refundConflict();
    const receipt = z.object({ payment_id: z.string(), capture_id: z.string() }).parse(handoff.terminal_receipt);
    const completion = await this.db("checkout_completion").where({ id: handoff.completion_id }).first();
    if (!completion?.operation_id) throw refundConflict();
    return this.db.transaction(async trx => {
      // Match existing merchant/order discipline before entering financial locks.
      await trx("merchant").where({ id: initial.merchant_id }).forUpdate().first();
      await trx("order_operation").where({ id: initial.order_operation_id }).forUpdate().first();
      const provider = await trx<OperationRow>("provider_operation").where({ id: completion.operation_id }).whereNull("deleted_at").forUpdate().first();
      const row = await trx<AdjustmentRow>("financial_adjustment").where({ id: adjustmentId }).forUpdate().first();
      await this.authorize(user);
      const existing = await trx<RefundRow>("refund_operation").where({ adjustment_id: adjustmentId }).first();
      if (existing) return existing;
      const config = yocoConfiguration(process.env);
      if (!row || row.status !== "APPROVED" || !row.eligible_methods.includes("ORIGINAL_PAYMENT")
        || !provider?.checkout_id || provider.terminal_refunded || !config
        || provider.account_fingerprint !== fingerprint(config.secretKey)
        || await trx("technical_compensation").where({ operation_id: provider.id }).first()) throw refundConflict();
      const currentHandoff = await readOrderHandoff(trx, row.medusa_order_id);
      if (!currentHandoff || currentHandoff.completion_id !== handoff.completion_id) throw refundConflict();
      const economics = await readFinancialEconomics(this.container, currentHandoff);
      if (economics.fingerprint !== row.economics_fingerprint) throw refundConflict();
      const payment = verifiedPayment.parse(provider.verified_payment);
      if (payment.type !== "payment.succeeded" || payment.checkoutId !== provider.checkout_id || payment.mode !== provider.mode
        || payment.amount !== Number(provider.amount_minor)
        || Number(row.amount_minor) > payment.amount || row.currency !== "zar") throw refundConflict();
      await assertCheckoutRefundAvailable(trx, provider.id);
      const settlement = await reserveSettlement(trx, row, "ORIGINAL_PAYMENT", Number(row.amount_minor));
      const [created] = await trx<RefundRow>("refund_operation").insert({ id: "rfop_" + randomUUID(), settlement_id: settlement,
        adjustment_id: row.id, order_id: row.medusa_order_id, merchant_id: row.merchant_id, store_id: row.merchant_store_id,
        customer_id: row.customer_id, provider_operation_id: provider.id, checkout_id: provider.checkout_id,
        provider_payment_id: payment.paymentId, payment_id: receipt.payment_id, capture_id: receipt.capture_id,
        account_fingerprint: provider.account_fingerprint, mode: provider.mode, amount_minor: row.amount_minor, currency: "zar", status: "CREATED", revision: 1,
      }).returning("*");
      if (!created) throw refundConflict();
      await refundEvent(trx, created, "ENTITLEMENT_RESERVED", user);
      const current = await this.createAttempt(trx, created);
      return updateRefund(trx, created, { current_attempt_id: current }, "REQUEST_FROZEN", user);
    });
  }
  async view(id: string) {
    const row = await this.db<RefundRow>("refund_operation").where({ id }).first();
    if (!row) throw refundConflict();
    return { adjustment_id: row.adjustment_id, status: row.status, amount_minor: Number(row.amount_minor), currency: row.currency,
      attention_reason: row.attention_reason };
  }
  async advance(id: string, replay = false, actor: string | null = null) {
    const send = await withRefund(this.db, id, async (trx, row) => {
      if (!["CREATED", "REQUESTED", "UNKNOWN"].includes(row.status) || !row.current_attempt_id) return null;
      const attempt = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: row.current_attempt_id }).forUpdate().first();
      if (!attempt || ["SUCCEEDED", "FAILED", "FAILED_NOT_CREATED"].includes(attempt.status)) return null;
      const now = await databaseTime(trx);
      if (attempt.lease_until && new Date(attempt.lease_until) > now) return null;
      if (!mayReplayRefund(attempt.first_sent_at, now)) {
        await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: attempt.status === "PENDING" ? "PROVIDER_EVENT_MISSING" : "SAFE_REPLAY_WINDOW_EXHAUSTED" }, "RECOVERY_REQUIRED");
        return null;
      }
      if (attempt.status === "PENDING") return null;
      if (attempt.status !== "CREATED" && !replay) return null;
      const config = yocoConfiguration(process.env);
      if (!config || fingerprint(config.secretKey) !== row.account_fingerprint) return null;
      const [claimed] = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: attempt.id }).update({ status: "SENDING",
        first_sent_at: attempt.first_sent_at ?? now, lease_until: new Date(now.getTime() + 60000), updated_at: now }).returning("*");
      await updateRefund(trx, row, { status: "REQUESTED" }, attempt.first_sent_at ? "REQUEST_REPLAYED" : "REQUEST_DISPATCHED", actor);
      return claimed ? { row, attempt: claimed } : null;
    });
    if (send) {
      const result = await this.transport.send(send.row, send.attempt);
      await withRefund(this.db, id, async (trx, row) => {
        const attempt = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: send.attempt.id }).forUpdate().first();
        if (!attempt || row.current_attempt_id !== attempt.id) throw refundConflict();
        // The signed event may already have won the race. Never demote it.
        if (attempt.verified_event_id) {
          if (result.kind === "NOT_CREATED" || result.kind === "ACCEPTED" && attempt.provider_refund_id !== result.refundId) {
            if (row.status !== "SETTLED") await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: "PROVIDER_EVIDENCE_CONFLICT" }, "RESPONSE_CONFLICT");
          }
          return;
        }
        if (result.kind === "ACCEPTED" && attempt.provider_refund_id && attempt.provider_refund_id !== result.refundId) {
          await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: "PROVIDER_REFUND_ID_MISMATCH" }, "RESPONSE_CONFLICT");
          return;
        }
        await trx("provider_refund_attempt").where({ id: attempt.id }).update({
          status: result.kind === "ACCEPTED" ? "PENDING" : result.kind === "NOT_CREATED" ? "FAILED_NOT_CREATED" : "UNKNOWN",
          provider_refund_id: result.kind === "ACCEPTED" ? result.refundId : attempt.provider_refund_id,
          response_status: result.kind === "UNKNOWN" ? null : result.status, lease_until: null, updated_at: trx.fn.now(),
        });
        await updateRefund(trx, row, { status: result.kind === "ACCEPTED" ? "REQUESTED" : result.kind === "NOT_CREATED" ? "FAILED_NOT_CREATED" : "UNKNOWN" }, "REQUEST_" + result.kind, actor);
      });
    }
    await this.account(id);
  }
  // Called only by the verified inbox owner. Return false only if this is not a
  // C1 event, allowing the unchanged M10 technical-compensation path to handle it.
  async applyEvent(inboxId: string, event: VerifiedRefundEvent): Promise<boolean> {
    const byId = event.refundId ? await this.db<RefundAttemptRow>("provider_refund_attempt").where({ provider_refund_id: event.refundId }).first() : undefined;
    const byMeta = event.refundAttemptId ? await this.db<RefundAttemptRow>("provider_refund_attempt").where({ id: event.refundAttemptId }).first() : undefined;
    const attempt = byId ?? byMeta;
    if (!attempt && !event.refundOperationId && !event.refundAttemptId) {
      // An uncorrelated event for a completed-order checkout must never fall
      // through to amount-based technical compensation.
      const known = await this.db("refund_operation").where({ checkout_id: event.checkoutId }).first();
      if (!known) return false;
    }
    if (!attempt) {
      await this.db("yoco_inbox").where({ id: inboxId, state: "RECEIVED" }).update({ state: "REJECTED", rejection_code: "REFUND_CORRELATION" });
      return true;
    }
    await withRefund(this.db, attempt.refund_operation_id, async (trx, row) => {
      const inbox = await trx("yoco_inbox").where({ id: inboxId }).forUpdate().first();
      if (!inbox || inbox.state !== "RECEIVED") return;
      const current = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: attempt.id }).forUpdate().first();
      const config = yocoConfiguration(process.env);
      const valid = current && event.refundId && event.paymentId && config
        && row.account_fingerprint === fingerprint(config.secretKey) && row.mode === event.mode
        && event.checkoutId === row.checkout_id && event.paymentId === row.provider_payment_id
        && event.amount === Number(row.amount_minor) && event.currency === "ZAR"
        && (!event.refundOperationId || event.refundOperationId === row.id)
        && (!event.refundAttemptId || event.refundAttemptId === current.id)
        && (!current.provider_refund_id || current.provider_refund_id === event.refundId)
        && (!byId || !byMeta || byId.id === byMeta.id)
        && (current.provider_refund_id || event.refundOperationId === row.id && event.refundAttemptId === current.id)
        && current.first_sent_at;
      if (!valid || !current || row.current_attempt_id !== current.id) {
        if (valid && row.status !== "SETTLED") await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: "SUPERSEDED_ATTEMPT_EVENT" }, "EVENT_CONFLICT");
        await trx("yoco_inbox").where({ id: inboxId }).update({ state: "REJECTED", rejection_code: "REFUND_CORRELATION" });
        return;
      }
      if (current.status === "FAILED_NOT_CREATED") {
        await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: "NOT_CREATED_EVENT_CONFLICT" }, "EVENT_CONFLICT");
        await trx("yoco_inbox").where({ id: inboxId }).update({ state: "REJECTED", rejection_code: "REFUND_TERMINAL_CONFLICT" });
        return;
      }
      const success = event.type === "refund.succeeded";
      if (current.verified_event_id && (current.status === "SUCCEEDED") !== success) {
        if (row.status !== "SETTLED") await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: "CONTRADICTORY_TERMINAL_EVENTS" }, "EVENT_CONFLICT");
        await trx("yoco_inbox").where({ id: inboxId }).update({ state: "REJECTED", rejection_code: "REFUND_TERMINAL_CONFLICT" });
        return;
      }
      if (!current.verified_event_id) {
        await trx("provider_refund_attempt").where({ id: current.id }).update({ status: success ? "SUCCEEDED" : "FAILED",
          provider_refund_id: event.refundId, verified_event_id: event.id, lease_until: null, updated_at: trx.fn.now() });
        await updateRefund(trx, row, { status: success ? "PROVIDER_SUCCEEDED" : "FAILED", attention_reason: success ? null : "PROVIDER_REFUND_FAILED" }, success ? "PROVIDER_SUCCESS_VERIFIED" : "PROVIDER_FAILURE_VERIFIED");
      }
      await trx("yoco_inbox").where({ id: inboxId }).update({ state: "APPLIED", updated_at: trx.fn.now() });
    });
    return true;
  }
  private async account(id: string) {
    let row = await this.db<RefundRow>("refund_operation").where({ id }).first();
    if (!row || row.status !== "PROVIDER_SUCCEEDED" || !row.current_attempt_id) return;
    const attempt = await this.db<RefundAttemptRow>("provider_refund_attempt").where({ id: row.current_attempt_id }).first();
    if (!attempt?.verified_event_id || attempt.status !== "SUCCEEDED") throw refundConflict();
    const dispatch = await withRefund(this.db, id, async (trx, current) => {
      if (current.status !== "PROVIDER_SUCCEEDED" || current.native_dispatched_at) return false;
      await updateRefund(trx, current, { native_dispatched_at: await databaseTime(trx) }, "NATIVE_ACCOUNTING_DISPATCHED");
      return true;
    });
    if (!dispatch) {
      row = await this.db<RefundRow>("refund_operation").where({ id }).first();
      if (!row || row.status !== "PROVIDER_SUCCEEDED") return;
      const now = await this.db.transaction(trx => databaseTime(trx));
      if (!row.order_dispatched_at && row.native_dispatched_at && now.getTime() - new Date(row.native_dispatched_at).getTime() < 60000) return;
    }
    if (dispatch) {
      try { await this.native.refund(row, attempt); }
      catch { /* Read back exact native evidence below; never issue Yoco again. */ }
    }
    row = await this.db<RefundRow>("refund_operation").where({ id }).first();
    if (!row || row.status !== "PROVIDER_SUCCEEDED") return;
    let nativeId: string | null;
    try { nativeId = await this.native.inspectRefund(row, attempt); }
    catch { return this.attention(id, "NATIVE_REFUND_MISMATCH"); }
    if (!nativeId) {
      // Another worker may still be in the native call. Retain the reservation
      // and dispatch evidence; later passes only read, never repeat that call.
      return this.attention(id, "NATIVE_REFUND_RESULT_MISSING");
    }
    const orderDispatch = await withRefund(this.db, id, async (trx, current) => {
      if (current.status !== "PROVIDER_SUCCEEDED" || current.order_dispatched_at) return false;
      await updateRefund(trx, current, { order_dispatched_at: await databaseTime(trx) }, "ORDER_ACCOUNTING_DISPATCHED");
      return true;
    });
    if (orderDispatch) {
      try { await this.native.recordOrder(row); }
      catch { /* Recover by exact native refund reference, not a new write. */ }
    }
    let transaction: string | null;
    try { transaction = await this.native.inspectOrder(row); }
    catch { return this.attention(id, "NATIVE_ORDER_MISMATCH"); }
    if (!transaction) {
      const latest = await this.db<RefundRow>("refund_operation").where({ id }).first();
      if (latest?.order_dispatched_at && (await this.db.transaction(trx => databaseTime(trx))).getTime() - new Date(latest.order_dispatched_at).getTime() >= 60000)
        await this.attention(id, "NATIVE_ORDER_RESULT_MISSING");
      return;
    }
    const verifiedNativeId = nativeId, verifiedTransactionId = transaction;
    await withRefund(this.db, id, (trx, current) => this.settle(trx, current, verifiedNativeId, verifiedTransactionId));
  }
  // Kept as one transactional unit so fault injection can prove that local
  // audit/settlement rollback never repeats the already-completed native work.
  protected async settle(trx: Knex.Transaction, current: RefundRow, nativeId: string, transaction: string) {
    if (current.status === "SETTLED") return;
    if (current.status !== "PROVIDER_SUCCEEDED" || current.native_refund_id !== nativeId) throw refundConflict();
    await trx("financial_settlement").where({ id: current.settlement_id, state: "RESERVED" }).update({ state: "SETTLED", updated_at: trx.fn.now() });
    await updateRefund(trx, current, { status: "SETTLED", order_transaction_id: transaction, settled_at: await databaseTime(trx), attention_reason: null }, "SETTLED");
  }
  private async attention(id: string, reason: string) {
    await withRefund(this.db, id, async (trx, row) => {
      if (row.status !== "SETTLED" && row.attention_reason !== reason) await updateRefund(trx, row, { status: "ATTENTION_REQUIRED", attention_reason: reason }, "ATTENTION_REQUIRED");
    });
  }
  async repair(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw refundConflict();
    const due = await this.db("refund_operation as r").join("provider_refund_attempt as a", "a.id", "r.current_attempt_id")
      .whereIn("r.status", ["CREATED", "REQUESTED", "UNKNOWN", "PROVIDER_SUCCEEDED"])
      .where(builder => builder.whereNot("a.status", "PENDING").orWhereRaw("a.first_sent_at <= clock_timestamp() - interval '24 hours'"))
      .where(builder => builder.whereNull("a.lease_until").orWhereRaw("a.lease_until <= clock_timestamp()"))
      .select("r.id").orderBy("r.updated_at").orderBy("r.id").limit(limit);
    for (const row of due) {
      try { await this.advance(row.id, true); }
      catch { this.container.resolve<Logger>(ContainerRegistrationKeys.LOGGER).warn("Refund recovery deferred: " + row.id); }
    }
  }
}
