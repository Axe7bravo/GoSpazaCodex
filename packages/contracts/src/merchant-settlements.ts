export type SettlementState="DRAFT"|"READY_FOR_APPROVAL"|"APPROVED"|"FAILED"|"PAID"|"RECONCILED";
export type SettlementAction="PREPARE"|"SUPERSEDE"|"APPROVE"|"PAY"|"FAIL"|"RETRY"|"RECONCILE";
// Integer cents, not decimal Rand. Strings preserve signed PostgreSQL bigint exactly.
export interface SettlementAmounts {merchandise_minor:string;tax_held_minor:string;subsidy_minor:string;commission_minor:string;
  current_effects_minor:string;incoming_carry_minor:string;net_minor:string;payable_minor:string;outgoing_carry_minor:string}
export interface SettlementSummary extends SettlementAmounts {
  id:string;store_name:string;period_start:string;period_end:string;timezone:"Africa/Johannesburg";currency:"zar";
  statement_status:"DRAFT"|"READY_FOR_APPROVAL";finalized:boolean;superseded:boolean;
  included_count:number;excluded_count:number;payable_id:string|null;payment_status:SettlementState|null;
  paid_at:string|null;reconciled_at:string|null;attention_required:boolean;
}
export interface PlatformSettlementSummary extends SettlementSummary {merchant_id:string;store_id:string}
export interface SettlementItemSummary {order_id:string;economic_at:string;prior_period:boolean;entitlement_minor:string}
export interface SettlementHoldSummary {order_id:string;category:"HISTORICAL_REVIEW"|"FINANCIAL_REVIEW";held_minor:string|null}
export interface SettlementPaymentSummary {amount_minor:string;currency:"zar";transferred_at:string;external_reference:string}
export interface MerchantSettlementDetail {statement:SettlementSummary;items:SettlementItemSummary[];holds:SettlementHoldSummary[];
  payment:SettlementPaymentSummary|null;tax_policy:"TAX_HELD";shipping_policy:"EXCLUDED"}
export interface PlatformSettlementDetail extends Omit<MerchantSettlementDetail,"statement"> {
  statement:PlatformSettlementSummary;policy_version:string;statement_revision:number;payable_revision:number|null;
  actions:SettlementAction[];can_read_evidence:boolean;approved_amount_minor:string|null;
  history:{action:string;recorded_at:string;actor_id:string}[];
  failures:{id:string;category:string;attempted_at:string}[];
  discrepancies:{id:string;category:string;status:"OPEN";recorded_at:string}[];
}
export interface SettlementPage<T> {items:T[];next_after:string|null}
export interface SettlementDecisionInput {request_id:string;expected_revision:number;confirmed:true;reason:string}
export interface SettlementTransferInput {amount_minor:number;currency:"zar";beneficiary_reference:string;channel:"BANK_TRANSFER";
  origin_reference:string;external_transfer_id:string;transferred_at:string}
export interface RecordSettlementPayout extends SettlementDecisionInput,SettlementTransferInput {evidence_reference?:string}
export interface RecordSettlementFailure extends SettlementDecisionInput {beneficiary_reference:string;channel:"BANK_TRANSFER";
  origin_reference:string;external_transfer_id?:string;attempted_at:string;failure_category:"BANK_REJECTED"|"RETURNED_BEFORE_RECEIPT"|"RAIL_CONFIRMED_FAILURE";
  nonreceipt_confirmed:true;evidence_reference:string}
export interface RetrySettlement extends SettlementDecisionInput {failed_attempt_id:string;review_reference:string}
export interface ReconcileSettlement extends SettlementDecisionInput,SettlementTransferInput {receipt_id:string;review_reference:string}
export interface SettlementEvidence {
  receipt:({id:string;evidence_reference:string|null}&Omit<SettlementTransferInput,"amount_minor">&{amount_minor:string})|null;
  failures:{id:string;beneficiary_reference:string;channel:"BANK_TRANSFER";origin_reference:string;attempted_at:string;
    failure_category:string;nonreceipt_confirmed:boolean;evidence_reference:string;external_transfer_id:string|null}[];
  discrepancies:{id:string;category:string;status:"OPEN";evidence_reference:string;recorded_at:string}[];
  approvals:{action:string;actor_id:string;recorded_at:string;reason:string;amount_minor:string;currency:"zar"}[];
  reviews:{failed_attempt_id:string;review_reference:string;actor_id:string;recorded_at:string}[];
  reconciliation:{receipt_id:string;review_reference:string;actor_id:string;recorded_at:string;reason:string}|null;
}
