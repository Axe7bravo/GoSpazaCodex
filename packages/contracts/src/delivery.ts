import type { DiscoveryLocation } from "./storefront";

export interface DeliveryAvailability {
  revision: number;
  timezone: string;
  as_of: string;
  options: { id: string; mode: "ASAP" | "SCHEDULED"; revision: number; fee_minor: number; currency_code: "zar" }[];
  slots: { id: string; revision: number; start_at: string; end_at: string; remaining: number }[];
}
export interface DeliverySelection {
  state: "held" | "unselected" | "expired" | "unavailable" | "stale";
  revision: number;
  timezone: string | null;
  selection: null | {
    id: string; option_id: string; slot_id: string;
    start_at: string; end_at: string; expires_at: string;
    fee_minor: number; currency_code: "zar";
  };
}
export interface SelectDeliveryInput {
  cart_id: string;
  location: DiscoveryLocation;
  option_id: string;
  slot_id?: string;
  expected_revision: number;
  expected_option_revision: number;
}
export interface ReleaseDeliveryInput {
  cart_id: string;
  reservation_id?: string;
  expected_revision: number;
}
