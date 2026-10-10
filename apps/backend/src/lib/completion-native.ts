import { z } from "@medusajs/framework/zod";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ICartModuleService, IOrderModuleService, IPaymentModuleService, IWorkflowEngineService, MedusaContainer } from "@medusajs/framework/types";
import type { CompletionRow } from "../modules/marketplace/reconciliation-types";
import type { OperationRow } from "../modules/marketplace/provider-operation-store";
import type { CheckoutSnapshot } from "../modules/marketplace/checkout-policy";
import { checkoutMoney } from "./checkout-native";
import { verifiedPayment } from "../modules/yoco/webhook";
import { YOCO_PROVIDER_ID } from "./yoco-config";

const nativeExecution = z.object({
  id: z.string(), workflow_id: z.string(), transaction_id: z.string(), state: z.string(),
  execution: z.object({ runId: z.string(), steps: z.record(z.string(), z.unknown()) }),
});
export function completionDisposition(state: string | null) {
  return state === "done" ? "VALIDATE_NATIVE_ORDER" : "RECOVERY_REQUIRED";
}

export async function inspectCompletion(container: MedusaContainer, completion: CompletionRow) {
  const executions = await container.resolve<IWorkflowEngineService>(Modules.WORKFLOW_ENGINE).listWorkflowExecutions({
    workflow_id: completion.workflow_id, transaction_id: completion.transaction_id,
  }, { take: null });
  if (executions.length !== 1) return null;
  return completionObservation(executions[0], completion);
}

export function completionObservation(value: unknown, completion: Pick<CompletionRow, "workflow_id" | "transaction_id" | "execution_id" | "run_id">) {
  const parsed = nativeExecution.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  if (row.workflow_id !== completion.workflow_id || row.transaction_id !== completion.transaction_id
    || completion.execution_id && completion.execution_id !== row.id
    || completion.run_id && completion.run_id !== row.execution.runId) return null;
  // Record only step/action state, never workflow context containing addresses.
  const unresolved = Object.entries(row.execution.steps).flatMap(([id, value]) => {
    const step = z.object({ invoke: z.object({ state: z.string(), status: z.string().optional() }).optional(),
      compensate: z.object({ state: z.string(), status: z.string().optional() }).optional() }).safeParse(value);
    if (!step.success) return [{ id, action: "unknown", state: "unknown" }];
    return Object.entries(step.data).filter(([, action]) => action && !["done", "reverted", "not_started"].includes(action.state))
      .map(([action, status]) => ({ id, action, state: status?.state ?? "unknown", status: status?.status }));
  });
  return { id: row.id, runId: row.execution.runId, state: row.state, unresolved };
}

export async function capturedNativePayment(container: MedusaContainer, operation: OperationRow) {
  if (!operation.payment_collection_id || !operation.financial_session_id
    || operation.canonical_session_id !== operation.financial_session_id) throw new Error("PAYMENT_NATIVE_RECOVERY_REQUIRED");
  const evidence = verifiedPayment.parse(operation.verified_payment);
  if (evidence.type !== "payment.succeeded") throw new Error("PAYMENT_CAPTURE_EVIDENCE_MISSING");
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT);
  const collection = await payments.retrievePaymentCollection(operation.payment_collection_id, {
    relations: ["payments", "payments.payment_session", "payments.captures", "payments.refunds"],
  });
  const payment = collection.payments?.[0];
  if (collection.payments?.length !== 1 || !payment || payment.canceled_at
    || collection.metadata?.gospaza_operation_id !== operation.id
    || payment.provider_id !== YOCO_PROVIDER_ID || payment.payment_session?.id !== operation.financial_session_id
    || payment.data?.operation_id !== operation.id || payment.currency_code !== "zar" || collection.currency_code !== "zar"
    || payment.data?.yocoPaymentId !== evidence.paymentId || payment.data?.yocoCheckoutId !== evidence.checkoutId
    || checkoutMoney(collection.amount) !== Number(operation.amount_minor)
    || checkoutMoney(payment.amount) !== Number(operation.amount_minor)
    || payment.captures?.length !== 1 || checkoutMoney(payment.captures[0]?.amount) !== Number(operation.amount_minor)) {
    throw new Error("PAYMENT_NATIVE_RECOVERY_REQUIRED");
  }
  return payment;
}

