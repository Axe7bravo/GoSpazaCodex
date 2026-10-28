export type Restriction = "NONE" | "ALCOHOL";
export type AlcoholClass = "WINE" | "BEER" | "SPIRITS" | "OTHER";
export interface RestrictedTradingPolicy {
  timezone: "Africa/Johannesburg"; source: string; version: string; permitted_alcohol_classes: AlcoholClass[];
  effective_from: string; effective_until: string | null;
  regulatory_sale_windows: {day:number;start_minute:number;end_minute:number}[];
  licence_sale_windows: {day:number;start_minute:number;end_minute:number}[];
  store_sale_windows: {day:number;start_minute:number;end_minute:number}[];
  dispatch_windows: {day:number;start_minute:number;end_minute:number}[] | null;
  handoff_windows: {day:number;start_minute:number;end_minute:number}[] | null;
}
export type RestrictedRegistrationDecision = { expected_revision:number; confirmed:true; reason:string } & (
  { action:"approve"; conditions_confirmed:true; trading_policy:RestrictedTradingPolicy } |
  { action:"request-changes"|"suspend"|"reactivate"|"revoke" });
export interface RestrictedClassificationDTO {
  product?: {title:string;description:string|null;variants:{title:string;sku:string|null}[]};
  product_id: string;
  identity_fingerprint: string;
  proposed: Restriction;
  review: { id: string; restriction: Restriction; alcohol_class: AlcoholClass | null; current: boolean } | null;
}
export interface PurchaserEligibilityDTO {
  state: "UNAVAILABLE" | "NOT_VERIFIED" | "EXPIRED" | "UNVERIFIED" | "PENDING" | "VERIFIED" | "REVOKED";
}
export interface RestrictedRegistrationSubmission {
  registration_number: string; category: "GROCER_WINE" | "LIQUOR_STORE"; issuing_authority: string;
  valid_from: string | null; valid_until: string | null; evidence_ids: string[];
}
export interface RestrictedRegistrationDTO {
  review_note?: string | null;
  premises?: {address_line_1:string;address_line_2:string;city:string;province:string;postal_code:string;country_code:string};
  registration: { id: string; status: "PENDING_REVIEW" | "CHANGES_REQUIRED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
    revision: number; submission: RestrictedRegistrationSubmission; pending_submission: RestrictedRegistrationSubmission | null;
    submitted_at: string; reviewed_at: string | null } | null;
  evidence: { id: string; display_name: string; mime_type: string; size_bytes: number }[];
}
