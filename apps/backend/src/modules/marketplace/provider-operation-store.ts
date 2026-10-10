import { randomUUID } from "node:crypto";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { InferTypeOf } from "@medusajs/framework/types";
import type Operation from "./models/provider-operation";
import type Session from "./models/provider-session";
import type { Attempt } from "./checkout-repository";
import { databaseTime } from "./delivery-reservation-repository";
import { checkoutSnapshot } from "./checkout-policy";
import { checkoutReceipt } from "../yoco/validation";
import { fingerprint, initiationRequest } from "../yoco/request";
import {
  YocoOperationStore, YocoProviderError, type YocoOperation, type CheckoutReceipt,
  type RefundReceipt, type YocoOptions,
} from "../yoco/types";
import type { CompensationRow } from "./reconciliation-types";
import { refundReceipt } from "../yoco/validation";
import { verifiedRefund } from "../yoco/webhook";
import { verifiedPayment } from "../yoco/webhook";

export type OperationRow = Omit<InferTypeOf<typeof Operation>, "amount_minor"> & { amount_minor: string | number };
type SessionRow = InferTypeOf<typeof Session>;
const denied = () => new YocoProviderError("YOCO_CORRELATION_MISMATCH");

// SQL stays in Marketplace-owned coordination tables. Native resources are
// established/read by the orchestration service through Medusa public APIs.
export class PgYocoOperationStore extends YocoOperationStore {
  constructor(private db: Knex) { super(); }

  async row(id: string) {
    const row = await this.db<OperationRow>("provider_operation").where({ id }).whereNull("deleted_at").first();
    if (!row) throw denied();
    return row;
  }

  async read(id: string): Promise<YocoOperation | null> {
    const row = await this.db<OperationRow>("provider_operation").where({ id }).whereNull("deleted_at").first();
    if (!row) return null;
    const attempt = await this.db<Attempt>("checkout_attempt").where({ id: row.checkout_attempt_id }).first();
    if (!attempt) throw denied();
    const sessions = await this.db<SessionRow>("provider_session").where({ operation_id: id });
    const payment = row.verified_payment ? verifiedPayment.parse(row.verified_payment) : undefined;
    const refund = await this.db<CompensationRow>("technical_compensation").where({ operation_id: id }).first();
    return {
      technicalRefund: refund ? {
        id: refund.id, idempotencyKey: refund.idempotency_key, paymentId: refund.provider_payment_id,
        amountMinor: Number(refund.amount_minor), state: refund.state,
        receipt: refund.receipt ? refundReceipt.parse(refund.receipt) : undefined,
        verifiedEventId: refund.verified_event && verifiedRefund.parse(refund.verified_event).type === "refund.succeeded"
          ? verifiedRefund.parse(refund.verified_event).id : undefined,
        replayAllowed: refund.replay_allowed,
      } : undefined,
      id, attemptId: attempt.id, cartId: attempt.medusa_cart_id,
      paymentCollectionId: row.payment_collection_id ?? "",
      sessionIds: sessions.map((session) => session.native_session_id),
      canonicalSessionId: row.canonical_session_id ?? undefined,
      amountMinor: Number(row.amount_minor), currency: "ZAR", mode: row.mode,
      accountFingerprint: row.account_fingerprint, idempotencyKey: row.idempotency_key,
      state: row.state, requestJson: row.request_json, requestFingerprint: row.request_fingerprint,
      checkout: row.checkout_receipt ? checkoutReceipt.parse(row.checkout_receipt) : undefined,
      checkoutId: row.checkout_id ?? undefined, payment, terminalRefunded: row.terminal_refunded,
    };
  }

