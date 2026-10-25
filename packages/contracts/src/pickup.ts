export interface DriverPickupDTO {
  delivery_id: string;
  revision: number;
  state: "PREPARING" | "PICKUP_READY" | "PICKUP_PENDING" | "IN_TRANSIT" | "ATTENTION_REQUIRED";
  picked_up_at: string | null;
  restricted_content_present: boolean;
}
