import type { DiscoveryLocation } from "./storefront";

export interface CustomerCartItem {
  id: string;
  product_id: string;
  variant_id: string;
  product_title: string;
  variant_title: string;
  image_url: string | null;
  unit_price_minor: number;
  quantity: number;
  subtotal_minor: number;
}

export interface CustomerCart {
  id: string;
  store: { id: string; name: string };
  items: CustomerCartItem[];
  currency_code: "zar";
  subtotal_minor: number;
  item_count: number;
}

// M8-B state fields remain stable. M8-D adds only safe native presentation.
export interface CartFoundation {
  cart: CustomerCart | null;
  state: "empty" | "current" | "stale" | "superseded";
  eligibility: "pending" | "unavailable";
}

export interface AddCartItemInput {
  cart_id?: string;
  variant_id: string;
  quantity: number;
  location: DiscoveryLocation;
}

export interface UpdateCartItemInput {
  cart_id: string;
  quantity: number;
  location?: DiscoveryLocation;
}

export interface SwitchCartStoreInput {
  cart_id: string;
  variant_id: string;
  quantity: number;
  location: DiscoveryLocation;
  confirm: true;
}

export interface CartMutationResult { cart_id: string }
