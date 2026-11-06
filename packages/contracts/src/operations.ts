export const operationsSources = ["orders", "deliveries", "recovery", "adjustments", "credit", "inventory", "recognition", "settlements",
  "driver_payments", "driver_recognition", "compensation", "notifications", "merchant_review", "driver_review", "restricted_review"] as const;
export type OperationsSource = typeof operationsSources[number];
export const operationsLookupTypes = ["ORDER", "DELIVERY", "MERCHANT", "DRIVER", "FINANCIAL_ADJUSTMENT", "MERCHANT_SETTLEMENT", "DRIVER_PAYMENT", "NOTIFICATION"] as const;
export type OperationsLookupType = typeof operationsLookupTypes[number];
export interface OperationalAttention {
  domain: string; record_type: string; record_id: string; reference: string; category: string; status: string;
  reason_code: string | null; created_at: string | null; economic_at: string | null; summary: string; link: string | null;
}
export interface AttentionPage {
  source: OperationsSource; observed_at: string; items: OperationalAttention[]; next_cursor: string | null; has_more: boolean;
  page_count: number; oldest_in_sample: string | null;
}
export type OverviewSection = { source: OperationsSource; availability: "AVAILABLE"; page: AttentionPage }
  | { source: OperationsSource; availability: "UNAVAILABLE" };
export interface OperationsOverview { observed_at: string; sections: OverviewSection[]; links: { label: string; href: string }[]; navigation: { orders: boolean; deliveries: boolean } }
export interface OrderDiagnostic {
  unavailable_sections: ("delivery" | "finance")[];
  order: { id: string; status: string; currency: string };
  handoff: "VERIFIED" | "UNPROVEN";
  operation: { id: string; status: string; revision: number; accepted_at: string | null; rejected_at: string | null } | null;
  store: { merchant_id: string; store_id: string; name: string } | null;
  picking: { status: string; revision: number; completed_at: string | null } | null;
  delivery?: DeliveryDiagnostic;
  finance?: { items: { id: string; reason: string; status: string; amount_minor: string; currency: string; method: string; refund_state: string | null; credit_state: string | null }[]; truncated: boolean };
}
export interface RescueDiagnostic { eligible: boolean; scope: "PERSISTED_PRECHECK"; block_reason: string | null; requires_admission_revalidation: true }
export interface DeliveryDiagnostic {
  can_rescue?: boolean;
  id: string; order_id: string; merchant_id: string; store_id: string; status: string; revision: number; generation: number;
  mode: string; path: string | null; reason_code: string | null;
  timing: { dispatch_not_before: string | null; started_at: string | null; deadline: string | null; picked_up_at: string | null; arrived_at: string | null; delivered_at: string | null };
  commitment: { id: string; status: string; driver_profile_id: string; expires_at: string | null; assigned_at: string | null } | null;
  pickup: { action: string; state: string }[]; completion_state: string | null; return_state: string | null;
  rescue: RescueDiagnostic;
}
export interface OperationalLookup { type: OperationsLookupType; id: string; reference: string; status: string; link: string | null }
export const operationsTimelineSources = ["decision", "picking", "delivery", "compliance", "finance", "recognition"] as const;
export type OperationsTimelineSource = typeof operationsTimelineSources[number];
export interface OperationalTimelineEntry { id: string; domain: string; timestamp: string; label: string; actor: "NOT_PROJECTED"; summary: string }
export interface OperationalTimelinePage { source: OperationsTimelineSource; items: OperationalTimelineEntry[]; next_cursor: string | null; has_more: boolean }
export interface OperationsTimeline { observed_at: string; pages: OperationalTimelinePage[] }
export interface OperationalWorkerSignal {
  name: string; execution_health: "NOT_INSTRUMENTED"; enabled: boolean | null; sample_count: number; has_more: boolean; oldest_in_sample: string | null;
  sample_kind: "CURSOR_RECORDS" | "DUE_WORK" | "PENDING_RECORDS";
}
export interface OperationsHealth { observed_at: string; workers: OperationalWorkerSignal[]; notifications?: import("./notifications").NotificationHealth }
export interface DeliveryRescueCommand {
  request_id: string; expected_revision: number; expected_generation: number; expected_status: "ATTENTION_REQUIRED";
  reason_code: "RETRY_DISPATCH_SEARCH"; confirmed: true;
}
export interface DeliveryRescueResult {
  rescue_id: string; delivery_id: string; prior_generation: number; generation: number; revision: number;
  status: "SEARCHING"; recorded_at: string;
}
