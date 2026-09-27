import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { PUBLIC_PREFIX } from "../modules/routed-file/storage";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer, IInventoryService } from "@medusajs/framework/types";
import { minorPrice } from "../modules/marketplace/catalogue-policy";
interface NativeVariant {
  id: string; title: string; sku: string | null;
  prices: { amount: string | number; currency_code: string; price_list_id: string | null; min_quantity: number | null; max_quantity: number | null }[];
  inventory_items: { inventory_item_id: string; required_quantity: number }[];
}
export interface NativeProduct {
  id: string; title: string; description: string | null; status: "draft" | "published";
  images: { id: string; url: string }[]; variants: NativeVariant[];
}
interface GraphQuery {
  graph(input: { entity: string; fields: string[]; filters: Record<string, unknown>; pagination?: { take: number } }): Promise<{ data: NativeProduct[] }>;
}
export async function nativeProducts(container: MedusaContainer, ids: string[]) {
  if (!ids.length) return [];
  return (await container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY).graph({
    entity: "product", filters: { id: ids }, pagination: { take: ids.length },
    fields: ["id", "title", "description", "status", "images.id", "images.url", "variants.id", "variants.title", "variants.sku",
      "variants.prices.amount", "variants.prices.currency_code", "variants.prices.price_list_id", "variants.prices.min_quantity", "variants.prices.max_quantity",
      "variants.inventory_items.inventory_item_id", "variants.inventory_items.required_quantity"],
  })).data;
}
export function inventoryId(variant: NativeVariant) {
  const item = variant.inventory_items[0];
  if (variant.inventory_items.length !== 1 || !item || Number(item.required_quantity) !== 1) throw new Error("Unsupported variant inventory topology.");
  return item.inventory_item_id;
}
export async function productDTO(container: MedusaContainer, product: NativeProduct, locationId: string, restricted: boolean) {
  const ids = product.variants.map(inventoryId);
  const levels = await container.resolve<IInventoryService>(Modules.INVENTORY).listInventoryLevels({ inventory_item_id: ids, location_id: locationId }, { take: Math.max(ids.length, 1) });
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const media = await db<{ public_url: string; file_key: string }>("catalogue_media")
    .join("product_marketplace_profile", "catalogue_media.profile_id", "product_marketplace_profile.id")
    .where({ "product_marketplace_profile.medusa_product_id": product.id, "catalogue_media.removal_pending": false })
    .select("catalogue_media.public_url", "catalogue_media.file_key");
  const publicUrls = new Set(media.filter((row) => row.file_key.startsWith(PUBLIC_PREFIX)).map((row) => row.public_url));
  return { id: product.id, title: product.title, description: product.description ?? "", status: product.status,
    requires_age_verification: restricted, images: product.images.filter((image) => publicUrls.has(image.url)).map(({ id, url }) => ({ id, url })),
    variants: product.variants.map((variant) => {
      const id = inventoryId(variant);
      const level = levels.find((row) => row.inventory_item_id === id);
      const prices = variant.prices.filter((price) => price.currency_code === "zar" && !price.price_list_id && !price.min_quantity && !price.max_quantity);
      if (!level || prices.length !== 1) throw new Error("Incomplete native variant data.");
      return { id: variant.id, title: variant.title, sku: variant.sku ?? "", currency_code: "zar" as const,
        price_minor: minorPrice(prices[0]!.amount), inventory_item_id: id,
        stocked_quantity: Number(level.stocked_quantity), reserved_quantity: Number(level.reserved_quantity),
        available_quantity: Number(level.available_quantity) };
    }),
  };
}
