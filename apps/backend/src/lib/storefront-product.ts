import type { NativeProduct } from "./catalogue-native";
import { baseZarPrice, inventoryId, publicProductImages } from "./catalogue-native";
import type { catalogueReadData } from "./catalogue-native";
import { publicStore } from "./discovery-service";
import type { CommerceReference } from "./commerce";

export function storefrontProduct(product: NativeProduct, store: CommerceReference, restricted: boolean,
  data: Awaited<ReturnType<typeof catalogueReadData>>) {
  if (product.status !== "published") return null;
  const variants = product.variants.flatMap((variant) => {
    // Incomplete/unsupported native variants cannot be presented as purchasable.
    let itemId: string, price: number;
    try { itemId = inventoryId(variant); price = baseZarPrice(variant); }
    catch { return []; }
    const level = data.levels.find((row) => row.inventory_item_id === itemId && row.location_id === store.medusa_stock_location_id);
    if (!level || !Number.isFinite(Number(level.available_quantity))) return [];
    return [{
      id: variant.id, title: variant.title, price_minor: price, currency_code: "zar" as const,
      availability: Number(level.available_quantity) >= 1 ? "in_stock" as const : "out_of_stock" as const,
    }];
  });
  if (!variants.length) return null;
  return {
    id: product.id, title: product.title, description: product.description ?? "",
    store: publicStore(store), requires_age_verification: restricted,
    images: publicProductImages(product, data.media), variants,
    currency_code: "zar" as const,
    min_price_minor: Math.min(...variants.map((variant) => variant.price_minor)),
    max_price_minor: Math.max(...variants.map((variant) => variant.price_minor)),
    availability: variants.some((variant) => variant.availability === "in_stock") ? "in_stock" as const : "out_of_stock" as const,
  };
}
