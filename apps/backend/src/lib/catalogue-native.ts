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
  const { levels, media } = await catalogueReadData(container, [product], [locationId]);
  return { id: product.id, title: product.title, description: product.description ?? "", status: product.status,
    requires_age_verification: restricted, images: publicProductImages(product, media),
    variants: product.variants.map((variant) => {
      const id = inventoryId(variant);
      const level = levels.find((row) => row.inventory_item_id === id);
      if (!level) throw new Error("Incomplete native variant data.");
      return { id: variant.id, title: variant.title, sku: variant.sku ?? "", currency_code: "zar" as const,
        price_minor: baseZarPrice(variant), inventory_item_id: id,
        stocked_quantity: Number(level.stocked_quantity), reserved_quantity: Number(level.reserved_quantity),
        available_quantity: Number(level.available_quantity) };
    }),
  };
}

export async function catalogueReadData(container: MedusaContainer, products: NativeProduct[], locationIds: string[]) {
  const ids = [...new Set(products.flatMap((product) => product.variants.flatMap((variant) =>
    variant.inventory_items.map((item) => item.inventory_item_id))))];
  const levels = ids.length && locationIds.length
    ? await container.resolve<IInventoryService>(Modules.INVENTORY).listInventoryLevels(
      { inventory_item_id: ids, location_id: locationIds }, { take: null })
    : [];
  const productIds = products.map((product) => product.id);
  const media: { medusa_product_id: string; public_url: string; file_key: string }[] = productIds.length
    ? await container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("catalogue_media")
    .join("product_marketplace_profile", "catalogue_media.profile_id", "product_marketplace_profile.id")
    .whereIn("product_marketplace_profile.medusa_product_id", productIds)
    .where({ "catalogue_media.removal_pending": false })
    .whereNull("catalogue_media.deleted_at").whereNull("product_marketplace_profile.deleted_at")
    .select("product_marketplace_profile.medusa_product_id", "catalogue_media.public_url", "catalogue_media.file_key")
    : [];
  return { levels, media };
}
export function publicProductImages(product: NativeProduct, media: Awaited<ReturnType<typeof catalogueReadData>>["media"]) {
  const urls = new Set(media.filter((row) => row.medusa_product_id === product.id && row.file_key.startsWith(PUBLIC_PREFIX))
    .map((row) => row.public_url));
  return product.images.filter((image) => urls.has(image.url)).map(({ id, url }) => ({ id, url }));
}
export function baseZarPrice(variant: NativeVariant) {
  const prices = variant.prices.filter((price) => price.currency_code === "zar"
    && !price.price_list_id && !price.min_quantity && !price.max_quantity);
  if (prices.length !== 1) throw new Error("Incomplete native variant price.");
  return minorPrice(prices[0]!.amount);
}
