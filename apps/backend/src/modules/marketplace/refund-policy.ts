import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { fingerprint } from "../yoco/request";

export const REFUND_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Includes the 15s transport deadline plus queue/transit margin. Never start a
// retry at the edge of provider retention; aborting HTTP cannot undo a refund.
export const REFUND_REPLAY_SAFETY_MS = 60 * 1000;
export const refundCommand = z.object({
  confirmed: z.literal(true),
  action: z.enum(["EXECUTE", "RECONCILE", "RETRY_NOT_CREATED"]),
  reason: z.enum(["APPROVED_ADJUSTMENT", "RECOVER_UNCERTAIN_REQUEST", "RETRY_CONFIRMED_NOT_CREATED"]),
  expected_attempt_number: z.number().int().positive().max(10000).optional(),
}).strict().refine(value => value.action === "RETRY_NOT_CREATED" ? value.expected_attempt_number !== undefined : value.expected_attempt_number === undefined);
export const refundConflict = () => new MedusaError(MedusaError.Types.CONFLICT,
  "Refund evidence requires review.", "REFUND_REQUIRES_REVIEW");
export function refundRequest(operation: string, attempt: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw refundConflict();
  const json = JSON.stringify({ amount, metadata: {
    gospazaRefundOperationId: operation, gospazaRefundAttemptId: attempt,
  } });
  return { json, fingerprint: fingerprint(json) };
}
export function mayReplayRefund(firstSent: Date | string | null, now: Date) {
  if (!firstSent) return true;
  const elapsed = now.getTime() - new Date(firstSent).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed + REFUND_REPLAY_SAFETY_MS < REFUND_REPLAY_WINDOW_MS;
}
export type RefundState = "CREATED" | "REQUESTED" | "UNKNOWN" | "FAILED_NOT_CREATED" | "FAILED"
  | "PROVIDER_SUCCEEDED" | "ATTENTION_REQUIRED" | "SETTLED";
export interface RefundRow {
  id: string; settlement_id: string; adjustment_id: string; order_id: string; merchant_id: string;
  store_id: string; customer_id: string | null; provider_operation_id: string;
  checkout_id: string; provider_payment_id: string; payment_id: string; capture_id: string;
  account_fingerprint: string; mode: "test" | "live"; amount_minor: string | number; currency: "zar";
  status: RefundState; revision: number; current_attempt_id: string | null;
  native_dispatched_at: Date | null; native_refund_id: string | null;
  order_dispatched_at: Date | null; order_transaction_id: string | null;
  attention_reason: string | null; settled_at: Date | null; updated_at: Date;
}
export interface RefundAttemptRow {
  id: string; refund_operation_id: string; attempt_number: number; idempotency_key: string;
  request_json: string; request_fingerprint: string; request_version: string;
  status: "CREATED" | "SENDING" | "UNKNOWN" | "PENDING" | "FAILED_NOT_CREATED" | "FAILED" | "SUCCEEDED";
  provider_refund_id: string | null; first_sent_at: Date | null; lease_until: Date | null;
  verified_event_id: string | null; response_status: number | null; updated_at: Date;
}
