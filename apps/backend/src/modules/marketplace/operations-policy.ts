import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { operationsSources, operationsLookupTypes, operationsTimelineSources } from "@gospaza/contracts";
import type { OperationsSource, OperationsLookupType, OperationsTimelineSource, RescueDiagnostic } from "@gospaza/contracts";
import { platformGranted } from "./platform-capabilities";
import { hasFinancialCapability } from "./financial-policy";
import { settlementAllowed } from "./merchant-settlement-policy";
import { driverEarningsView } from "./driver-earning-policy";
import { compensationAllowed } from "./driver-compensation-policy";
import { notificationOpsAllowed } from "../../lib/notification-runtime-policy";
export const operationsId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const operationsPage = z.object({ limit: z.coerce.number().int().min(1).max(25).default(20), cursor: z.string().min(1).max(512).optional() }).strict();
export const lookupInput = z.object({ type: z.enum(operationsLookupTypes), id: operationsId }).strict();
export const timelineInput = operationsPage.extend({ source: z.enum(operationsTimelineSources).optional() }).strict();
export const operationsSource = z.enum(operationsSources);
const cursorInput = z.object({ source: z.string().min(1).max(256), key: operationsId }).strict();
export function operationsCursor(source: string, key: string) { return Buffer.from(JSON.stringify(cursorInput.parse({ source, key }))).toString("base64url"); }
export function readOperationsCursor(source: string, cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const decoded = cursorInput.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (decoded.source !== source) throw Error(); return decoded.key;
  } catch { throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid operations cursor."); }
}
export function sourceAllowed(user: string, source: OperationsSource, env: NodeJS.ProcessEnv = process.env) {
  switch (source) {
    case "orders": return platformGranted(user, "ORDER_OPERATIONS_VIEW", env);
    case "deliveries": return platformGranted(user, "DELIVERY_OPERATIONS_VIEW", env);
    case "recovery": case "adjustments": case "credit": case "recognition": return hasFinancialCapability(user, "VIEW", env);
    case "inventory": return hasFinancialCapability(user, "VIEW", env) && hasFinancialCapability(user, "VIEW_DISPOSITION", env);
    case "settlements": return settlementAllowed(user, "VIEW", env);
    case "driver_payments": case "driver_recognition": return driverEarningsView(user, env);
    case "compensation": return compensationAllowed(user, false, env);
    case "notifications": return notificationOpsAllowed(user, env);
    case "merchant_review": return platformGranted(user, "MERCHANT_REVIEW_VIEW", env);
    case "driver_review": return platformGranted(user, "DRIVER_REVIEW_VIEW", env);
    case "restricted_review": return !!user && (env.RESTRICTED_COMMERCE_REVIEWER_IDS ?? "").split(",").map(v => v.trim()).includes(user);
  }
}
export const lookupSource: Record<OperationsLookupType, OperationsSource> = { ORDER: "orders", DELIVERY: "deliveries", MERCHANT: "orders", DRIVER: "driver_review",
  FINANCIAL_ADJUSTMENT: "adjustments", MERCHANT_SETTLEMENT: "settlements", DRIVER_PAYMENT: "driver_payments", NOTIFICATION: "notifications" };
export const timelineSource: Record<OperationsTimelineSource, OperationsSource> = { decision: "orders", picking: "orders", delivery: "deliveries", compliance: "restricted_review", finance: "adjustments", recognition: "recognition" };
export function operationsLink(type: OperationsLookupType, id: string): string | null {
  const value = encodeURIComponent(operationsId.parse(id));
  switch (type) {
    case "ORDER": return "/admin/orders/" + value;
    case "DELIVERY": return "/admin/dispatch/" + value;
    case "DRIVER": return "/admin/drivers/" + value;
    case "MERCHANT": return null; // No native merchant detail screen exists.
    case "FINANCIAL_ADJUSTMENT": return "/admin/financial-adjustments";
    case "MERCHANT_SETTLEMENT": return "/admin/settlements/" + value;
    case "DRIVER_PAYMENT": return "/admin/driver-finance";
    case "NOTIFICATION": return "/admin/notifications";
  }
}
export interface RescueFacts {
  status: string; generation: number; reason: string | null; pickup_managed: boolean; native_fulfillment_id: string | null;
  picked_up_at: unknown; arrived_at: unknown; delivered_at: unknown; tracking_generation: string | null; handoff_failures: number;
  active: boolean; assigned: boolean; history_invalid: boolean; native_operations: boolean; custody: boolean; snapshot: boolean;
  binding_proven: boolean;
}
export function rescuePrecheck(f: RescueFacts): RescueDiagnostic {
  const block = f.status !== "ATTENTION_REQUIRED" ? "NOT_SEARCH_ATTENTION"
    : !f.binding_proven ? "SOURCE_BINDING_UNPROVEN"
    : !Number.isSafeInteger(f.generation) || f.generation < 1 ? "SEARCH_NOT_STARTED"
    : !["POOL_EXHAUSTED", "SEARCH_ENDED", "SEARCH_UNAVAILABLE"].includes(f.reason ?? "") ? "UNSUPPORTED_ATTENTION"
    : f.active ? "ACTIVE_COMMITMENT" : f.assigned || f.snapshot ? "PRIOR_ASSIGNMENT"
    : f.history_invalid ? "HISTORY_UNPROVEN"
    : f.pickup_managed || f.native_fulfillment_id || f.picked_up_at || f.arrived_at || f.delivered_at || f.tracking_generation || f.handoff_failures !== 0 || f.native_operations ? "FULFILLMENT_OR_CUSTODY"
    : f.custody ? "RETURN_OR_HANDOFF_EVIDENCE" : null;
  return { eligible: !block, scope: "PERSISTED_PRECHECK", block_reason: block, requires_admission_revalidation: true };
}
export const safeOperationReason = (value: unknown): string | null => typeof value === "string" && new Set([
  "POOL_EXHAUSTED", "SEARCH_ENDED", "SEARCH_UNAVAILABLE", "ASSIGNMENT_REVIEW", "DISPATCH_CONFIGURATION_DISABLED", "DELIVERY_NO_LONGER_DISPATCHABLE",
  "PICKUP_DRIVER_REVIEW", "PICKUP_NATIVE_REVIEW", "PICKUP_READINESS_LOST", "HANDOFF_LIMIT_EXHAUSTED", "COMPLIANCE_RECOVERY_REQUIRED",
  "MISSING_COMMISSION_TERMS", "UNKNOWN_PROMOTION_SPONSORSHIP", "ECONOMIC_EVIDENCE_MISMATCH", "RECOGNITION_EVIDENCE_MISMATCH", "UNRESOLVED_ADJUSTMENT_ATTRIBUTION", "POSTING_SOURCE_CONFLICT",
  "COMPLETION_EVIDENCE_MISMATCH", "SNAPSHOT_MISSING", "SNAPSHOT_IDENTITY_MISMATCH", "PAYER_CLASSIFICATION_CONFLICT", "SOURCE_CONFLICT",
  "MISSING_COMPENSATION_TERMS", "HISTORICAL_PREACTIVATION", "SNAPSHOT_CONFLICT",
]).has(value) ? value : null;
export function diagnosticTime(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw Error("Unproven diagnostic timestamp."); return date.toISOString();
}
