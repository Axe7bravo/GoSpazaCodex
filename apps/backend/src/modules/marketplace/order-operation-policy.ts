import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { checkoutSnapshot } from "./checkout-policy";
import { resourceId } from "./team-policy";

export const orderStatus = z.enum(["PENDING_ACCEPTANCE", "ACCEPTED", "REJECTED"]);
export const orderListInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  status: orderStatus.optional(),
}).strict();
export function orderParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid order request.");
  return parsed.data;
}
export const orderUnavailable = () => new MedusaError(MedusaError.Types.CONFLICT, "Order information is unavailable. Please refresh.");

// Existing M10 durable receipt. Workflow history is deliberately not required.
const terminalReceipt = z.object({
  order_id: resourceId, cart_id: resourceId, payment_id: resourceId, capture_id: resourceId,
  payment_collection_id: resourceId, amount_minor: z.number().int().nonnegative(), currency: z.literal("zar"),
  workflow_id: z.string().min(1), transaction_id: z.string().min(1), execution_id: z.string().min(1),
  run_id: z.string().min(1), verified_at: z.string().datetime(),
});
export const handoffRecord = z.object({
  completion_id: resourceId, order_id: resourceId, terminal_receipt: z.unknown(), snapshot: z.unknown(),
  workflow_id: z.string(), transaction_id: z.string(), execution_id: z.string(), run_id: z.string(),
  cart_id: resourceId, context_id: resourceId, merchant_id: resourceId, merchant_store_id: resourceId,
  reservation_id: resourceId, slot_id: resourceId,
});
export function completedOrderHandoff(value: unknown) {
  const row = handoffRecord.safeParse(value);
  if (!row.success) throw orderUnavailable();
  const receipt = terminalReceipt.safeParse(row.data.terminal_receipt);
  const snapshot = checkoutSnapshot.safeParse(row.data.snapshot);
  if (!receipt.success || !snapshot.success) throw orderUnavailable();
  const r = receipt.data, s = snapshot.data, h = row.data;
  if (r.order_id !== h.order_id || r.cart_id !== h.cart_id || s.cart_id !== h.cart_id
    || s.cart_context_id !== h.context_id || s.merchant_id !== h.merchant_id
    || s.merchant_store_id !== h.merchant_store_id || s.reservation_id !== h.reservation_id
    || r.amount_minor !== s.totals.total_minor || r.workflow_id !== h.workflow_id
    || r.transaction_id !== h.transaction_id || r.execution_id !== h.execution_id || r.run_id !== h.run_id) {
    throw orderUnavailable();
  }
  return { ...h, snapshot: s };
}
export type CompletedOrderHandoff = ReturnType<typeof completedOrderHandoff>;

export type OrderDecisionAction = "accept" | "reject";
const decisionBase = {
  expected_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  confirmed: z.literal(true),
};
export const orderAcceptInput = z.object(decisionBase).strict();
export const orderRejectInput = z.object({
  ...decisionBase,
  reason: z.string().trim().max(500).optional(),
}).strict();
export function parseOrderDecision(action: OrderDecisionAction, value: unknown) {
  if (action === "accept") return { ...orderParse(orderAcceptInput, value), reason: null };
  const input = orderParse(orderRejectInput, value);
  return { ...input, reason: input.reason || null };
}
export const orderDecisionConflict = () =>
  new MedusaError(MedusaError.Types.CONFLICT, "ORDER_DECISION_CONFLICT", "ORDER_DECISION_CONFLICT");
export function isOrderDecisionReplay(
  operation: { status: string; revision: number; rejection_reason: string | null },
  action: OrderDecisionAction,
  input: ReturnType<typeof parseOrderDecision>,
) {
  if (input.expected_revision !== 0) throw orderDecisionConflict();
  if (operation.status === "PENDING_ACCEPTANCE" && operation.revision === 0) return false;
  if (operation.revision === 1 && operation.status === (action === "accept" ? "ACCEPTED" : "REJECTED")
    && operation.rejection_reason === input.reason) return true;
  throw orderDecisionConflict();
}
