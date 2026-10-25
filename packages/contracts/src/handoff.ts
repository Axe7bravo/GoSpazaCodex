export interface HandoffDTO {
  delivery_id: string; revision: number;
  state: "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "ATTENTION_REQUIRED" | "UNAVAILABLE";
  arrived_at: string | null; delivered_at: string | null;
  compliance_required: boolean;
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
