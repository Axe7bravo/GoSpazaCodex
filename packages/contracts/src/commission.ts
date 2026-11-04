export type CommissionZeroReason = "MERCHANT_REJECTED" | "FULL_UNFULFILLABLE" | "FAILED_RESTRICTED_HANDOFF";
export type CommissionException = "MISSING_COMMISSION_TERMS" | "UNKNOWN_PROMOTION_SPONSORSHIP" | "ECONOMIC_EVIDENCE_MISMATCH" |
  "RECOGNITION_EVIDENCE_MISMATCH" | "UNRESOLVED_ADJUSTMENT_ATTRIBUTION" | "POSTING_SOURCE_CONFLICT";
export interface EarnedEconomics {
  merchandise_minor:number; tax_minor:number; subsidy_minor:number; basis_minor:number;
  commission_minor:number; entitlement_minor:number; economic_at:string;
}
export interface MerchantOrderEconomics {
  order_id:string; currency:"zar"; state:"PENDING"|"RESOLVED"|"UNRESOLVED"|"KNOWN_ZERO"|"EARNED";
  basis_points:number|null; zero_reason:CommissionZeroReason|null; earned:EarnedEconomics|null;
}
export interface AdminOrderEconomics extends MerchantOrderEconomics {
  merchant_id:string; store_id:string; snapshot_state:"RESOLVED"|"UNRESOLVED"|null;
  rule_id:string|null; rule_revision:number|null; rule_effective_at:string|null;
  evidence:{basis_minor:number|null}; recorded_at:string|null;
  posting:{kind:"DELIVERY_RECOGNITION";amounts:EarnedEconomics;recorded_at:string}|null;
  exceptions:{reason:CommissionException;recorded_at:string}[];
}
export interface CommissionRuleView {
  id:string; merchant_id:string|null; decision:"SET"|"CLEAR"; basis_points:number|null;
  revision:number; effective_at:string; recorded_at:string; reason:string;
}
export interface CommissionHistory {
  items:(CommissionRuleView & {timing:"CURRENT"|"FUTURE"|"HISTORICAL"})[];
  effective:CommissionRuleView|null; revision:number; can_publish:boolean; limit:number; offset:number;
}
export interface PublishCommission {
  scope:"PLATFORM"|"MERCHANT"; merchant_id?:string; decision:"SET"|"CLEAR"; basis_points?:number;
  effective_at?:string; reason:string; expected_revision:number; request_id:string; confirmed:true;
}
