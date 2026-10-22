import type { DispatchMode, DispatchPath, DispatchStatus } from "@gospaza/contracts";
export interface DispatchConfigRow { id: string; merchant_store_id: string; mode: DispatchMode; revision: number }
export interface AvailabilityRow {
  id: string; driver_profile_id: string; intent: "OFFLINE" | "ONLINE"; revision: number;
  generation: string | null; available_since: Date | null; profile_revision: number | null;
  affiliation_id: string | null; affiliation_revision: number | null;
}
export interface DeliveryRow {
  id: string; order_operation_id: string; medusa_order_id: string; merchant_id: string; merchant_store_id: string;
  pick_session_id: string; reservation_id: string; service_zone_id: string;
  status: DispatchStatus; revision: number; generation: number; mode: DispatchMode; configuration_revision: number;
  path: DispatchPath | null; started_at: Date | null; deadline: Date | null; merchant_deadline: Date | null;
  dispatch_not_before: Date | null; offer_ms: number | null; restricted_content_present: boolean; reason: string | null;
}
export interface CommitmentRow {
  id: string; delivery_id: string; driver_profile_id: string; generation: number; path: DispatchPath;
  status: "OFFERED" | "ASSIGNED" | "DECLINED" | "EXPIRED" | "CANCELLED"; revision: number;
  availability_generation: string; affiliation_id: string; profile_revision: number; affiliation_revision: number;
  updated_at?: Date; expires_at: Date; assigned_at: Date | null; decided_at: Date | null; reason: string | null;
}
