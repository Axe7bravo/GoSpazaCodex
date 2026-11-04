import { createHash } from "node:crypto";
import type { ICustomerModuleService, IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { z } from "@medusajs/framework/zod";
import type { CompletedOrderHandoff } from "../modules/marketplace/order-operation-policy";
import { readOperationalOrder, nativeOrderQuantity } from "./order-operation-native";
import { financialConflict, safeSum } from "../modules/marketplace/financial-policy";
import { checkoutMoney as financialMinor } from "./checkout-native";
import type { FinancialLine } from "../modules/marketplace/financial-policy";
import { nativeRefundCorrelation } from "./refund-metadata";

export interface FinancialEconomics {
  order_id: string; customer_id: string | null; registered: boolean; paid_minor: number;
  lines: FinancialLine[]; shipping_net_minor: number; shipping_tax_minor: number; fingerprint: string;
}
export async function readFinancialEconomics(container: MedusaContainer, handoff: CompletedOrderHandoff): Promise<FinancialEconomics> {
  const { order, payment, economics } = await readFinancialOrder(container,handoff);
  // C1 recognizes only an exact externally verified, locally designated native
  // refund. Out-of-band or provisional/uncorrelated refunds still fail closed.
  const db=container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  for(const refund of payment.refunds ?? []) {
    const owned=await db("refund_operation as r").join("provider_refund_attempt as a","a.id","r.current_attempt_id")
      .where({"r.native_refund_id":refund.id,"r.payment_id":payment.id,"r.order_id":handoff.order_id,"a.status":"SUCCEEDED"})
      .whereNotNull("a.verified_event_id").select("r.id","r.amount_minor","a.provider_refund_id").first();
    const correlation=nativeRefundCorrelation(refund);
    if(!owned || correlation?.gospazaRefundOperationId!==owned.id
      || correlation?.gospazaProviderRefundId!==owned.provider_refund_id
      || financialMinor(refund.amount)!==Number(owned.amount_minor)) throw financialConflict();
  }
  let registered = false;
  if (order.customer_id) {
    // has_account belongs to the native Customer; missing/failed lookup is not a guest fallback.
    const customer = await container.resolve<ICustomerModuleService>(Modules.CUSTOMER).retrieveCustomer(order.customer_id);
    if (typeof customer.has_account !== "boolean") throw financialConflict();
    registered = customer.has_account;
  }
  return { ...economics, registered };
}
export async function readFinancialOrder(container: MedusaContainer, handoff: CompletedOrderHandoff) {
  const order = await readOperationalOrder(container,handoff);
  const receipt=z.object({ payment_id:z.string(),capture_id:z.string(),amount_minor:z.number().int() }).parse(handoff.terminal_receipt);
  const payment=await container.resolve<IPaymentModuleService>(Modules.PAYMENT).retrievePayment(receipt.payment_id,{ relations:["captures","refunds"] });
  if (!payment.captures?.some(c=>c.id===receipt.capture_id)
    || receipt.amount_minor!==handoff.snapshot.totals.total_minor) throw financialConflict();
  const lines = (order.items ?? []).map(item => {
    const paid = financialMinor(item.total), tax = financialMinor(item.tax_total);
    const snapshot = handoff.snapshot.items.filter(i => i.variant_id === item.variant_id);
    // No historical repricing: native recorded discounted totals must still match M10.
    if (snapshot.length !== 1 || snapshot[0]?.total_minor !== paid || snapshot[0]?.quantity !== nativeOrderQuantity(item.quantity) || tax > paid) throw financialConflict();
    return { id:item.id, quantity:nativeOrderQuantity(item.quantity), net_minor:paid-tax, tax_minor:tax };
  }).sort((a,b) => a.id.localeCompare(b.id));
  const shipping = order.shipping_methods?.[0];
  if (!shipping) throw financialConflict();
  const shippingTotal = financialMinor(shipping.total), shippingTax = financialMinor(shipping.tax_total);
  const external = financialMinor(order.total);
  const funding=handoff.snapshot.store_credit;
  const paid=funding ? safeSum([external,funding.amount_minor]):external;
  if(funding) {
    const line=order.credit_lines?.[0];
    if(order.credit_lines?.length!==1 || !line || line.reference!=="store-credit" || line.reference_id!==funding.account_id
      || financialMinor(line.amount)!==funding.amount_minor || paid!==funding.gross_minor) throw financialConflict();
  }
  if (shippingTax > shippingTotal || external !== handoff.snapshot.totals.total_minor
    || safeSum(lines.flatMap(l => [l.net_minor,l.tax_minor]).concat(shippingTotal)) !== paid
    || safeSum(lines.map(l => l.tax_minor).concat(shippingTax)) !== handoff.snapshot.totals.tax_total_minor) throw financialConflict();
  const economics = { order_id:order.id, customer_id:order.customer_id ?? null, 
    paid_minor:paid, lines, shipping_net_minor:shippingTotal-shippingTax, shipping_tax_minor:shippingTax };
  // Account registration is current eligibility, not historical price authority.
  const fingerprint = createHash("sha256").update(JSON.stringify(economics)).digest("hex");
  return { order, payment, economics: { ...economics, fingerprint } };
}
