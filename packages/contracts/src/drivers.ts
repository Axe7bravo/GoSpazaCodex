export type DriverStatus = "INCOMPLETE" | "PENDING_REVIEW" | "CHANGES_REQUIRED" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
export type DriverAffiliationKind = "PLATFORM" | "MERCHANT";
export type DriverAffiliationStatus = "REQUESTED" | "ENDORSED" | "ACTIVE" | "REJECTED" | "REVOKED";
export interface DriverProfileDTO {
  id: string; display_name: string; contact_phone: string; status: DriverStatus; revision: number;
  submitted_at: string | null; reviewed_at: string | null;
}
export interface DriverAffiliationDTO {
  id: string; kind: DriverAffiliationKind; status: DriverAffiliationStatus; revision: number;
  merchant_store_id: string | null; created_at: string;
}
export interface DriverEligibilityDTO {
  eligible: boolean;
  reason: "ELIGIBLE" | "IDENTITY_UNAVAILABLE" | "PROFILE_INACTIVE" | "AFFILIATION_INACTIVE" | "STORE_UNAVAILABLE" | "STORE_MISMATCH";
}
export interface DriverAccountDTO { profile: DriverProfileDTO; affiliation: DriverAffiliationDTO | null; eligibility: DriverEligibilityDTO }
export interface DriverOnboardingIdentity { type: "driver"; scope: "onboarding" }
export interface DriverTargetPage { items: { id: string; name: string }[]; limit: number; offset: number }
export interface DriverRevisionInput { expected_revision: number }
export interface DriverReviewInput extends DriverRevisionInput { confirmed: true; reason: string }
export type DriverAffiliationInput = DriverRevisionInput & ({ kind: "PLATFORM" } | { kind: "MERCHANT"; merchant_store_id: string });
export type DriverProfileAction = "approve" | "require-changes" | "suspend" | "reactivate" | "deactivate";
export type DriverAffiliationAction = "activate" | "decline" | "revoke";
export interface DriverDecisionReceipt { action: string; revision: number; occurred_at: string }
export interface DriverMutationDTO extends DriverAccountDTO { receipt: DriverDecisionReceipt }
export type MerchantDriverAction = "endorse" | "decline" | "revoke";
export interface MerchantDriverDTO {
  affiliation: DriverAffiliationDTO; profile_revision: number; display_name: string; contact_phone: string | null;
  persistently_eligible: boolean; available_actions: MerchantDriverAction[];
}
export interface DriverPage<T> { items: T[]; count: number; limit: number; offset: number }
