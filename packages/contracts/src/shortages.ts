export type OrderShortagePreference = "CONTACT_ME" | "NO_SUBSTITUTION";
export interface ShortagePreference {
  preference: OrderShortagePreference;
  revision: number;
  chosen_at: string | null;
  frozen_at: string | null;
}
export interface ShortageResolution {
  id: string;
  line_id: string;
  status: "CUSTOMER_DECISION_REQUIRED" | "RESOLVED_OMITTED";
  revision: number;
  ordered_quantity: number;
  picked_quantity: number;
  omitted_quantity: number;
  unresolved_quantity: number;
  preference: OrderShortagePreference;
  financial_review_required: boolean;
  resolved_at: string | null;
}
export interface OrderShortages { preference: ShortagePreference; shortages: ShortageResolution[] }
export interface ShortagePreferenceInput { preference: OrderShortagePreference; expected_revision: number }
export interface ShortageOmissionInput { expected_revision: number; confirmed: true }
