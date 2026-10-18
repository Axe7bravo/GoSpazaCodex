export type PickingStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
export interface PickingLine {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  ordered_quantity: number;
  picked_quantity: number;
  shortage_recorded: boolean;
  unresolved_quantity: number;
  /** Operational omission, never physical picking or a refund amount. */
  omitted_quantity?: number;
}
export interface PickingOrder {
  id: string;
  display_id: number;
  created_at: string;
  status: PickingStatus;
  revision: number;
  assigned_member_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  lines: PickingLine[];
}
export interface PickingList {
  orders: PickingOrder[];
  count: number;
  limit: number;
  offset: number;
}
export interface PickingResult {
  picking: PickingOrder;
  applied_revision: number;
}
export interface PickingLineInput {
  expected_revision: number;
  picked_quantity: number;
  shortage_recorded: boolean;
}
export interface PickingReassignInput {
  expected_revision: number;
  target_member_id: string;
}
export interface PickingCompleteInput { expected_revision: number; confirmed: true }
