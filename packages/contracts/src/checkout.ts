import type { AddressWrite } from "./location";
// Server snapshots only. No payment or provider authority is accepted from UI.
export interface CheckoutQuote {
  address?: Omit<AddressWrite, "location">;
  cart_id: string;
  address_id: string;
  checkout_revision: string;
  expires_at: string;
  currency_code: "zar";
  totals: {
    total_minor: number;
    subtotal_minor: number;
    tax_total_minor: number;
    discount_total_minor: number;
    shipping_total_minor: number;
  };
}
export interface CheckoutConfirmation {
  id: string;
  state: "CONFIRMED" | "PAYMENT_PENDING" | "ABANDONED" | "EXPIRED" | "RECOVERY_REQUIRED" | "COMPLETED" | "FAILED";
  quote: CheckoutQuote;
  payment_deadline?: string;
}

export interface PaymentInitiationResult {
  attempt_id: string;
  state: "ready" | "uncertain" | "expired" | "reconciliation_required";
  payment_deadline: string | null;
  redirect_url: string | null;
}

export interface CheckoutPrepareInput {
  cart_id: string;
  address_id: string;
  expected_reservation_revision: number;
}
export interface CheckoutConfirmInput extends CheckoutPrepareInput {
  confirmed: true;
  checkout_revision: string;
}
export interface CheckoutAttemptInput {
  cart_id: string;
  attempt_id: string;
  checkout_revision: string;
  confirmed: true;
}
export interface CheckoutPreparation {
  quote: CheckoutQuote;
  attempt: CheckoutConfirmation | null;
  reconfirmation_required: boolean;
}
/** Display projection only: the backend owns all outcome and retry decisions. */
export interface CustomerCheckoutStatus {
  attempt: CheckoutConfirmation | null;
  state: "none" | "ready_to_pay" | "awaiting_payment" | "reconciliation_pending"
    | "recovery_required" | "succeeded" | "failed" | "expired" | "abandoned"
    | "refund_pending" | "refunded";
  order_id: string | null;
  delivery_window: { start_at: string; end_at: string } | null;
}