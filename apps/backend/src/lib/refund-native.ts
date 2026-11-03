import type { IPaymentModuleService, IOrderModuleService, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { nativePrice } from "../modules/marketplace/catalogue-policy";
import { checkoutMoney } from "./checkout-native";
import { refundConflict, type RefundRow, type RefundAttemptRow } from "../modules/marketplace/refund-policy";
import { nativeRefundCorrelation } from "./refund-metadata";

export interface RefundNative {
  refund(row: RefundRow, attempt: RefundAttemptRow): Promise<void>;
  inspectRefund(row: RefundRow, attempt: RefundAttemptRow): Promise<string | null>;
  recordOrder(row: RefundRow): Promise<void>;
  inspectOrder(row: RefundRow): Promise<string | null>;
}
// Narrow supported Payment and Order APIs. The stock refund workflow maps ALL
// historical refunds to the current input amount; it is deliberately not used.
export class NativeRefundAccounting implements RefundNative {
  constructor(private readonly container: MedusaContainer) {}
  async refund(row: RefundRow, attempt: RefundAttemptRow) {
    await this.container.resolve<IPaymentModuleService>(Modules.PAYMENT).refundPayment({
      payment_id: row.payment_id, amount: nativePrice(Number(row.amount_minor)),
      metadata: { gospazaRefundOperationId: row.id, gospazaProviderRefundId: attempt.provider_refund_id },
      note: "Approved GoSpaza financial adjustment",
    });
  }
  async inspectRefund(row: RefundRow, attempt: RefundAttemptRow) {
    if (!row.native_refund_id) return null;
    const payments = this.container.resolve<IPaymentModuleService>(Modules.PAYMENT);
    const payment = await payments.retrievePayment(row.payment_id, { relations: ["refunds", "captures"] });
    if (payment.currency_code !== "zar" || !payment.captures?.some(c => c.id === row.capture_id)) throw refundConflict();
    const matches = (payment.refunds ?? []).filter(r => nativeRefundCorrelation(r)?.gospazaRefundOperationId === row.id);
    if (!matches.length) return null;
    const refund = matches[0];
    if (matches.length !== 1 || !refund || refund.id !== row.native_refund_id
      || nativeRefundCorrelation(refund)?.gospazaProviderRefundId !== attempt.provider_refund_id
      || checkoutMoney(refund.amount) !== Number(row.amount_minor)) throw refundConflict();
    // A provisional row alone is insufficient. The provider callback must have
    // bound it, and native collection accounting must have completed too.
    const collection = await payments.retrievePaymentCollection(payment.payment_collection_id);
    const total = (payment.refunds ?? []).reduce((s, r) => s + BigInt(checkoutMoney(r.amount)), 0n);
    if (BigInt(checkoutMoney(collection.refunded_amount ?? 0)) < total) throw refundConflict();
    return refund.id;
  }
  async recordOrder(row: RefundRow) {
    if (!row.native_refund_id) throw refundConflict();
    await this.container.resolve<IOrderModuleService>(Modules.ORDER).addOrderTransactions({
      order_id: row.order_id, amount: "-" + nativePrice(Number(row.amount_minor)), currency_code: "zar",
      reference: "refund", reference_id: row.native_refund_id,
    });
  }
  async inspectOrder(row: RefundRow) {
    if (!row.native_refund_id) return null;
    const transactions = await this.container.resolve<IOrderModuleService>(Modules.ORDER).listOrderTransactions({
      order_id: row.order_id, reference: "refund", reference_id: row.native_refund_id,
    });
    if (!transactions.length) return null;
    const transaction = transactions[0];
    // checkoutMoney rejects negatives; invert the native decimal using its
    // string representation, without floating-point money arithmetic.
    const amount = String(transaction?.amount);
    if (transactions.length !== 1 || !transaction || transaction.currency_code !== "zar"
      || !amount.startsWith("-") || checkoutMoney(amount.slice(1)) !== Number(row.amount_minor)) throw refundConflict();
    return transaction.id;
  }
}
