import { createStep, createWorkflow, StepResponse, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk";
import { createCartWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { bindCart } from "../modules/marketplace/cart-context-repository";

// Internal input only: CartFoundationService resolves all authority before this
// workflow is called. Never expose this workflow's input as an HTTP schema.
interface Input {
  customerId: string; merchantId: string; storeId: string; channelId: string;
  regionId: string; variantId: string; quantity: number;
}
const publishBinding = createStep("gospaza-publish-cart-binding", async (
  data: { cartId: string; merchantId: string; storeId: string }, { container },
) => {
  const id = await bindCart(container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION), data);
  return new StepResponse(data.cartId, id);
}, async (id, { container }) => {
  if (!id) return;
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  await db("cart_marketplace_context").where({ id }).delete();
});
export const createMarketplaceCartWorkflow = createWorkflow("gospaza-create-marketplace-cart", (input: Input) => {
  const nativeInput = transform(input, (data) => ({
    customer_id: data.customerId, sales_channel_id: data.channelId, region_id: data.regionId,
    currency_code: "zar",
    items: [{ variant_id: data.variantId, quantity: data.quantity }],
  }));
  const cart = createCartWorkflow.runAsStep({ input: nativeInput });
  const published = publishBinding({ cartId: cart.id, merchantId: input.merchantId, storeId: input.storeId });
  return new WorkflowResponse(published);
});
