export interface HandoffDTO {
  delivery_id: string; revision: number;
  state: "RETURN_REQUIRED" | "RETURNING_TO_STORE" | "RETURNED_TO_STORE" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "ATTENTION_REQUIRED" | "UNAVAILABLE";
  arrived_at: string | null; delivered_at: string | null;
  compliance_required: boolean;
  restricted_content_present?: boolean;
}
export interface HandoffCodeDTO {
  state: "AVAILABLE" | "EXPIRED" | "UNAVAILABLE";
  code: string | null; expires_at: string | null; revision: number;
  can_regenerate?: boolean; regenerate_at?: string | null; compliance_required?: boolean;
}
export interface DeliveryTrackingDTO {
  state: HandoffDTO["state"];
  tracking: { latitude: number; longitude: number; recorded_at: string; expires_at?: string; stale: false } | null;
}
