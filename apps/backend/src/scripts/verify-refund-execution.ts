import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { ExecArgs, IAuthModuleService, IPaymentModuleService, IOrderModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import verifyOrderOperations from "./verify-order-operations";
import { OrderOperationsService } from "../lib/order-operations-service";
import { FinancialService } from "../lib/financial-service";
import { RefundService } from "../lib/refund-service";
import { NativeRefundAccounting, type RefundNative } from "../lib/refund-native";
import { PgYocoOperationStore } from "../modules/marketplace/provider-operation-store";
import { reserveSettlement } from "../modules/marketplace/settlement-repository";
import type { RefundRow, RefundAttemptRow } from "../modules/marketplace/refund-policy";
import type { RefundTransport } from "../modules/yoco/refund-transport";
import { verifyYocoInboxEvent, type VerifiedRefundEvent } from "../modules/yoco/webhook";
import { fingerprint } from "../modules/yoco/request";
import { yocoConfiguration } from "../lib/yoco-config";
import { nativeRefundCorrelation } from "../lib/refund-metadata";

const execute = { action: "EXECUTE", reason: "APPROVED_ADJUSTMENT", confirmed: true };
const recover = { action: "RECONCILE", reason: "RECOVER_UNCERTAIN_REQUEST", confirmed: true };
const retry = { action: "RETRY_NOT_CREATED", reason: "RETRY_CONFIRMED_NOT_CREATED", expected_attempt_number: 1, confirmed: true };

export default async function verifyRefundExecution(args: ExecArgs) {
  if (process.env.REFUND_RECOVERY_WORKER_ENABLED === "true") throw new Error("Disable REFUND_RECOVERY_WORKER_ENABLED in both backend and verifier.");
  await verifyOrderOperations(args, async f => {
    const { container } = f.fixture, db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
    const auth = await container.resolve<IAuthModuleService>(Modules.AUTH).retrieveAuthIdentity(f.platform.identity);
    const user = String(auth.app_metadata?.user_id ?? ""); assert.ok(user);
    const previous = process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS;
    const rollback = new Error("C1 finance fixture rollback");
    const loadedConfig = yocoConfiguration(process.env);
    if (!loadedConfig || !loadedConfig.secretKey.startsWith("sk_test_")) {
      throw new Error("Refund verification requires enabled test-mode Yoco configuration.");
    }
    const config = loadedConfig;
    await new OrderOperationsService(container).decide(f.ownerB.identity, f.b.orderId, "reject", { expected_revision: 0, confirmed: true });
    const path = "/admin/gospaza/financial-adjustments/fadj_missing/refund";
    for (const cookie of ["", f.a.person.cookie, f.ownerA.cookie, f.picker.cookie]) f.expect(await f.http(cookie, "POST", path, execute), 401);
    f.expect(await f.http(f.platform.cookie, "POST", "/admin/payments/pay_fixture/refund", { amount: 1 }), 404);
    const noNative: RefundNative = {
      refund: async () => { throw new Error("Native dispatch must not occur without verified success"); },
      inspectRefund: async () => null, recordOrder: async () => { throw new Error("No native order write expected"); }, inspectOrder: async () => null,
    };
    async function isolated(work: (trx: Knex.Transaction, adjustment: string) => Promise<void>) {
      await assert.rejects(db.transaction(async trx => {
        const rows = await new FinancialService(container, trx).ensure(f.b.orderId);
        const adjustment = rows[0]; assert.ok(adjustment); assert.equal(adjustment.default_method, "ORIGINAL_PAYMENT");
        await work(trx, adjustment.id);
        // Exercise the real deferred audit/evidence/reservation branches before
        // rolling back. Never delete or disable financial-history constraints.
        await trx.raw("set constraints all immediate");
        throw rollback;
      }), error => error === rollback);
    }
    async function rowFor(trx: Knex.Transaction, adjustment: string) {
      const row = await trx<RefundRow>("refund_operation").where({ adjustment_id: adjustment }).first(); assert.ok(row);
      const attempt = await trx<RefundAttemptRow>("provider_refund_attempt").where({ id: row.current_attempt_id ?? "" }).first(); assert.ok(attempt);
      return { row, attempt };
    }
    async function event(trx: Knex.Transaction, service: RefundService, row: RefundRow, attempt: RefundAttemptRow,
      overrides: Partial<VerifiedRefundEvent> = {}, eventId = "evt_" + randomUUID()) {
      const normalized = { id: eventId, type: "refund.succeeded", checkoutId: row.checkout_id, paymentId: row.provider_payment_id,
        refundId: attempt.provider_refund_id ?? "rfd_" + attempt.id, amount: Number(row.amount_minor), currency: "ZAR", mode: row.mode,
        refundOperationId: row.id, refundAttemptId: attempt.id, ...overrides };
      const rawData = JSON.stringify({ id: normalized.id, type: normalized.type, payload: {
        id: normalized.refundId, paymentId: normalized.paymentId, type: "refund", status: normalized.type === "refund.succeeded" ? "succeeded" : "failed",
        amount: normalized.amount, currency: normalized.currency, mode: normalized.mode,
        metadata: { checkoutId: normalized.checkoutId, gospazaRefundOperationId: normalized.refundOperationId, gospazaRefundAttemptId: normalized.refundAttemptId },
      } });
      const timestamp = String(Math.floor(Date.now() / 1000)), webhookId = "wh_" + randomUUID();
      const key = Buffer.from(config.webhookSecret.slice(6), "base64");
      const verified = verifyYocoInboxEvent({ rawData, data: {}, headers: { "webhook-id": webhookId, "webhook-timestamp": timestamp,
        "webhook-signature": "v1," + createHmac("sha256", key).update(webhookId + "." + timestamp + "." + rawData).digest("base64") } }, config.webhookSecret);
      assert.ok(verified && (verified.type === "refund.succeeded" || verified.type === "refund.failed"));
      await trx("yoco_inbox").insert({ id: "yin_" + randomUUID(), event_id: verified.id, body_fingerprint: fingerprint(JSON.stringify(verified)), event: verified, state: "RECEIVED" }).onConflict("event_id").ignore();
      const inbox = await trx("yoco_inbox").where({ event_id: verified.id }).first(); assert.ok(inbox);
      assert.equal(await service.applyEvent(inbox.id, verified), true);
      return (await trx("yoco_inbox").where({ id: inbox.id }).first())?.state;
    }
    try {
      delete process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS;
      await assert.rejects(new RefundService(container).command(user, "fadj_missing", execute), /capability/);
      process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS = user;
      await isolated(async (trx, adjustment) => {
        const sent: RefundAttemptRow[] = [];
        const transport: RefundTransport = { send: async (_row, attempt) => {
          sent.push(attempt);
          return sent.length === 1 ? { kind: "UNKNOWN" } : { kind: "ACCEPTED", refundId: "rfd_" + attempt.id, status: 202 };
        } };
        const service = new RefundService(container, transport, noNative, trx);
        assert.equal((await service.command(user, adjustment, execute)).status, "UNKNOWN");
        await service.command(user, adjustment, execute); assert.equal(sent.length, 1);
        await service.command(user, adjustment, recover); assert.equal(sent.length, 2);
        assert.equal(sent[0]?.idempotency_key, sent[1]?.idempotency_key); assert.equal(sent[0]?.request_json, sent[1]?.request_json);
        assert.equal((await trx("refund_operation")).filter(r => r.adjustment_id === adjustment).length, 1);
        const { row, attempt } = await rowFor(trx, adjustment);
        assert.equal(row.status, "REQUESTED"); assert.equal(row.native_dispatched_at, null);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("provider_refund_attempt").where({ id: attempt.id }).update({ request_json: "{}" });
        }), /Immutable provider refund attempt/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("provider_refund_attempt").insert({ ...attempt, id: "rfat_" + randomUUID(), idempotency_key: "forged_" + randomUUID(), attempt_number: 2 });
        }), /Refund attempt authority/);
        for (const change of [{ paymentId: "pmt_foreign" }, { amount: Number(row.amount_minor) + 1 }, { refundOperationId: "rfop_foreign" }, { mode: "live" as const }, { refundId: "rfd_foreign" }])
          assert.equal(await event(trx, service, row, attempt, change), "REJECTED");
        const source = await trx("financial_adjustment").where({ id: adjustment }).first(); assert.ok(source);
        await assert.rejects(trx.transaction(t => reserveSettlement(t, source, "ORIGINAL_PAYMENT", 1)), /Settlement entitlement exceeded/);
        await assert.rejects(trx.transaction(t => reserveSettlement(t, source, "STORE_CREDIT", 1)), /review|Settlement eligibility/);
        // A separate PostgreSQL connection cannot enter the provider's critical
        // section while this worker owns it. This is not an in-memory mutex.
        await assert.rejects(db.transaction(async competitor => {
          await competitor("provider_operation").where({ id: row.provider_operation_id }).forUpdate().noWait().first();
        }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "55P03");
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("refund_operation").where({ id: row.id }).update({ revision: row.revision + 1 });
          await invalid.raw("set constraints refund_consistency_check immediate");
        }), /Refund audit required/);
        await assert.rejects(trx.transaction(async invalid => {
          await invalid("financial_settlement").where({ id: row.settlement_id }).update({ state: "RELEASED" });
          await invalid.raw("set constraints refund_reservation_check immediate");
        }), /Refund reservation consistency/);
        await assert.rejects(service.command(user, adjustment, retry));
        const failedId = "evt_" + randomUUID();
        assert.equal(await event(trx, service, row, attempt, { type: "refund.failed" }, failedId), "APPLIED");
        assert.equal(await event(trx, service, row, attempt, { type: "refund.failed" }, failedId), "APPLIED");
        assert.equal((await service.command(user, adjustment, recover)).status, "FAILED");
        assert.equal((await trx("financial_settlement").where({ id: row.settlement_id }).first())?.state, "RESERVED");
        assert.equal(sent.length, 2);
      });
      await isolated(async (trx, adjustment) => {
        const sent: RefundAttemptRow[] = [];
        const service = new RefundService(container, { send: async (_row, attempt) => {
          sent.push(attempt); return sent.length === 1 ? { kind: "NOT_CREATED", status: 400 } : { kind: "ACCEPTED", refundId: "rfd_" + attempt.id, status: 202 };
        } }, noNative, trx);
        assert.equal((await service.command(user, adjustment, execute)).status, "FAILED_NOT_CREATED");
        await service.command(user, adjustment, execute); assert.equal(sent.length, 1);
        await service.command(user, adjustment, retry); assert.equal(sent.length, 2);
        await service.command(user, adjustment, retry); assert.equal(sent.length, 2);
        assert.notEqual(sent[0]?.idempotency_key, sent[1]?.idempotency_key);
        assert.equal(sent[1]?.attempt_number, 2);
        assert.equal((await trx("financial_settlement").where({ adjustment_id: adjustment })).length, 1);
        assert.equal((await trx("provider_refund_attempt").where({ refund_operation_id: sent[1]?.refund_operation_id })).length, 2);
      });
      // Real native Payment/Refund + OrderTransaction, with response-loss fault
      // injection AFTER each native mutation. Finance stays in a rollback scope;
      // only its provider callback is routed to that same scope. Native writes
      // use real module APIs and the parent verifier's existing native cleanup.
      await isolated(async (trx, adjustment) => {
        let sends = 0, nativeCalls = 0, orderCalls = 0;
        const localFailure = new Error("Local settlement commit lost");
        class LostLocalSettlement extends RefundService {
          private failOnce = true;
          protected override async settle(tx: Knex.Transaction, row: RefundRow, nativeId: string, transaction: string) {
            await super.settle(tx, row, nativeId, transaction);
            if (this.failOnce) { this.failOnce = false; throw localFailure; }
          }
        }
        class LostNativeResponses extends NativeRefundAccounting {
          override async refund(row: RefundRow, attempt: RefundAttemptRow) { nativeCalls++; await super.refund(row, attempt); throw new Error("Native response lost"); }
          override async recordOrder(row: RefundRow) { orderCalls++; await super.recordOrder(row); throw new Error("Order accounting response lost"); }
        }
        const original = PgYocoOperationStore.prototype.recordApprovedRefund;
        const store = new PgYocoOperationStore(trx);
        let providerId = "";
        PgYocoOperationStore.prototype.recordApprovedRefund = function (id, nativeId, amount) {
          return original.call(id === providerId ? store : this, id, nativeId, amount);
        };
        const transport: RefundTransport = { send: async (row, attempt) => {
          sends++; providerId = row.provider_operation_id;
          // Signed webhook wins before the original 202 response returns.
          assert.equal(await event(trx, service, row, attempt), "APPLIED");
          return { kind: "ACCEPTED", refundId: "rfd_" + attempt.id, status: 202 };
        } };
        const service = new LostLocalSettlement(container, transport, new LostNativeResponses(container), trx);
        try {
          await assert.rejects(service.command(user, adjustment, execute), error => error === localFailure);
          const uncertain = await rowFor(trx, adjustment);
          assert.equal(uncertain.row.status, "PROVIDER_SUCCEEDED");
          assert.equal((await trx("financial_settlement").where({ id: uncertain.row.settlement_id }).first())?.state, "RESERVED");
          assert.equal((await service.command(user, adjustment, recover)).status, "SETTLED");
          const { row, attempt } = await rowFor(trx, adjustment);
          assert.ok(row.native_refund_id); assert.ok(row.order_transaction_id);
          assert.equal((await service.command(user, adjustment, execute)).status, "SETTLED");
          assert.equal((await service.command(user, adjustment, recover)).status, "SETTLED");
          assert.equal(await event(trx, service, row, attempt), "APPLIED");
          assert.equal(sends, 1); assert.equal(nativeCalls, 1); assert.equal(orderCalls, 1);
          const payment = await container.resolve<IPaymentModuleService>(Modules.PAYMENT).retrievePayment(row.payment_id, { relations: ["refunds"] });
          assert.equal(payment.refunds?.filter(r => nativeRefundCorrelation(r)?.gospazaRefundOperationId === row.id).length, 1);
          const transactions = await container.resolve<IOrderModuleService>(Modules.ORDER).listOrderTransactions({ order_id: row.order_id, reference: "refund", reference_id: row.native_refund_id });
          assert.equal(transactions.length, 1);
          assert.equal((await trx("financial_settlement").where({ id: row.settlement_id }).first())?.state, "SETTLED");
          const dto = JSON.stringify(await service.view(row.id));
          for (const forbidden of ["checkout_id", "payment_id", "idempotency", "provider_refund", "native_refund", "account_fingerprint"]) assert.equal(dto.includes(forbidden), false);
          await assert.rejects(trx.transaction(async invalid => { await invalid("refund_event").where({ refund_operation_id: row.id }).delete(); }), /Refund audit append only/);
        } finally { PgYocoOperationStore.prototype.recordApprovedRefund = original; }
      });
    } finally {
      if (previous === undefined) delete process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS; else process.env.FINANCIAL_EXECUTE_REFUND_USER_IDS = previous;
    }
  });
  console.log("M18-C1 refund verification passed: frozen attempts, signed correlation, reservations, DB locking, native readback, audit and actor denial. No real Yoco refunds sent.");
}
