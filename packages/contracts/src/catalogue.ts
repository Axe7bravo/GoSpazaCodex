export interface CatalogueVariant {
  id: string; title: string; sku: string; price_minor: number; currency_code: "zar";
  inventory_item_id: string; stocked_quantity: number; reserved_quantity: number; available_quantity: number;
}
export interface CatalogueProduct {
  id: string; title: string; description: string; status: "draft" | "published";
  requires_age_verification: boolean;
  images: { id: string; url: string }[];
  variants: CatalogueVariant[];
}
export interface CatalogueWrite {
  title: string; description: string; status: "draft" | "published"; requires_age_verification: boolean;
  variants: { id?: string; title: string; sku: string; price_minor: number; stocked_quantity: number }[];
}
export interface CatalogueList { products: CatalogueProduct[]; count: number; limit: number; offset: number }
export interface InventoryRow extends CatalogueVariant { product_id: string; product_title: string }
export interface InventoryList { items: InventoryRow[]; count: number; limit: number; offset: number }
