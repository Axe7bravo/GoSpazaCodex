import { createStep, StepResponse, createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk";
import { createSalesChannelsWorkflow, createStockLocationsWorkflow, linkSalesChannelsToStockLocationWorkflow } from "@medusajs/medusa/core-flows";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";

export interface CommerceInput {
  merchantId: string;
  storeId: string;
  name: string;
  address: { address_1: string; address_2: string; city: string; province: string; postal_code: string; country_code: string };
}
const recordTopology = createStep("gospaza-record-commerce-topology", async (
  input: { merchantId: string; storeId: string; channelId: string; locationId: string },
  { container },
) => {
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  await db.transaction(async (trx) => {
    const merchant = await trx("merchant").where({ id: input.merchantId }).whereNull("medusa_sales_channel_id")
      .update({ medusa_sales_channel_id: input.channelId, updated_at: new Date() });
    const store = await trx("merchant_store").where({ id: input.storeId, merchant_id: input.merchantId }).whereNull("medusa_stock_location_id")
      .update({ medusa_stock_location_id: input.locationId, updated_at: new Date() });
    if (merchant !== 1 || store !== 1) throw new Error("Commerce topology changed during provisioning.");
  });
  return new StepResponse(input);
});
export const provisionCommerceWorkflow = createWorkflow("gospaza-provision-commerce", (input: CommerceInput) => {
  const channels = createSalesChannelsWorkflow.runAsStep({
    input: { salesChannelsData: [{ name: input.name, description: input.merchantId }] },
  });
  const locations = createStockLocationsWorkflow.runAsStep({
    input: { locations: [{ name: input.name, address: input.address }] },
  });
  const topology = transform({ input, channels, locations }, ({ input, channels, locations }) => ({
    merchantId: input.merchantId, storeId: input.storeId,
    channelId: channels[0]!.id, locationId: locations[0]!.id,
  }));
  const linked = linkSalesChannelsToStockLocationWorkflow.runAsStep({
    input: { id: topology.locationId, add: [topology.channelId] },
  });
  return new WorkflowResponse(recordTopology(transform({ topology, linked }, ({ topology }) => topology)));
});
