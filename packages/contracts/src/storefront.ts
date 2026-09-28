export type DiscoveryLocation = { address_id: string } | { latitude: number; longitude: number };
export interface PublicStore { id: string; name: string; availability: "available" }
export type StockAvailability = "in_stock" | "out_of_stock";
export interface PublicVariant {
  id: string; title: string; price_minor: number; currency_code: "zar"; availability: StockAvailability;
}
export interface PublicProduct {
  id: string; title: string; description: string; store: PublicStore;
  requires_age_verification: boolean; images: { id: string; url: string }[];
  variants: PublicVariant[]; currency_code: "zar"; min_price_minor: number; max_price_minor: number;
  availability: StockAvailability;
}
export interface DiscoveryResult {
  mode: "none" | "single" | "multiple"; eligible_store_count: number;
  stores: PublicStore[]; count: number; limit: number; offset: number;
}
export interface PublicCatalogue {
  store: PublicStore; products: PublicProduct[]; count: number; limit: number; offset: number;
}
export interface PublicSearch {
  eligible_store_count: number; stores: PublicStore[]; store_count: number;
  products: PublicProduct[]; count: number; limit: number; offset: number;
}