const orderLink = z.object({ order_id: z.string(), cart_id: z.string() });
const orderCollections = z.object({ id: z.string(), payment_collections: z.array(z.object({ id: z.string() })) });
export async function validateCompletedOrder(container: MedusaContainer, operation: OperationRow, snapshot: CheckoutSnapshot) {
  const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: unknown[] }> }>(ContainerRegistrationKeys.QUERY);
  const links = await query.graph({ entity: "order_cart", fields: ["order_id", "cart_id"], filters: { cart_id: snapshot.cart_id } });
  if (links.data.length !== 1) throw new Error("COMPLETION_ORDER_RELATIONSHIP");
  const link = orderLink.parse(links.data[0]);
  if (link.cart_id !== snapshot.cart_id) throw new Error("COMPLETION_CART_RELATIONSHIP");
  const order = await container.resolve<IOrderModuleService>(Modules.ORDER).retrieveOrder(link.order_id, {
    select: ["id", "customer_id", "currency_code", "sales_channel_id", "status", "total", "subtotal", "tax_total", "discount_total", "shipping_total"],
    relations: ["items", "items.tax_lines", "items.adjustments", "shipping_methods", "shipping_methods.tax_lines", "shipping_methods.adjustments", "shipping_address", "transactions"],
  });
  const cart = await container.resolve<ICartModuleService>(Modules.CART).retrieveCart(snapshot.cart_id);
  const linked = await query.graph({ entity: "order", fields: ["id", "payment_collections.id"], filters: { id: order.id } });
  if (linked.data.length !== 1) throw new Error("COMPLETION_COLLECTION_RELATIONSHIP");
  const collections = orderCollections.parse(linked.data[0]);
  if (collections.id !== order.id) throw new Error("COMPLETION_ORDER_IDENTITY");
  const payment = await capturedNativePayment(container, operation);
  if (!cart.completed_at || cart.customer_id !== snapshot.customer_id || order.customer_id !== snapshot.customer_id
    || order.sales_channel_id !== cart.sales_channel_id
    || order.currency_code !== "zar" || order.status === "canceled"
    || collections.payment_collections.length !== 1 || collections.payment_collections[0]?.id !== operation.payment_collection_id
    || payment.refunds?.length || !payment.captured_at) throw new Error("COMPLETION_COMMERCIAL_RELATIONSHIP");
  const totals = { total_minor: checkoutMoney(order.total), subtotal_minor: checkoutMoney(order.subtotal),
    tax_total_minor: checkoutMoney(order.tax_total), discount_total_minor: checkoutMoney(order.discount_total),
    shipping_total_minor: checkoutMoney(order.shipping_total) };
  if (JSON.stringify(totals) !== JSON.stringify(snapshot.totals)) throw new Error("COMPLETION_TOTAL_MISMATCH");
  const items = (order.items ?? []).map((item) => ({ variant_id: item.variant_id, quantity: Number(item.quantity), unit_price_minor: checkoutMoney(item.unit_price), total_minor: checkoutMoney(item.total) }))
    .sort((a, b) => String(a.variant_id).localeCompare(String(b.variant_id)));
  const expected = snapshot.items.map(({ variant_id, quantity, unit_price_minor, total_minor }) => ({ variant_id, quantity, unit_price_minor, total_minor }))
    .sort((a, b) => a.variant_id.localeCompare(b.variant_id));
  const shipping = order.shipping_methods?.[0];
  const address = order.shipping_address;
  if (JSON.stringify(items) !== JSON.stringify(expected) || order.shipping_methods?.length !== 1
    || shipping?.shipping_option_id !== snapshot.shipping_option_id || !address
    || Object.entries(snapshot.address).some(([key, value]) => {
      const actual = z.record(z.string(), z.unknown()).parse(address)[key];
      return (actual ?? "") !== value;
    })) throw new Error("COMPLETION_SNAPSHOT_MISMATCH");
  const capture = payment.captures?.[0];
  if (!capture || !order.transactions?.some((transaction) => transaction.reference === "capture" && transaction.reference_id === capture.id && transaction.currency_code === "zar"
    && checkoutMoney(transaction.amount) === Number(operation.amount_minor))) throw new Error("COMPLETION_CAPTURE_TRANSACTION_MISSING");
  return { order_id: order.id, cart_id: cart.id, payment_id: payment.id, capture_id: capture.id,
    payment_collection_id: operation.payment_collection_id, amount_minor: Number(operation.amount_minor), currency: "zar" };
}
