import { randomUUID } from "node:crypto";
import { createStep, StepResponse, createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk";
import { createProductsWorkflow, createInventoryLevelsWorkflow, updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { CatalogueInput } from "../modules/marketplace/catalogue-policy";
import { nativePrice } from "../modules/marketplace/catalogue-policy";
import { nativeProducts, inventoryId } from "../lib/catalogue-native";

interface Input { merchantId: string; channelId: string; locationId: string; product: CatalogueInput }
const ownProduct = createStep("gospaza-own-product", async (
  input: { merchantId: string; productId: string; restricted: boolean }, { container },
) => {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const id = "pmprof_" + randomUUID();
  await db("product_marketplace_profile").insert({
    id, merchant_id: input.merchantId, medusa_product_id: input.productId, requires_age_verification: input.restricted,
  });
  return new StepResponse(input.productId, id);
}, async (id, { container }) => {
  if (id) await container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("product_marketplace_profile").where({ id }).delete();
});
const inventoryInputs = createStep("gospaza-product-inventory-inputs", async (
  input: { productId: string; locationId: string; variants: CatalogueInput["variants"] }, { container },
) => {
  const [product] = await nativeProducts(container, [input.productId]);
  if (!product || product.variants.length !== input.variants.length) throw new Error("Native variants are incomplete.");
  return new StepResponse(product.variants.map((variant) => {
    const requested = input.variants.find((item) => item.title === variant.title);
    if (!requested) throw new Error("Native variant mismatch.");
    return { inventory_item_id: inventoryId(variant), location_id: input.locationId, stocked_quantity: requested.stocked_quantity };
  }));
});
export const createCatalogueProductWorkflow = createWorkflow("gospaza-create-catalogue-product", (input: Input) => {
  const creation = transform(input, (data) => ({
    products: [{
      title: data.product.title, description: data.product.description, status: ProductStatus.DRAFT,
      handle: "gospaza-" + randomUUID(),
      options: [{ title: "Variant", values: data.product.variants.map((variant) => variant.title) }],
      variants: data.product.variants.map((variant) => ({
        title: variant.title, sku: variant.sku || undefined, manage_inventory: true, allow_backorder: false,
        options: { Variant: variant.title }, prices: [{ currency_code: "zar", amount: nativePrice(variant.price_minor) }],
      })),
      sales_channels: [{ id: data.channelId }],
    }],
  }));
  const products = createProductsWorkflow.runAsStep({ input: creation });
  const ownership = transform({ input, products }, ({ input, products }) => ({
    merchantId: input.merchantId, productId: products[0]!.id, restricted: input.product.requires_age_verification,
  }));
  const productId = ownProduct(ownership);
  const levels = inventoryInputs({ productId, locationId: input.locationId, variants: input.product.variants });
  const createdLevels = createInventoryLevelsWorkflow.runAsStep({ input: { inventory_levels: levels } });
  const publication = transform({ input, productId, createdLevels }, ({ input, productId }) => ({
    products: [{ id: productId, status: input.product.status === "published" ? ProductStatus.PUBLISHED : ProductStatus.DRAFT }],
  }));
  updateProductsWorkflow.runAsStep({ input: publication });
  return new WorkflowResponse(productId);
});
