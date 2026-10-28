export type RecipientDocument = "IDENTITY_DOCUMENT" | "DRIVERS_LICENCE" | "PASSPORT";
export type PhysicalReturnState = "RETURN_REQUIRED" | "RETURNING_TO_STORE" | "RETURNED_TO_STORE";
export interface RecipientObservation {
  expected_revision:number;recipient_role:"PURCHASER"|"ALTERNATE_ADULT";document_type:RecipientDocument|null;
  document_viewed:boolean;date_of_birth:string|null;school_uniform_observed:boolean;
  recipient_declares_school_going_learner:boolean;recipient_appears_intoxicated:boolean;
  recipient_refused_verification:boolean;invoice_address_matches:boolean;
}
export interface RecipientState {
  delivery_id:string;revision:number;compliance:"REQUIRED"|"SATISFIED"|"FAILED";
  return_state:PhysicalReturnState|null;awaiting_store_receipt:boolean;financial_review_required:boolean;
  origin_store:{name:string;address:{address_line_1:string;address_line_2:string;city:string;province:string;postal_code:string;country_code:string}}|null;
}
export interface CustomerRestrictedHandoff {
  state:PhysicalReturnState|"AGE_VERIFICATION_REQUIRED"|"ATTENTION_REQUIRED"|"UNAVAILABLE";financial_review_required:boolean;
}
/** Immutable delivery copy, never a licence evidence upload or payment authority. */
export interface RestrictedDeliveryInvoice {
  document_number:string;order_reference:string;ordered_at:string;
  address:Pick<import("./location").AddressWrite,"address_1"|"address_2"|"city"|"province"|"postal_code"|"country_code">;
  seller_name:string;
  premises:NonNullable<RecipientState["origin_store"]>["address"];
  registration_number:string;registration_category:string;
  goods:{description:string;sku:string|null;quantity:number}[];
}
