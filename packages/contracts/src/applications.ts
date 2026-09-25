export const applicationStatuses = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "REJECTED"] as const;
export const applicationDocumentTypes = ["BUSINESS_REGISTRATION", "REPRESENTATIVE_ID", "LIQUOR_DOCUMENT", "OTHER"] as const;
export interface ApplicationFields {
  legal_name: string; trading_name: string; contact_name: string; contact_email: string; contact_phone: string;
  address_line_1: string; address_line_2: string; city: string; province: string; postal_code: string; country_code: string;
  intends_to_sell_alcohol: boolean; notes: string;
}
export interface MerchantApplication extends ApplicationFields {
  id: string; status: typeof applicationStatuses[number]; submitted_at: string | null; created_at: string; updated_at: string;
}
export interface ApplicationDocument {
  id: string; document_type: typeof applicationDocumentTypes[number]; display_name: string;
  mime_type: string; size_bytes: number; removal_pending: boolean; created_at: string;
}
export interface ApplicationDetail { application: MerchantApplication | null; documents: ApplicationDocument[] }
export interface ApplicationList { applications: MerchantApplication[]; count: number; limit: number; offset: number }

export interface ApplicantIdentity { type: "merchant"; scope: "application" }
