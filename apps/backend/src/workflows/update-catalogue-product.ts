import { createStep, StepResponse, createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk";
import { updateProductsWorkflow, updateProductVariantsWorkflow, updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { CatalogueInput } from "../modules/marketplace/catalogue-policy";
import { nativePrice } from "../modules/marketplace/catalogue-policy";

interface Input {
  productId: string; profileId: string; product: CatalogueInput;
  levels: { inventory_item_id: string; location_id: string; stocked_quantity: number }[];
}
const compliance = createStep("gospaza-update-product-compliance", async (
  input: { profileId: string; restricted: boolean }, { container },
) => {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const count = await db("product_marketplace_profile").where({ id: input.profileId }).update({
    requires_age_verification: input.restricted, updated_at: new Date(),
  });
  if (count !== 1) throw new Error("Product profile disappeared.");
  return new StepResponse(input.profileId);
});
export const updateCatalogueProductWorkflow = createWorkflow("gospaza-update-catalogue-product", (input: Input) => {
  const update = transform(input, ({ productId, product }) => ({
    products: [{
      id: productId, title: product.title, description: product.description,
      status: product.status === "published" ? ProductStatus.PUBLISHED : ProductStatus.DRAFT,
    }],
  }));
  const products = updateProductsWorkflow.runAsStep({ input: update });
  const variants = updateProductVariantsWorkflow.runAsStep({ input: transform({ products, input }, ({ input }) => ({
    product_variants: input.product.variants.map((variant) => ({
      id: variant.id!, sku: variant.sku || null, manage_inventory: true, allow_backorder: false,
      prices: [{ currency_code: "zar", amount: nativePrice(variant.price_minor) }],
    })),
  })) });
  const stock = transform({ variants, input }, ({ input }) => ({ updates: input.levels }));
  const levels = updateInventoryLevelsWorkflow.runAsStep({ input: stock });
  const profile = transform({ input, levels }, ({ input }) => ({
    profileId: input.profileId, restricted: input.product.requires_age_verification,
  }));
  return new WorkflowResponse(compliance(profile));
});
