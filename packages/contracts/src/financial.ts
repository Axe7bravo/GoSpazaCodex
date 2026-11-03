export interface FinancialAdjustmentView {
  id:string; order_id:string;
  reason:"ITEM_OMITTED"|"MERCHANT_REJECTED"|"FULL_UNFULFILLABLE"|"RESTRICTED_HANDOFF_FAILED"|"GOODWILL";
  financial_cause:"MERCHANT"|"PLATFORM"|"CUSTOMER_RECIPIENT"|"POLICY";
  currency:"zar"; amount_minor:number;
  components:{component:"MERCHANDISE"|"TAX"|"DELIVERY_FEE"|"GOODWILL";amount_minor:number}[];
  status:"REVIEW_REQUIRED"|"APPROVED"|"ATTENTION_REQUIRED";revision:number;
  eligible_methods:("STORE_CREDIT"|"ORIGINAL_PAYMENT")[];default_method:"STORE_CREDIT"|"ORIGINAL_PAYMENT";
  settled_minor:number;reserved_minor:number;unsettled_minor:number;execution_available:false;
  refund_status?:"PENDING"|"SUCCEEDED"|"FAILED"|"ATTENTION_REQUIRED";
  credit_status?:"PENDING"|"CREDIT_ADDED"|"REVIEW_PENDING";
  refund_operation_state?:"CREATED"|"REQUESTED"|"UNKNOWN"|"FAILED_NOT_CREATED"|"FAILED"|"PROVIDER_SUCCEEDED"|"ATTENTION_REQUIRED"|"SETTLED";
  credit_operation_state?:"CREATED"|"ISSUING"|"SETTLED"|"FAILED"|"ATTENTION_REQUIRED";
}

export type OrderAdjustment = Pick<FinancialAdjustmentView,
  "reason" | "amount_minor" | "currency" | "status" | "default_method" | "settled_minor" | "refund_status" | "credit_status">;
export type MerchantAdjustment = OrderAdjustment & Pick<FinancialAdjustmentView,"financial_cause">;
export interface CustomerFinancialResolution {
  adjustments: OrderAdjustment[];
  funding: { gross_minor:number; store_credit_minor:number; original_payment_minor:number };
}
export type DispositionDecision = "RESTOCK" | "NON_SELLABLE";
export interface DispositionLine {
  line_id:string; quantity:number; decision:DispositionDecision|null;
  status:"UNDECIDED"|"DISPATCHED"|"COMPLETED"|"ATTENTION_REQUIRED";
}
export interface AdminFinancialOrder {
  adjustments:FinancialAdjustmentView[];
  history:{adjustment_id:string;action:string;occurred_at:string;actor_type:"system"|"user"}[];
  dispositions?: DispositionLine[];
}
