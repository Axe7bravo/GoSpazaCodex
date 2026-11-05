export type DriverEarningPaymentState = "UNPAID" | "RESERVED" | "PAYMENT_RECORDED" | "RECONCILED";
export interface DriverPaymentSummary {
  id: string; amount_minor: string; currency: "zar"; earning_count: number; payment_date: string;
  reference: string; state: "UNDER_REVIEW" | "PAYMENT_RECORDED" | "CONFIRMED_NOT_PAID" | "RECONCILED"; attention_required: boolean;
}
export interface DriverEarningSummary {
  id: string; delivery_reference: string; order_reference: string; economic_at: string;
  amount_minor: string; currency: "zar"; earning_type: "SUCCESSFUL_DELIVERY";
  payment_state: DriverEarningPaymentState; attention_required: boolean; payment: DriverPaymentSummary | null;
}
export interface DriverEarningsPage {
  items: DriverEarningSummary[]; next_after: string | null; unpaid_minor: string; reserved_minor: string;
  reviews: { delivery_reference: string; state: "EARNING_UNDER_REVIEW" }[];
}
export interface DriverPaymentsPage { items: DriverPaymentSummary[]; next_after: string | null }
export interface PlatformEarning extends DriverEarningSummary {
  driver_profile_id: string; payer: "GOSPAZA"; payer_classification: "PLATFORM"; recorded_at: string;
  snapshot: { id: string; amount_minor: string; currency: "zar"; terms_revision: number };
  recognition_exceptions: { reason: string; recorded_at: string }[];
}
export interface PlatformRecognitionReview { id: string; driver_profile_id: string | null; delivery_reference: string; reason: string; recorded_at: string }
export interface PlatformRecognitionReviews { items: PlatformRecognitionReview[]; next_after: string | null }
export interface DriverFinanceCapabilities { view: boolean; manage: boolean; record: boolean; reconcile: boolean }
export interface PlatformEarningsPage { items: PlatformEarning[]; next_after: string | null }
export interface PlatformPayment extends DriverPaymentSummary { driver_profile_id: string; discrepancies: string[] }
export interface PlatformPaymentsPage { items: PlatformPayment[]; next_after: string | null }
export interface PlatformPaymentDetail { payment: PlatformPayment; earnings: PlatformEarning[] }
export interface DriverPaymentEvidence {
  payment_id: string; driver_profile_id: string; payer: string; currency: "zar"; amount_minor: string;
  beneficiary_reference: string; channel: "BANK_TRANSFER"; origin_reference: string; external_transfer_id: string;
  transferred_at: string; recorded_at: string; state: string; items: { earning_id: string; amount_minor: string }[];
  discrepancies: { id: string; category: string }[]; attention_required: boolean;
}
export interface DriverFinanceDecision { request_id: string; confirmed: true; reason: string }
export interface RecordDriverPayment extends DriverFinanceDecision {
  earning_ids: string[]; amount_minor: number; currency: "zar"; beneficiary_reference: string; channel: "BANK_TRANSFER";
  origin_reference: string; external_transfer_id: string; transferred_at: string; evidence_reference: string;
}
export interface ResolveDriverPayment extends DriverFinanceDecision { review_reference: string; evidence_reference: string }
export interface ConfirmDriverNonpayment extends ResolveDriverPayment {
  nonreceipt_confirmed: true; failure_category: "BANK_REJECTED" | "RETURNED_BEFORE_RECEIPT" | "RAIL_CONFIRMED_FAILURE";
}
export interface ReconcileDriverPayment extends DriverFinanceDecision {
  driver_profile_id: string; earning_ids: string[]; amount_minor: number; currency: "zar"; beneficiary_reference: string;
  channel: "BANK_TRANSFER"; origin_reference: string; external_transfer_id: string; transferred_at: string; review_reference: string;
}
export interface DriverPaymentDiscrepancy extends DriverFinanceDecision {
  category: "BENEFICIARY_MISMATCH" | "AMOUNT_MISMATCH" | "TRANSFER_DISPUTE" | "DUPLICATE_EXTERNAL_RECORD" | "RETURNED_TRANSFER" | "RECONCILIATION_MISMATCH";
  evidence_reference: string;
}
export interface DriverCompensationTerms { id: string; revision: number; amount_minor: string; currency: "zar"; effective_at: string; recorded_at: string; reason: string }
export interface DriverCompensationHistory {
  items: DriverCompensationTerms[]; current: DriverCompensationTerms | null;
  activation: { id: string; revision: number; effective_at: string; recorded_at: string; reason: string } | null;
  revision: number; next_after: string | null;
}
export interface PublishDriverTerms extends DriverFinanceDecision { expected_revision: number; amount_minor: number; currency: "zar"; effective_at?: string }
