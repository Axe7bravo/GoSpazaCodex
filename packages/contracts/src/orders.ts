export type OrderOperationStatus = "PENDING_ACCEPTANCE" | "ACCEPTED" | "REJECTED";
export interface MerchantOrder extends MerchantOrderDecision {
  display_id: number;
  created_at: string;
  currency_code: "zar";
  customer: { first_name: string; last_name: string; city: string };
  items: { id: string; title: string; variant_title: string | null; sku: string | null;
    quantity: number; unit_price_minor: number; total_minor: number }[];
  totals: { total_minor: number; subtotal_minor: number; tax_total_minor: number;
    discount_total_minor: number; shipping_total_minor: number };
  delivery: { starts_at: string; ends_at: string; shipping_name: string };
  pickup: { store_name: string; address_line_1: string; address_line_2: string;
    city: string; province: string; postal_code: string; country_code: string };
}
export interface MerchantOrderList {
  orders: MerchantOrder[];
  count: number;
  limit: number;
  offset: number;
}

export interface MerchantOrderDecision {
  id: string;
  operational_status: OrderOperationStatus;
  revision: number;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
}

/** Customer allowlist: no staff decision reason, audit identity or commercial internals. */
export type CustomerOrder = Pick<MerchantOrder, "id" | "display_id" | "created_at" | "operational_status" | "currency_code" | "items" | "totals" | "delivery"> & {
  store: { name: string };
};
export interface OrderDecisionInput { expected_revision: number; confirmed: true }
export interface OrderRejectInput extends OrderDecisionInput { reason?: string }
export interface OrderListInput { limit?: number; offset?: number; status?: OrderOperationStatus }
