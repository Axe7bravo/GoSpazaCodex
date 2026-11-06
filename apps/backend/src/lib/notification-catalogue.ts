import { z } from "@medusajs/framework/zod";
import { formatZarMinor } from "@gospaza/contracts";

type Audience = "customer" | "merchant" | "driver" | "user";
export interface NotificationDefinition { kind: string; audience: Audience; channels: readonly ("IN_APP" | "EMAIL")[];
  template: string; title: string; body: string; money?: boolean }
const customer = (kind: string, key: string, title: string, body: string, mail = false, money = false): NotificationDefinition =>
  ({ kind, template: "customer." + key, audience: "customer", channels: mail ? ["IN_APP", "EMAIL"] : ["IN_APP"], title, body, money });
const internal = (audience: Exclude<Audience, "customer">, kind: string, key: string, title: string, body: string, money = false): NotificationDefinition =>
  ({ audience, kind, template: (audience === "user" ? "platform" : audience) + "." + key, channels: ["IN_APP"], title, body, money });
export const productionCatalogue: readonly NotificationDefinition[] = [
  customer("ORDER_CONFIRMED", "order_confirmed", "Order confirmed", "Your order is confirmed. Open your order in GoSpaza for the latest details.", true),
  customer("ORDER_REJECTED_OR_UNFULFILLABLE", "order_rejected", "The store cannot fulfil your order", "The store declined this order. Open your order to view any separate financial resolution.", true),
  customer("ORDER_REJECTED_OR_UNFULFILLABLE", "order_unfulfillable", "Your order cannot be fulfilled", "Picking finished with all items omitted. Open your order to view the outcome and separate financial resolution.", true),
  customer("DRIVER_ASSIGNED", "driver_assigned", "Driver assigned", "A driver has been assigned. Open your order for the current delivery status."),
  customer("ORDER_PICKED_UP", "order_picked_up", "Order picked up", "Your order was picked up from the store and is out for delivery. Open your order for the current status."),
  customer("DELIVERY_COMPLETED", "delivery_completed", "Delivery completed", "Your delivery is complete. Open your order in GoSpaza to view the details.", true),
  customer("DELIVERY_FAILED_OR_RETURN_REQUIRED", "return_required", "Delivery could not be completed", "The order must return to the store. A physical return does not confirm a refund or credit. Open your order for further resolution."),
  customer("REFUND_CONFIRMED", "refund_confirmed", "Original-payment refund confirmed", "An original-payment refund is confirmed. Open your order for the authoritative financial details.", true, true),
  customer("STORE_CREDIT_ISSUED", "store_credit_issued", "GoSpaza balance issued", "Store Credit was issued to your GoSpaza balance for future orders. Open your order for the financial details.", true, true),
  internal("merchant", "NEW_ORDER_REQUIRING_ACTION", "new_order", "New order requires a decision", "Open the order to accept or reject it through the normal workflow."),
  internal("merchant", "ORDER_NO_LONGER_ACTIONABLE", "order_closed", "Order no longer awaiting a decision", "This order was rejected. Open it to review the authoritative outcome."),
  internal("merchant", "PICKING_OR_FULFILMENT_ATTENTION", "fulfilment_attention", "Fulfilment needs attention", "Open the assigned picking or fulfilment task to review the current action."),
  internal("merchant", "DRIVER_ASSIGNED", "driver_assigned", "Driver assigned", "Open the order or assigned picking task to coordinate pickup."),
  internal("merchant", "DELIVERY_COMPLETED", "delivery_completed", "Delivery completed", "Open the order to review its completed delivery status."),
  internal("merchant", "DELIVERY_RETURN_ACTION_REQUIRED", "return_action", "Return custody needs attention", "The delivery is returning to the store. Use the existing physical receipt workflow when the goods arrive."),
  internal("merchant", "RETURNED_GOODS_DISPOSITION_REQUIRED", "disposition_required", "Returned goods need a disposition", "Physical receipt is recorded. An authorized manager must decide the stock disposition; receipt alone does not restock goods."),
  internal("merchant", "SETTLEMENT_READY_OR_ATTENTION", "settlement_ready", "Settlement statement ready", "Open the statement to review its prepared financial position."),
  internal("merchant", "SETTLEMENT_READY_OR_ATTENTION", "settlement_failed", "Settlement payment needs review", "An unsuccessful external transfer attempt was recorded. Open the statement for its current status."),
  internal("merchant", "SETTLEMENT_PAID", "settlement_paid", "External settlement payment recorded", "An already-performed external transfer was recorded. This notice does not initiate a bank transfer.", true),
  internal("merchant", "SETTLEMENT_DISCREPANCY_ATTENTION", "settlement_discrepancy", "Settlement needs review", "A payment discrepancy is under review. Open the statement for its safe financial status."),
  internal("driver", "DISPATCH_OFFER_CREATED", "dispatch_offer", "Delivery offer available", "Open your current delivery offer. Availability and acceptance are checked again by dispatch."),
  internal("driver", "ASSIGNMENT_CONFIRMED", "assignment_confirmed", "Assignment confirmed", "Dispatch confirmed your assignment. Open your current delivery task."),
  internal("driver", "DELIVERY_PICKUP_ATTENTION", "delivery_attention", "Delivery task needs attention", "Open your current pickup, delivery or return task for the required next step."),
  internal("driver", "DRIVER_PAYMENT_RECORDED", "payment_recorded", "External payment recorded", "An already-performed external payment was recorded against your earnings. This is not a bank receipt acknowledgement.", true),
  internal("driver", "DRIVER_PAYMENT_RECONCILED", "payment_reconciled", "Recorded payment reconciled", "The recorded payment was separately reconciled. Open your earnings for the current financial status.", true),
  internal("driver", "DRIVER_PAYMENT_ATTENTION", "payment_attention", "Payment status needs attention", "Open your earnings for the current driver-safe payment status and any review outcome."),
  ...([ ["FINANCIAL_SETTLEMENT_ATTENTION", "financial_attention", "Customer compensation needs review"],
    ["MERCHANT_SETTLEMENT_ATTENTION", "settlement_attention", "Merchant settlement needs attention"],
    ["DRIVER_PAYMENT_ATTENTION", "driver_payment_attention", "Driver payment needs attention"],
    ["RECOGNITION_ATTENTION", "recognition_attention", "Financial recognition needs review"],
    ["DELIVERY_OPERATION_ATTENTION", "delivery_attention", "Delivery operations need attention"] ] as const).map(([kind, key, title]) =>
      internal("user", kind, key, title, "Review the current authorized operational view. This notice contains no private evidence.")),
];
const reference = z.string().min(1).max(80).refine(v => !v.includes("\0") && !/[\r\n]/.test(v));
export const productionModel = z.object({ reference }).strict();
const financialModel = productionModel.extend({ amount_minor: z.string().regex(/^\d{1,16}$/).refine(v => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)), currency: z.literal("zar") }).strict();
export function productionDefinition(template: string) {
  return productionCatalogue.find(row => row.template === template);
}
export function renderProduction(input: { template: string; kind: string; recipient: { type: string }; channel: string; version: number; input: unknown },
  escape: (text: string) => string) {
  const definition = productionDefinition(input.template);
  if (!definition || input.version !== 1 || definition.kind !== input.kind || definition.audience !== input.recipient.type
    || !definition.channels.some(channel => channel === input.channel)) throw Error("Unsupported notification template policy.");
  const data = definition.money ? financialModel.parse(input.input) : productionModel.parse(input.input);
  const amount = "amount_minor" in data ? " Amount: " + formatZarMinor(String(data.amount_minor)) + " ZAR." : "";
  const text = definition.body + amount + " Reference: " + data.reference + ".";
  return { title: definition.title, subject: definition.title, text,
    html: "<div><p>GoSpaza</p><h1>" + escape(definition.title) + "</h1><p>" + escape(text) + "</p></div>" };
}
