export type DispatchMode = "DISABLED" | "MERCHANT_ONLY" | "PLATFORM_ONLY" | "HYBRID";
export type DispatchPath = "MERCHANT" | "PLATFORM";
export type DispatchStatus = "PENDING_DISPATCH" | "SEARCHING" | "OFFERED" | "ASSIGNED" | "ATTENTION_REQUIRED" | "DELIVERED";
export interface DispatchConfiguration { mode: DispatchMode; revision: number }
export interface DriverAvailabilityDTO {
  intent: "OFFLINE" | "ONLINE"; revision: number; generation: string | null;
  effective: "OFFLINE" | "UNAVAILABLE" | "AVAILABLE" | "BUSY";
  location_fresh: boolean; available_since: string | null;
  location_sequence?: number;
  location_expires_at?: string | null;
}
export interface DriverCommitmentDTO {
  id: string; delivery_id: string; status: "OFFERED" | "ASSIGNED"; revision: number;
  expires_at: string; assigned_at: string | null; restricted_content_present: boolean;
  attention_required: boolean;
  pickup_store?: string;
  destination_area?: string;
}
export interface OrderDispatchDTO {
  status: "PREPARING" | "FINDING_DRIVER" | "ASSIGNED" | "ATTENTION_REQUIRED";
  /** Physical delivery phase; status above remains the M15 dispatch outcome. */
  delivery_phase?: "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "ATTENTION_REQUIRED";
  pickup_state?: "PREPARING" | "PICKUP_READY" | "PICKUP_PENDING" | "IN_TRANSIT" | "ATTENTION_REQUIRED";
  phase?: DispatchPath;
  driver?: { name: string; phone: string };
}