  async prepare(trx: Knex.Transaction, attempt: Attempt, config: YocoOptions) {
    const existing = await trx<OperationRow>("provider_operation").where({ checkout_attempt_id: attempt.id }).first();
    if (existing) return existing;
    const snapshot = checkoutSnapshot.parse(attempt.snapshot);
    const amount = snapshot.totals.total_minor;
    if (amount < 200) throw new YocoProviderError("YOCO_INVALID_INPUT");
    const id = "yop_" + randomUUID();
    const requestJson = initiationRequest(id, attempt.id, amount, config);
    const [created] = await trx<OperationRow>("provider_operation").insert({
      id, checkout_attempt_id: attempt.id, amount_minor: amount,
      currency_code: "zar", mode: config.secretKey.startsWith("sk_live_") ? "live" : "test",
      account_fingerprint: fingerprint(config.secretKey),
      idempotency_key: "gospaza_" + id, request_json: requestJson,
      request_fingerprint: fingerprint(requestJson), state: "prepared",
    }).returning("*");
    if (!created) throw denied();
    return created;
  }

  async attachCollection(id: string, collectionId: string) {
    await this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      if (!row || row.payment_collection_id && row.payment_collection_id !== collectionId) throw denied();
      await trx("provider_operation").where({ id }).update({ payment_collection_id: collectionId, updated_at: trx.fn.now() });
    });
  }

  private async payable(trx: Knex.Transaction, row: OperationRow) {
    const attempt = await trx<Attempt>("checkout_attempt").where({ id: row.checkout_attempt_id }).first();
    const now = await databaseTime(trx);
    return !!attempt && attempt.state === "PAYMENT_PENDING" && !attempt.closed_at
      && !!attempt.payment_deadline && new Date(attempt.payment_deadline) > now;
  }

  // Caller owns the customer boundary and has inspected native resources.
  // This explicit one-use permit also prevents native compensation from silently
  // creating another session/checkout using data copied from an old session.
  async permitSession(id: string, recover: boolean) {
    return this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      if (!row || !row.payment_collection_id || row.financial_session_id || row.terminal_refunded || row.state === "mismatch") throw denied();
      const captured = row.verified_payment && verifiedPayment.parse(row.verified_payment).type === "payment.succeeded";
      if (!captured && !await this.payable(trx, row)) throw new YocoProviderError("YOCO_OPERATION_EXPIRED");
      const token = randomUUID();
      await trx("provider_operation").where({ id }).update({
        session_token: token, replay_allowed: recover, canonical_session_id: null, updated_at: trx.fn.now(),
      });
      return token;
    });
  }

  async associateSession(id: string, sessionId: string, token: string | undefined) {
    await this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      const existing = await trx<SessionRow>("provider_session").where({ native_session_id: sessionId }).first();
      if (!row || row.terminal_refunded || row.state === "mismatch") throw denied();
      if (existing) {
        if (existing.operation_id !== id || existing.payment_collection_id !== row.payment_collection_id) throw denied();
        return;
      }
      if (!token || token !== row.session_token || !row.payment_collection_id || row.financial_session_id) throw denied();
      await trx("provider_session").insert({
        id: "yps_" + randomUUID(), operation_id: id, native_session_id: sessionId,
        payment_collection_id: row.payment_collection_id,
      });
      await trx("provider_operation").where({ id }).update({ session_token: null, updated_at: trx.fn.now() });
    });
  }

  async selectCanonical(id: string, sessionId: string) {
    await this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      const association = await trx("provider_session").where({ operation_id: id, native_session_id: sessionId }).first();
      if (!row || !association || row.financial_session_id && row.financial_session_id !== sessionId) throw denied();
      await trx("provider_operation").where({ id }).update({ canonical_session_id: sessionId, replay_allowed: false, updated_at: trx.fn.now() });
    });
  }

  async claimAuthorization(id: string, sessionId: string) {
    return this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      if (!row || row.terminal_refunded || row.canonical_session_id !== sessionId
        || row.financial_session_id && row.financial_session_id !== sessionId || !row.verified_payment
        || verifiedPayment.parse(row.verified_payment).type !== "payment.succeeded") return false;
      await trx("provider_operation").where({ id }).update({ financial_session_id: sessionId, updated_at: trx.fn.now() });
      return true;
    });
  }

  async claimInitiation(id: string, requestJson: string) {
    return this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      if (!row || row.request_json !== requestJson || row.request_fingerprint !== fingerprint(requestJson)) throw denied();
      if (row.terminal_refunded || row.verified_payment || row.checkout_id || row.state === "mismatch") return false;
      if (!await this.payable(trx, row)) throw new YocoProviderError("YOCO_OPERATION_EXPIRED");
      if (row.state !== "prepared" && !(row.replay_allowed && ["sending", "uncertain"].includes(row.state))) return false;
      await trx("provider_operation").where({ id }).update({ state: "sending", replay_allowed: false, updated_at: trx.fn.now() });
      return true;
    });
  }

  async saveCheckout(id: string, receipt: CheckoutReceipt) {
    await this.db.transaction(async (trx) => {
      const row = await trx<OperationRow>("provider_operation").where({ id }).forUpdate().first();
      if (!row || row.checkout_id && row.checkout_id !== receipt.id
        || Number(row.amount_minor) !== receipt.amount || row.mode !== receipt.processingMode || receipt.currency !== "ZAR") throw denied();
      if (row.verified_payment && verifiedPayment.parse(row.verified_payment).checkoutId !== receipt.id) throw denied();
      await trx("provider_operation").where({ id }).update({
        checkout_id: receipt.id, checkout_receipt: receipt, state: "created", updated_at: trx.fn.now(),
      });
    });
  }

  async markInitiationUncertain(id: string, mismatch = false) {
    await this.db("provider_operation").where({ id }).whereNull("checkout_id").whereNull("verified_payment")
      .whereNot({ state: "mismatch" }).update({ state: mismatch ? "mismatch" : "uncertain", replay_allowed: false, updated_at: this.db.fn.now() });
  }

  async claimRefund(id: string, refundId: string, request: string): Promise<boolean> {
    return this.db.transaction(async (trx) => {
      const row = await trx<CompensationRow>("technical_compensation").where({ id: refundId, operation_id: id }).forUpdate().first();
      // A completion dispatch, even a reverted/failed one, needs separate proof.
      // Automatic late-payment compensation is only approved before any dispatch.
      const completion = await trx("checkout_completion").where({ operation_id: id }).whereNotNull("dispatched_at").first();
      if (!row || completion || row.recovery_required || row.request_json !== request) throw new YocoProviderError("YOCO_REFUND_NOT_APPROVED");
      if (row.state === "succeeded" || row.state !== "prepared" && !row.replay_allowed) return false;
      await trx("technical_compensation").where({ id: refundId }).update({ state: "sending", replay_allowed: false, updated_at: trx.fn.now() });
      return true;
    });
  }
  async saveRefund(id: string, refundId: string, receipt: RefundReceipt): Promise<void> {
    await this.db.transaction(async (trx) => {
      const row = await trx<CompensationRow>("technical_compensation").where({ id: refundId, operation_id: id }).forUpdate().first();
      const operation = await trx<OperationRow>("provider_operation").where({ id }).first();
      if (!row || !operation || receipt.id !== operation.checkout_id
        || row.receipt && refundReceipt.parse(row.receipt).refundId !== receipt.refundId) throw denied();
      // An older pending response cannot overwrite verified success.
      await trx("technical_compensation").where({ id: refundId }).update({
        receipt, state: row.state === "succeeded" ? "succeeded" : receipt.status, updated_at: trx.fn.now(),
      });
    });
  }
  async markRefundUncertain(id: string, refundId: string, mismatch = false): Promise<void> {
    await this.db("technical_compensation").where({ id: refundId, operation_id: id })
      .whereIn("state", ["prepared", "sending", "uncertain"])
      .update({ state: "uncertain", ...(mismatch ? { recovery_required: true } : {}), updated_at: this.db.fn.now() });
  }
}
